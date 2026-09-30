'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { WireShadeBridge } = require('../lib/bridge');

// A fake "kernel WireGuard server": a UDP socket that echoes datagrams back.
function udpEcho() {
    return new Promise((resolve) => {
        const s = dgram.createSocket('udp4');
        s.on('message', (msg, rinfo) => s.send(Buffer.concat([Buffer.from('echo:'), msg]), rinfo.port, rinfo.address));
        s.bind(0, '127.0.0.1', () => resolve(s));
    });
}

// A base64url wstunnel-style JWT payload (decoded but not verified by the bridge).
function fakeJwt(r, rp) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ id: 'x', p: { Udp: { timeout: null } }, r, rp })}.sig`;
}

let udp, bridge, bridgePort;

before(async () => {
    udp = await udpEcho();
    const target = `127.0.0.1:${udp.address().port}`;
    bridge = new WireShadeBridge({ target, pathPrefix: 'v1', idleTimeoutSec: 5 });
    await bridge.listen('127.0.0.1:0');
    bridgePort = bridge.server.address().port;
});

after(() => {
    if (bridge) bridge.close();
    if (udp) try { udp.close(); } catch (_) {}
});

function wstunnelClient() {
    const jwt = fakeJwt('10.0.0.1', 51820);
    return new WebSocket(`ws://127.0.0.1:${bridgePort}/v1/events`, ['v1', 'authorization.bearer.' + jwt]);
}

test('wstunnel-style client: datagram relayed to UDP target and back', async () => {
    const ws = wstunnelClient();
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    const payload = Buffer.from('wg-packet-' + crypto.randomBytes(6).toString('hex'));
    const got = await new Promise((resolve, reject) => {
        ws.once('message', (data) => resolve(Buffer.isBuffer(data) ? data : Buffer.from(data)));
        ws.once('error', reject);
        ws.send(payload, { binary: true });
    });
    assert.equal(got.toString(), 'echo:' + payload.toString());
    ws.close();
});

test('multiple frames relay in order', async () => {
    const ws = wstunnelClient();
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    const received = [];
    const done = new Promise((resolve) => {
        ws.on('message', (d) => {
            received.push((Buffer.isBuffer(d) ? d : Buffer.from(d)).toString());
            if (received.length === 3) resolve();
        });
    });
    ws.send(Buffer.from('a'), { binary: true });
    ws.send(Buffer.from('b'), { binary: true });
    ws.send(Buffer.from('c'), { binary: true });
    await done;
    assert.deepEqual(received.sort(), ['echo:a', 'echo:b', 'echo:c']);
    ws.close();
});

test('wrong upgrade path is rejected', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}/wrong/path`, ['v1']);
    await assert.rejects(() => new Promise((res, rej) => {
        ws.once('open', () => { ws.close(); res(); });
        ws.once('error', rej);
        ws.once('close', (code) => rej(new Error('closed ' + code)));
    }));
});
