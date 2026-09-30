'use strict';
/*
 * WireShade multi-process throughput benchmark.
 *
 * Runs the two tunnel peers as SEPARATE node processes, so each peer's
 * process.cpuUsage() measures that peer alone (the single-process bench,
 * bench/throughput.js, conflates both peers' CPU into one number). One peer
 * (sender, 10.0.0.1) pushes a fixed payload through the tunnel; the other
 * (receiver, 10.0.0.2) is the tunnel listener and counts delivered bytes.
 *
 * Reports, per peer: CPU cores busy, goodput MB/s, and efficiency per core.
 * The receiver's goodput is the end-to-end delivered rate. Packets/sec and
 * average TX/RX batch sizes come from the native engine when run with
 * WIRESHADE_STATS=1 (each child prints its own stats to stderr).
 *
 * Env vars:
 *   BENCH_SECONDS    measured window seconds (default 6)
 *   BENCH_WARMUP     warmup seconds before measuring (default 2)
 *   BENCH_CHUNK      write chunk size in bytes (default 262144)
 *   BENCH_TRANSPORT  udp | ws | wss (default udp)
 *   WIRESHADE_STATS  1 to have each native engine print per-second stats
 *
 * Usage:  node bench/throughput_mp.js
 */

const net = require('net');
const dgram = require('dgram');
const path = require('path');
const { fork } = require('child_process');
const { generateKeyPair, generateSelfSignedCert } = require('../index.js');

const SECONDS = Number(process.env.BENCH_SECONDS || 6);
const WARMUP = Number(process.env.BENCH_WARMUP || 2);
const CHUNK = Number(process.env.BENCH_CHUNK || 256 * 1024);
const TRANSPORT = (process.env.BENCH_TRANSPORT || 'udp').toLowerCase();

function freeUdpPort() {
    return new Promise((resolve, reject) => {
        const s = dgram.createSocket('udp4');
        s.on('error', reject);
        s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}
function freeTcpPort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}
function fmt(bps) {
    const mbps = bps / (1024 * 1024);
    const gbit = (bps * 8) / 1e9;
    return `${mbps.toFixed(1)} MB/s  (${gbit.toFixed(2)} Gbit/s)`;
}

async function buildConfig() {
    const keyA = generateKeyPair();
    const keyB = generateKeyPair();
    const base = {
        transport: TRANSPORT,
        chunk: CHUNK,
        seconds: SECONDS,
        keys: { a: keyA.privateKey, aPub: keyA.publicKey, b: keyB.privateKey, bPub: keyB.publicKey }
    };
    if (TRANSPORT === 'udp') {
        const portA = await freeUdpPort();
        let portB = await freeUdpPort();
        while (portB === portA) portB = await freeUdpPort();
        return { ...base, portA, portB };
    }
    if (TRANSPORT === 'ws' || TRANSPORT === 'wss') {
        const wsPort = await freeTcpPort();
        let tls;
        if (TRANSPORT === 'wss') {
            const { certPem, keyPem } = generateSelfSignedCert(['localhost', '127.0.0.1']);
            tls = { cert: certPem, key: keyPem };
        }
        return { ...base, wsPort, tls };
    }
    throw new Error(`unknown BENCH_TRANSPORT='${TRANSPORT}' (expected udp | ws | wss)`);
}

function spawnPeer(role, tag) {
    // Pipe stderr so per-peer native stats (WIRESHADE_STATS) can be tagged; the
    // two processes' stats would otherwise interleave unreadably.
    const child = fork(path.join(__dirname, 'peer-worker.js'), [], {
        stdio: ['inherit', 'inherit', 'pipe', 'ipc'],
        env: process.env
    });
    child._tag = tag;
    if (child.stderr) {
        let buf = '';
        child.stderr.on('data', (d) => {
            buf += d.toString();
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (line.length) process.stderr.write(`[${tag}] ${line}\n`);
            }
        });
    }
    return child;
}

function once(child, predicate) {
    return new Promise((resolve, reject) => {
        const onMsg = (m) => {
            if (m.t === 'error') { cleanup(); reject(new Error(`${child._tag}: ${m.message}`)); return; }
            if (predicate(m)) { cleanup(); resolve(m); }
        };
        const onExit = (c) => { cleanup(); reject(new Error(`${child._tag} exited early (${c})`)); };
        const cleanup = () => { child.off('message', onMsg); child.off('exit', onExit); };
        child.on('message', onMsg);
        child.on('exit', onExit);
    });
}

async function run() {
    console.log('WireShade multi-process throughput benchmark');
    console.log(`transport=${TRANSPORT} chunk=${(CHUNK / 1024).toFixed(0)}KiB warmup=${WARMUP}s measure=${SECONDS}s`);
    console.log('(peers run as separate processes; CPU is per-peer)\n');

    const cfg = await buildConfig();
    const receiver = spawnPeer('receiver', 'B(recv)');
    const sender = spawnPeer('sender', 'A(send)');

    // Both peers must come up concurrently: the WireGuard handshake needs both
    // ends running. start() resolves only once the handshake completes.
    receiver.send({ t: 'init', role: 'receiver', ...cfg });
    sender.send({ t: 'init', role: 'sender', ...cfg });
    await Promise.all([
        once(receiver, (m) => m.t === 'ready'),
        once(sender, (m) => m.t === 'started')
    ]);

    sender.send({ t: 'connect' });
    await once(sender, (m) => m.t === 'connected');

    // Warm up, then trigger the measured window in both peers.
    await new Promise((r) => setTimeout(r, WARMUP * 1000));
    receiver.send({ t: 'measure' });
    sender.send({ t: 'measure' });

    const [recvRes, sendRes] = await Promise.all([
        once(receiver, (m) => m.t === 'result'),
        once(sender, (m) => m.t === 'result')
    ]);

    const goodput = recvRes.rxBytes / recvRes.elapsed;   // end-to-end delivered
    const txRate = sendRes.txBytes / sendRes.elapsed;     // offered by sender

    console.log('=== Receiver (B, 10.0.0.2) — RX / decapsulate path ===');
    console.log(`  goodput (delivered): ${fmt(goodput)}`);
    console.log(`  CPU busy (cores):    ${recvRes.cpuCores.toFixed(2)}`);
    console.log(`  efficiency per core: ${fmt(recvRes.cpuCores > 0 ? goodput / recvRes.cpuCores : 0)}`);
    console.log('=== Sender (A, 10.0.0.1) — TX / encapsulate path ===');
    console.log(`  offered:             ${fmt(txRate)}`);
    console.log(`  CPU busy (cores):    ${sendRes.cpuCores.toFixed(2)}`);
    console.log(`  efficiency per core: ${fmt(sendRes.cpuCores > 0 ? goodput / sendRes.cpuCores : 0)}`);
    console.log(`\n  window: ${recvRes.elapsed.toFixed(2)}s   delivered: ${(recvRes.rxBytes / (1024 * 1024)).toFixed(0)} MiB`);

    receiver.send({ t: 'shutdown' });
    sender.send({ t: 'shutdown' });
    setTimeout(() => {
        try { receiver.kill(); } catch { /* ignore */ }
        try { sender.kill(); } catch { /* ignore */ }
        process.exit(0);
    }, 400);
}

run().catch((err) => {
    console.error('benchmark failed:', err);
    process.exit(1);
});
