'use strict';

// End-to-end tests over the WebSocket transport (plaintext ws://): two
// WireShade peers on 127.0.0.1, the WireGuard tunnel carried over a single WS
// connection. Mirrors the core cases of loopback.test.js but exercises the
// high-level transport config (WireShadeClient transport:{...} + WireShadeWsServer).
//
// Run with `npm test` (requires a built native binding with the WS transport).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createWsPeers } = require('./fixtures/peers');
const { ConnectionState } = require('../index.js');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Resolves with all data a readable emits until 'end'; rejects on 'error'. */
function collect(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.once('end', () => resolve(Buffer.concat(chunks)));
        stream.once('error', reject);
    });
}

/** Opens a tunnel connection from A and waits for 'connect'. */
function connect(client, host, port) {
    return new Promise((resolve, reject) => {
        const s = client.connect({ host, port });
        s.once('connect', () => {
            s.removeListener('error', reject);
            resolve(s);
        });
        s.once('error', reject);
    });
}

function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${what}`)), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

const once = (em, ev) => new Promise((res) => em.once(ev, res));

let peers;

before(async () => {
    peers = await createWsPeers();
});

after(async () => {
    if (peers) await Promise.all([peers.a.close(), peers.b.close()]);
});

test('ws handshake: both peers connect over ws://', async () => {
    const { a, b } = peers;
    // Server (WsServer) start() resolves on bind; also await its 'connect' so
    // both sides have completed the WireGuard handshake.
    const bConnected = once(b, 'connect');
    await withTimeout(Promise.all([b.start(), a.start()]), 15000, 'ws handshake');
    await withTimeout(bConnected, 15000, 'server handshake');
    assert.equal(a.state, ConnectionState.CONNECTED);
    assert.equal(b.state, ConnectionState.CONNECTED);
});

test('ws ping A -> B over the tunnel', async () => {
    const rtt = await withTimeout(peers.a.ping(peers.ipB), 10000, 'ping');
    assert.equal(typeof rtt, 'number');
    assert.ok(rtt >= 0);
});

test('ws TCP echo of a small message', async () => {
    const { a, b, ipB } = peers;
    const server = await b.listen(7101, (socket) => {
        socket.on('error', () => { });
        socket.pipe(socket); // echo; ends when the client half-closes
    });

    try {
        const s = await withTimeout(connect(a, ipB, 7101), 10000, 'connect');
        const received = collect(s);
        s.end('hello wireshade over ws');
        const data = await withTimeout(received, 10000, 'echo');
        assert.equal(data.toString(), 'hello wireshade over ws');
    } finally {
        server.close();
    }
});

test('ws TCP upload of ~5 MB keeps integrity (sha256)', async () => {
    const { a, b, ipB } = peers;
    const payload = crypto.randomBytes(5 * 1024 * 1024 + 123);

    const server = await b.listen(7102, (socket) => {
        socket.on('error', () => { });
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        socket.on('data', (c) => { hash.update(c); bytes += c.length; });
        socket.on('end', () => socket.end(`${bytes}:${hash.digest('hex')}`));
    });

    try {
        const s = await withTimeout(connect(a, ipB, 7102), 10000, 'connect');
        const reply = collect(s);
        s.end(payload);
        const [bytes, digest] = (await withTimeout(reply, 60000, 'upload')).toString().split(':');
        assert.equal(Number(bytes), payload.length);
        assert.equal(digest, sha256(payload));
    } finally {
        server.close();
    }
});

test('ws remote close delivers EOF (end) and close to the client', async () => {
    const { a, b, ipB } = peers;
    let resolveServerClosed;
    const serverClosed = new Promise((resolve) => { resolveServerClosed = resolve; });
    const server = await b.listen(7104, (socket) => {
        socket.on('error', () => { });
        socket.on('close', resolveServerClosed);
        socket.resume(); // consume so 'end' (and then 'close') can fire
        socket.end('bye');
    });

    try {
        const s = await withTimeout(connect(a, ipB, 7104), 10000, 'connect');
        const closed = new Promise((resolve) => s.once('close', resolve));
        const data = await withTimeout(collect(s), 10000, 'EOF');
        assert.equal(data.toString(), 'bye');
        await withTimeout(closed, 10000, 'client close event');
        assert.equal(s.destroyed, true);
        await withTimeout(serverClosed, 10000, 'server close event');
    } finally {
        server.close();
    }
});

test('ws clean shutdown: process exits by itself after close()', async () => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'ws-shutdown.js')], {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });

    const code = await new Promise((resolve) => {
        const timer = setTimeout(() => {
            child.kill();
            resolve('timeout');
        }, 30000);
        child.on('exit', (c) => {
            clearTimeout(timer);
            resolve(c);
        });
    });

    assert.notEqual(code, 'timeout', `child did not exit by itself (leaked handles?)\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.equal(code, 0, `child failed\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.match(stdout, /CLOSED/);
});
