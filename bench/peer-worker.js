'use strict';
/*
 * Bench peer worker (child process of bench/throughput_mp.js).
 *
 * Runs exactly ONE WireShade peer so its process.cpuUsage() reflects that peer
 * alone (the single-process bench conflates both). Role is passed on init:
 *   role=receiver  tunnel listener on 10.0.0.2:9000, counts delivered bytes (RX goodput)
 *   role=sender    connects to 10.0.0.2:9000 and pumps a fixed payload as fast
 *                  as backpressure allows (TX)
 *
 * Coordination is via IPC messages with the parent:
 *   parent -> receiver : {t:'init', ...}
 *   receiver -> parent : {t:'ready'}              (server bound + listening)
 *   parent -> sender   : {t:'init', ...} then {t:'connect'}
 *   sender -> parent   : {t:'connected'}
 *   parent -> both     : {t:'measure'}            (baseline cpu/bytes, self-timed)
 *   both  -> parent    : {t:'result', ...}
 */

const crypto = require('crypto');
const {
    WireShadeClient, WireShadeWsServer, generateSelfSignedCert
} = require('../index.js');

const IP_A = '10.0.0.1'; // sender
const IP_B = '10.0.0.2'; // receiver
const TUNNEL_PORT = 9000;

let cfg = null;
let peer = null;
let socket = null;
let received = 0;
let sentDuringMeasure = 0;
let running = false;
let measuring = false;

function send(msg) { if (process.send) process.send(msg); }

function buildPeer() {
    const { transport, role, keys } = cfg;
    const isSender = role === 'sender';
    const selfKey = isSender ? keys.a : keys.b;
    const peerPub = isSender ? keys.bPub : keys.aPub;
    const sourceIp = isSender ? IP_A : IP_B;

    if (transport === 'udp') {
        return new WireShadeClient({
            logging: false,
            reconnect: { enabled: false },
            wireguard: {
                privateKey: selfKey,
                peerPublicKey: peerPub,
                endpoint: `127.0.0.1:${isSender ? cfg.portB : cfg.portA}`,
                sourceIp,
                listenPort: isSender ? cfg.portA : cfg.portB
            }
        });
    }

    // ws / wss
    let serverTls, clientTls;
    let url = `ws://127.0.0.1:${cfg.wsPort}`;
    if (transport === 'wss') {
        serverTls = { cert: cfg.tls.cert, key: cfg.tls.key };
        clientTls = { ca: cfg.tls.cert };
        url = `wss://localhost:${cfg.wsPort}`;
    }
    if (!isSender) {
        return new WireShadeWsServer({
            logging: false,
            reconnect: { enabled: false },
            listen: `127.0.0.1:${cfg.wsPort}`,
            tls: serverTls,
            wireguard: { privateKey: selfKey, peerPublicKey: peerPub, sourceIp }
        });
    }
    return new WireShadeClient({
        logging: false,
        reconnect: { enabled: false },
        wireguard: { privateKey: selfKey, peerPublicKey: peerPub, sourceIp },
        transport: { type: 'websocket', role: 'client', url, tls: clientTls }
    });
}

async function initReceiver() {
    peer = buildPeer();
    await peer.start();
    await peer.listen(TUNNEL_PORT, (s) => {
        s.on('data', (buf) => { received += buf.length; });
        s.on('error', () => {});
    });
    send({ t: 'ready' });
}

async function initSender() {
    peer = buildPeer();
    await peer.start();
    send({ t: 'started' });
}

async function doConnect() {
    socket = await new Promise((resolve, reject) => {
        const s = peer.connect({ host: IP_B, port: TUNNEL_PORT });
        s.on('connect', () => resolve(s));
        s.on('error', reject);
    });

    const payload = crypto.randomBytes(cfg.chunk);
    running = true;
    const pump = () => {
        while (running) {
            const ok = socket.write(payload);
            if (measuring) sentDuringMeasure += payload.length;
            if (!ok) { socket.once('drain', pump); return; }
        }
    };
    pump();
    send({ t: 'connected' });
}

let cpu0, t0;
function startMeasure() {
    received = 0;
    sentDuringMeasure = 0;
    measuring = true;
    cpu0 = process.cpuUsage();
    t0 = process.hrtime.bigint();
    setTimeout(finishMeasure, cfg.seconds * 1000);
}

function finishMeasure() {
    const t1 = process.hrtime.bigint();
    const cpu = process.cpuUsage(cpu0);
    measuring = false;
    running = false;
    const elapsed = Number(t1 - t0) / 1e9;
    const cpuSec = (cpu.user + cpu.system) / 1e6;
    send({
        t: 'result',
        role: cfg.role,
        elapsed,
        cpuCores: cpuSec / elapsed,
        rxBytes: received,
        txBytes: sentDuringMeasure
    });
}

process.on('message', async (msg) => {
    try {
        if (msg.t === 'init') {
            cfg = msg;
            if (cfg.role === 'receiver') await initReceiver();
            else await initSender();
        } else if (msg.t === 'connect') {
            await doConnect();
        } else if (msg.t === 'measure') {
            startMeasure();
        } else if (msg.t === 'shutdown') {
            try { await Promise.resolve(peer && peer.close()); } catch { /* ignore */ }
            setTimeout(() => process.exit(0), 100);
        }
    } catch (err) {
        send({ t: 'error', role: cfg && cfg.role, message: err && err.message });
        setTimeout(() => process.exit(1), 50);
    }
});
