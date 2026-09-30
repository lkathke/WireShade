'use strict';

// End-to-end tests: two WireShade peers talking over 127.0.0.1.
// Run with `npm test` (requires a built native binding, see `npm run build`).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createPeers } = require('./fixtures/peers');
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

let peers;

before(async () => {
    peers = await createPeers();
});

after(async () => {
    if (peers) await Promise.all([peers.a.close(), peers.b.close()]);
});

test('handshake: both peers connect (started concurrently)', async () => {
    const { a, b } = peers;
    await withTimeout(Promise.all([a.start(), b.start()]), 15000, 'handshake');
    assert.equal(a.state, ConnectionState.CONNECTED);
    assert.equal(b.state, ConnectionState.CONNECTED);
});

test('ping A -> B over the tunnel', async () => {
    const rtt = await withTimeout(peers.a.ping(peers.ipB), 10000, 'ping');
    assert.equal(typeof rtt, 'number');
    assert.ok(rtt >= 0);
});

test('TCP echo of a small message', async () => {
    const { a, b, ipB } = peers;
    const server = await b.listen(7001, (socket) => {
        socket.on('error', () => { });
        socket.pipe(socket); // echo; ends when the client half-closes
    });

    try {
        const s = await withTimeout(connect(a, ipB, 7001), 10000, 'connect');
        const received = collect(s);
        s.end('hello wireshade');
        const data = await withTimeout(received, 10000, 'echo');
        assert.equal(data.toString(), 'hello wireshade');
    } finally {
        server.close();
    }
});

test('TCP upload of ~5 MB keeps integrity (sha256)', async () => {
    const { a, b, ipB } = peers;
    const payload = crypto.randomBytes(5 * 1024 * 1024 + 123);

    const server = await b.listen(7002, (socket) => {
        socket.on('error', () => { });
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        socket.on('data', (c) => { hash.update(c); bytes += c.length; });
        socket.on('end', () => socket.end(`${bytes}:${hash.digest('hex')}`));
    });

    try {
        const s = await withTimeout(connect(a, ipB, 7002), 10000, 'connect');
        const reply = collect(s);
        s.end(payload);
        const [bytes, digest] = (await withTimeout(reply, 60000, 'upload')).toString().split(':');
        assert.equal(Number(bytes), payload.length);
        assert.equal(digest, sha256(payload));
    } finally {
        server.close();
    }
});

test('TCP download of ~5 MB keeps integrity (sha256)', async () => {
    const { a, b, ipB } = peers;
    const payload = crypto.randomBytes(5 * 1024 * 1024 + 321);

    const server = await b.listen(7003, (socket) => {
        socket.on('error', () => { });
        socket.end(payload);
    });

    try {
        const s = await withTimeout(connect(a, ipB, 7003), 10000, 'connect');
        const data = await withTimeout(collect(s), 60000, 'download');
        assert.equal(data.length, payload.length);
        assert.equal(sha256(data), sha256(payload));
    } finally {
        server.close();
    }
});

test('remote close delivers EOF (end) and close to the client', async () => {
    const { a, b, ipB } = peers;
    let resolveServerClosed;
    const serverClosed = new Promise((resolve) => { resolveServerClosed = resolve; });
    const server = await b.listen(7004, (socket) => {
        socket.on('error', () => { });
        socket.on('close', resolveServerClosed);
        socket.resume(); // consume so 'end' (and then 'close') can fire
        socket.end('bye');
    });

    try {
        const s = await withTimeout(connect(a, ipB, 7004), 10000, 'connect');
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

test('listener handles 10 concurrent connections', async () => {
    const { a, b, ipB } = peers;
    let accepted = 0;
    const server = await b.listen(7005, (socket) => {
        accepted++;
        socket.on('error', () => { });
        socket.pipe(socket);
    });

    try {
        const results = await withTimeout(Promise.all(Array.from({ length: 10 }, async (_, i) => {
            const msg = `message-${i}-${crypto.randomBytes(8).toString('hex')}`;
            const s = await connect(a, ipB, 7005);
            const received = collect(s);
            s.end(msg);
            return { msg, got: (await received).toString() };
        })), 30000, '10 concurrent connections');

        for (const { msg, got } of results) assert.equal(got, msg);
        assert.equal(accepted, 10);
    } finally {
        server.close();
    }
});

test('custom tcpBufferSize still does a loopback echo', async () => {
    // A larger TCP window (4 MiB) must thread through _buildGw -> the native
    // ctor without breaking anything; a fresh pair is used so the shared peers
    // keep the default 512 KiB window.
    const custom = await createPeers({ tcpBufferSize: 4 * 1024 * 1024 });
    try {
        await withTimeout(Promise.all([custom.a.start(), custom.b.start()]), 15000, 'handshake (custom buffer)');
        assert.equal(custom.a.state, ConnectionState.CONNECTED);

        const server = await custom.b.listen(7006, (socket) => {
            socket.on('error', () => { });
            socket.pipe(socket); // echo
        });
        try {
            const s = await withTimeout(connect(custom.a, custom.ipB, 7006), 10000, 'connect (custom buffer)');
            const received = collect(s);
            s.end('hello big window');
            const data = await withTimeout(received, 10000, 'echo (custom buffer)');
            assert.equal(data.toString(), 'hello big window');
        } finally {
            server.close();
        }
    } finally {
        await Promise.all([custom.a.close(), custom.b.close()]);
    }
});

test('clean shutdown: process exits by itself after close()', async () => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'shutdown.js')], {
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
