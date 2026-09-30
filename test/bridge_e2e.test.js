'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const { WireShadeClient, WireShadeBridge, generateKeyPair } = require('../index.js');

// End-to-end: a WireShade WS client in *wstunnel* mode connects to
// `wireshade bridge`, which relays its WireGuard packets to a UDP target.
// We assert the target receives the client's WireGuard handshake — proving the
// wstunnel upgrade (/v1/events + Sec-WebSocket-Protocol JWT), the binary
// framing, and the bridge relay all work together. (Completing the WG
// handshake itself needs a roaming responder, i.e. a real kernel WG server.)
test('WS client (wstunnel mode) reaches a UDP target through the bridge', async () => {
    if (typeof require('../lib/binding').getBinding().WireShade.wsClient !== 'function') {
        return; // native binding without WS support
    }

    const received = [];
    const udp = dgram.createSocket('udp4');
    await new Promise((resolve) => {
        udp.on('message', (m) => received.push(m));
        udp.bind(0, '127.0.0.1', resolve);
    });
    const targetPort = udp.address().port;

    const bridge = new WireShadeBridge({ target: `127.0.0.1:${targetPort}`, pathPrefix: 'v1' });
    await bridge.listen('127.0.0.1:0');
    const wsPort = bridge.server.address().port;

    const keyC = generateKeyPair();
    const keyS = generateKeyPair();
    const client = new WireShadeClient({
        logging: false,
        reconnect: { enabled: false },
        handshakeTimeout: 2500,
        wireguard: {
            privateKey: keyC.privateKey,
            peerPublicKey: keyS.publicKey,
            sourceIp: '10.5.0.2',
            endpoint: '10.5.0.1:51820'   // r/rp for the wstunnel JWT
        },
        transport: {
            type: 'websocket',
            mode: 'wstunnel',
            url: `ws://127.0.0.1:${wsPort}`,
            pathPrefix: 'v1'
        }
    });

    // No real WG responder behind the bridge, so the handshake times out — but by
    // then the WG init must have been relayed to the UDP target.
    await client.start().catch(() => {});

    try {
        assert.ok(received.length >= 1,
            'bridge should have relayed WireGuard packets from the wstunnel-mode WS client to the UDP target');
    } finally {
        await client.close().catch(() => {});
        bridge.close();
        try { udp.close(); } catch (_) {}
    }
});
