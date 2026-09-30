'use strict';

const dgram = require('dgram');
const net = require('net');
const { WireShadeClient, WireShadeWsServer, generateKeyPair } = require('../../index.js');

/** Finds a free UDP port on 127.0.0.1 (bind to 0, read, release). */
function freeUdpPort() {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        sock.once('error', reject);
        sock.bind(0, '127.0.0.1', () => {
            const { port } = sock.address();
            sock.close(() => resolve(port));
        });
    });
}

/** Finds a free TCP port on 127.0.0.1 (bind to 0, read, release). */
function freeTcpPort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/**
 * Creates two WireShade peers that talk over a plaintext WebSocket (ws://) on
 * 127.0.0.1, using the high-level transport config.
 *   B = 10.77.0.2 (WS server, terminates the tunnel; also the tunnel-level listener)
 *   A = 10.77.0.1 (WS client; connects to B through the tunnel)
 */
async function createWsPeers(extra = {}) {
    const keyA = generateKeyPair();
    const keyB = generateKeyPair();
    const port = await freeTcpPort();
    const host = '127.0.0.1';

    const common = {
        logging: false,
        reconnect: { enabled: false },
        handshakeTimeout: 10000,
        ...extra
    };

    const b = new WireShadeWsServer({
        ...common,
        listen: `${host}:${port}`,
        wireguard: {
            privateKey: keyB.privateKey,
            peerPublicKey: keyA.publicKey,
            sourceIp: '10.77.0.2'
        }
    });

    const a = new WireShadeClient({
        ...common,
        wireguard: {
            privateKey: keyA.privateKey,
            peerPublicKey: keyB.publicKey,
            sourceIp: '10.77.0.1'
        },
        transport: {
            type: 'websocket',
            role: 'client',
            url: `ws://${host}:${port}`
        }
    });

    return { a, b, ipA: '10.77.0.1', ipB: '10.77.0.2', port };
}

/**
 * Creates two WireShade peers that talk to each other over 127.0.0.1.
 * A = 10.77.0.1, B = 10.77.0.2
 */
async function createPeers(extra = {}) {
    const keyA = generateKeyPair();
    const keyB = generateKeyPair();
    const portA = await freeUdpPort();
    let portB = await freeUdpPort();
    while (portB === portA) portB = await freeUdpPort();

    const common = {
        logging: false,
        reconnect: { enabled: false },
        handshakeTimeout: 10000,
        ...extra
    };

    const a = new WireShadeClient({
        ...common,
        wireguard: {
            privateKey: keyA.privateKey,
            peerPublicKey: keyB.publicKey,
            endpoint: `127.0.0.1:${portB}`,
            sourceIp: '10.77.0.1',
            listenPort: portA
        }
    });
    const b = new WireShadeClient({
        ...common,
        wireguard: {
            privateKey: keyB.privateKey,
            peerPublicKey: keyA.publicKey,
            endpoint: `127.0.0.1:${portA}`,
            sourceIp: '10.77.0.2',
            listenPort: portB
        }
    });

    return { a, b, ipA: '10.77.0.1', ipB: '10.77.0.2' };
}

module.exports = { createPeers, createWsPeers, freeUdpPort, freeTcpPort };
