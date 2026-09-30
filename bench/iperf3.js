'use strict';
/*
 * WireShade iperf3 harness — drives a REAL iperf3 client/server pair through a
 * WireShade tunnel on a single box, so you get an industry-standard throughput
 * number for the full path (iperf3 TCP -> forwardLocal -> WireGuard tunnel ->
 * forwardRemote -> iperf3 -s).
 *
 * Topology (loopback):
 *
 *   iperf3 -c 127.0.0.1:<localPort>
 *        |  (real TCP)
 *        v
 *   [A] forwardLocal(localPort -> tunnel 10.0.0.2:<tunnelPort>)   WireShade client
 *        |  WireGuard over <transport>
 *        v
 *   [B] listen(tunnelPort) -> forwardRemote -> 127.0.0.1:<iperfPort>   WireShade server
 *        |  (real TCP)
 *        v
 *   iperf3 -s -B 127.0.0.1 -p <iperfPort>
 *
 * iperf3 must be in PATH. If it is not, the harness prints a clear skip message
 * and exits 0 (so it is CI-safe).
 *
 * Env vars:
 *   BENCH_TRANSPORT  udp | ws | wss   (default udp)
 *   IPERF_SECONDS    test duration seconds (default 5)
 *   IPERF_REVERSE    "1" to run iperf3 in reverse mode (-R, server -> client)
 *
 * Usage:  node bench/iperf3.js
 */

const net = require('net');
const { spawn, spawnSync } = require('child_process');
const {
    WireShadeClient, WireShadeWsServer, generateKeyPair, generateSelfSignedCert
} = require('../index.js');

const TRANSPORT = (process.env.BENCH_TRANSPORT || 'udp').toLowerCase();
const SECONDS = Number(process.env.IPERF_SECONDS || 5);
const REVERSE = process.env.IPERF_REVERSE === '1';
const IPERF = process.env.IPERF3_BIN || 'iperf3';

const IP_A = '10.0.0.1'; // client side (forwardLocal)
const IP_B = '10.0.0.2'; // server side (forwardRemote); A connects to this

function haveIperf3() {
    try {
        const r = spawnSync(IPERF, ['--version'], { encoding: 'utf8' });
        if (r.error) return false;
        return r.status === 0 || /iperf 3/i.test(`${r.stdout || ''}${r.stderr || ''}`);
    } catch {
        return false;
    }
}

function freeUdpPort() {
    return new Promise((resolve, reject) => {
        const s = require('dgram').createSocket('udp4');
        s.on('error', reject);
        s.bind(0, '127.0.0.1', () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
    });
}

function freeTcpPort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
    });
}

/** Build the two tunnel peers for the selected transport. B listens, A connects. */
async function makeTunnel() {
    const keyA = generateKeyPair();
    const keyB = generateKeyPair();

    if (TRANSPORT === 'udp') {
        const [portA, portB] = [await freeUdpPort(), await freeUdpPort()];
        const mk = (self, peerPub, ip, listenPort, endpointPort) => new WireShadeClient({
            logging: false,
            reconnect: { enabled: false },
            wireguard: {
                privateKey: self.privateKey,
                peerPublicKey: peerPub,
                endpoint: `127.0.0.1:${endpointPort}`,
                sourceIp: ip,
                listenPort
            }
        });
        const a = mk(keyA, keyB.publicKey, IP_A, portA, portB);
        const b = mk(keyB, keyA.publicKey, IP_B, portB, portA);
        await Promise.all([a.start(), b.start()]);
        return { a, b };
    }

    if (TRANSPORT === 'ws' || TRANSPORT === 'wss') {
        const host = '127.0.0.1';
        const port = await freeTcpPort();
        let serverTls, clientTls;
        let url = `ws://${host}:${port}`;
        if (TRANSPORT === 'wss') {
            const { certPem, keyPem } = generateSelfSignedCert(['localhost', '127.0.0.1']);
            serverTls = { cert: certPem, key: keyPem };
            clientTls = { ca: certPem };
            url = `wss://localhost:${port}`;
        }
        const b = new WireShadeWsServer({
            logging: false,
            reconnect: { enabled: false },
            listen: `${host}:${port}`,
            tls: serverTls,
            wireguard: { privateKey: keyB.privateKey, peerPublicKey: keyA.publicKey, sourceIp: IP_B }
        });
        const a = new WireShadeClient({
            logging: false,
            reconnect: { enabled: false },
            wireguard: { privateKey: keyA.privateKey, peerPublicKey: keyB.publicKey, sourceIp: IP_A },
            transport: { type: 'websocket', role: 'client', url, tls: clientTls }
        });
        await b.start();
        await a.start();
        return { a, b };
    }

    throw new Error(`unknown BENCH_TRANSPORT='${TRANSPORT}' (expected udp | ws | wss)`);
}

function runIperfServer(iperfPort) {
    // -1 = one-off: the server exits after a single client test (auto-cleanup).
    const args = ['-s', '-B', '127.0.0.1', '-p', String(iperfPort), '-1'];
    const proc = spawn(IPERF, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', (c) => process.stderr.write(`[iperf3 -s] ${c}`));
    return proc;
}

function runIperfClient(localPort) {
    const args = ['-c', '127.0.0.1', '-p', String(localPort), '-t', String(SECONDS)];
    if (REVERSE) args.push('-R');
    return new Promise((resolve, reject) => {
        const proc = spawn(IPERF, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
        proc.stderr.on('data', (c) => process.stderr.write(`[iperf3 -c] ${c}`));
        proc.on('error', reject);
        proc.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`iperf3 client exited ${code}`))));
    });
}

async function main() {
    if (!haveIperf3()) {
        console.log('iperf3 not found in PATH — skipping iperf3 harness.');
        console.log('Install iperf3 (https://iperf.fr/) and re-run:  node bench/iperf3.js');
        process.exit(0);
    }

    console.log(`WireShade iperf3 harness  transport=${TRANSPORT}  duration=${SECONDS}s${REVERSE ? '  reverse' : ''}`);

    const iperfPort = await freeTcpPort(); // real iperf3 -s
    const localPort = await freeTcpPort();  // forwardLocal entry point
    const tunnelPort = 5201;                // inside the tunnel (arbitrary)

    const { a, b } = await makeTunnel();

    // Server side: bridge the tunnel port to the local iperf3 -s.
    await b.forwardRemote(tunnelPort, '127.0.0.1', iperfPort);
    // Client side: expose a local TCP port that tunnels to B.
    await a.forwardLocal(localPort, IP_B, tunnelPort);

    const server = runIperfServer(iperfPort);
    // Give the server a moment to bind.
    await new Promise((r) => setTimeout(r, 400));

    let failed = false;
    try {
        console.log(`\nrunning: ${IPERF} -c 127.0.0.1 -p ${localPort} -t ${SECONDS}${REVERSE ? ' -R' : ''}  (through the tunnel)\n`);
        await runIperfClient(localPort);
    } catch (err) {
        failed = true;
        console.error('iperf3 run failed:', err.message);
    } finally {
        try { server.kill(); } catch { /* ignore */ }
        await Promise.resolve(a.close());
        await Promise.resolve(b.close());
    }

    setTimeout(() => process.exit(failed ? 1 : 0), 200);
}

main().catch((err) => {
    console.error('iperf3 harness failed:', err);
    process.exit(1);
});
