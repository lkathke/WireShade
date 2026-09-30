'use strict';
/*
 * WireShade throughput benchmark (loopback, single box).
 *
 * Measures the raw tunnel goodput and CPU cost of the full path
 * (WireGuard crypto + smoltcp + napi boundary), NOT network RTT/loss
 * effects. Loopback is the right tool for the crypto/CPU-throughput
 * question; latency/packet-loss effects (where TCP-over-TCP matters for
 * the WebSocket transport) need `tc netem` or two real hosts.
 *
 * Env vars:
 *   BENCH_SECONDS   duration of each measured phase (default 5)
 *   BENCH_WARMUP    warmup seconds before measuring (default 2)
 *   BENCH_CHUNK     write chunk size in bytes (default 262144)
 *   BENCH_TRANSPORT udp | ws | wss  (default udp; ws/wss added with the WS transport)
 *
 * Usage:  node bench/throughput.js
 */

const crypto = require('crypto');
const { WireShadeClient, WireShadeWsServer, generateKeyPair, generateSelfSignedCert } = require('../index.js');

const SECONDS = Number(process.env.BENCH_SECONDS || 5);
const WARMUP = Number(process.env.BENCH_WARMUP || 2);
const CHUNK = Number(process.env.BENCH_CHUNK || 256 * 1024);
const TRANSPORT = (process.env.BENCH_TRANSPORT || 'udp').toLowerCase();

function freeUdpPort() {
    return new Promise((resolve, reject) => {
        const s = require('dgram').createSocket('udp4');
        s.bind(0, '127.0.0.1', () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
        s.on('error', reject);
    });
}

function freeTcpPort() {
    return new Promise((resolve, reject) => {
        const s = require('net').createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
    });
}

function fmt(bytesPerSec) {
    const mbps = bytesPerSec / (1024 * 1024);
    const gbit = (bytesPerSec * 8) / 1e9;
    return `${mbps.toFixed(1)} MB/s  (${gbit.toFixed(2)} Gbit/s)`;
}

async function makePeers() {
    const keyA = generateKeyPair();
    const keyB = generateKeyPair();

    // Peer B is always the tunnel-level listener (sourceIp 10.0.0.2); peer A
    // connects to it. run() calls b.listen(9000) and a.connect({host: 10.0.0.2}).
    if (TRANSPORT === 'udp') {
        const [portA, portB] = [await freeUdpPort(), await freeUdpPort()];
        const mk = (self, peerPub, ip, listenPort, endpointPort) => new WireShadeClient({
            logging: false,
            wireguard: {
                privateKey: self.privateKey,
                peerPublicKey: peerPub,
                endpoint: `127.0.0.1:${endpointPort}`,
                sourceIp: ip,
                listenPort
            }
        });

        const a = mk(keyA, keyB.publicKey, '10.0.0.1', portA, portB);
        const b = mk(keyB, keyA.publicKey, '10.0.0.2', portB, portA);
        await Promise.all([a.start(), b.start()]);
        return { a, b, ipB: '10.0.0.2' };
    }

    if (TRANSPORT === 'ws' || TRANSPORT === 'wss') {
        const host = '127.0.0.1';
        const port = await freeTcpPort();

        let serverTls; // { cert, key } => wss
        let clientTls; // { ca } => pin self-signed cert
        let url = `ws://${host}:${port}`;
        if (TRANSPORT === 'wss') {
            const { certPem, keyPem } = generateSelfSignedCert(['localhost', '127.0.0.1']);
            serverTls = { cert: certPem, key: keyPem };
            clientTls = { ca: certPem };
            // Connect by name so SNI + verification match a DNS SAN.
            url = `wss://localhost:${port}`;
        }

        // Peer B: WS server, terminates the tunnel (sourceIp 10.0.0.2).
        const b = new WireShadeWsServer({
            logging: false,
            reconnect: { enabled: false },
            listen: `${host}:${port}`,
            tls: serverTls,
            wireguard: {
                privateKey: keyB.privateKey,
                peerPublicKey: keyA.publicKey,
                sourceIp: '10.0.0.2'
            }
        });

        // Peer A: WS client (sourceIp 10.0.0.1), pins the self-signed cert for wss.
        const a = new WireShadeClient({
            logging: false,
            reconnect: { enabled: false },
            wireguard: {
                privateKey: keyA.privateKey,
                peerPublicKey: keyB.publicKey,
                sourceIp: '10.0.0.1'
            },
            transport: {
                type: 'websocket',
                role: 'client',
                url,
                tls: clientTls
            }
        });

        await b.start();          // resolves once the WS server is bound
        await a.start();          // resolves on the WireGuard handshake over WS
        return { a, b, ipB: '10.0.0.2' };
    }

    throw new Error(`unknown BENCH_TRANSPORT='${TRANSPORT}' (expected udp | ws | wss)`);
}

async function run() {
    console.log(`WireShade throughput benchmark`);
    console.log(`transport=${TRANSPORT} chunk=${(CHUNK / 1024).toFixed(0)}KiB warmup=${WARMUP}s measure=${SECONDS}s\n`);

    const { a, b, ipB } = await makePeers();

    // Server on B counts received bytes.
    let received = 0;
    await b.listen(9000, (socket) => {
        socket.on('data', (buf) => { received += buf.length; });
        socket.on('error', () => {});
    });

    // Latency sample (ICMP through the tunnel).
    let pingMs = null;
    try { pingMs = await a.ping(ipB); } catch { /* ignore */ }

    // Client on A pushes as fast as backpressure allows.
    const socket = await new Promise((resolve, reject) => {
        const s = a.connect({ host: ipB, port: 9000 });
        s.on('connect', () => resolve(s));
        s.on('error', reject);
    });

    const payload = crypto.randomBytes(CHUNK);
    let running = true;
    let measuring = false;
    let sentDuringMeasure = 0;

    const pump = () => {
        while (running) {
            if (measuring) sentDuringMeasure += payload.length;
            const ok = socket.write(payload);
            if (!ok) { socket.once('drain', pump); return; }
        }
    };

    pump();
    await new Promise(r => setTimeout(r, WARMUP * 1000));

    // Measured window.
    received = 0;
    sentDuringMeasure = 0;
    measuring = true;
    const cpu0 = process.cpuUsage();
    const t0 = process.hrtime.bigint();

    await new Promise(r => setTimeout(r, SECONDS * 1000));

    const t1 = process.hrtime.bigint();
    const cpu = process.cpuUsage(cpu0);
    running = false;
    measuring = false;

    const elapsed = Number(t1 - t0) / 1e9;
    const rxRate = received / elapsed;              // bytes/s actually delivered end-to-end
    const cpuSec = (cpu.user + cpu.system) / 1e6;   // total CPU seconds (both peers, one process)
    const cpuCores = cpuSec / elapsed;              // avg cores busy
    const perCore = cpuCores > 0 ? rxRate / cpuCores : 0;

    console.log(`goodput (delivered):  ${fmt(rxRate)}`);
    console.log(`CPU busy (avg cores): ${cpuCores.toFixed(2)}  over ${elapsed.toFixed(2)}s`);
    console.log(`efficiency per core:  ${fmt(perCore)}`);
    if (pingMs != null) console.log(`tunnel ping:          ${pingMs} ms`);
    console.log(`bytes delivered:      ${(received / (1024 * 1024)).toFixed(0)} MiB`);

    await Promise.resolve(a.close());
    await Promise.resolve(b.close());
    // Give the native tasks a tick to unwind, then exit cleanly.
    setTimeout(() => process.exit(0), 200);
}

run().catch((err) => {
    console.error('benchmark failed:', err);
    process.exit(1);
});
