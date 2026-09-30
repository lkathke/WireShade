'use strict';

// JS-layer tests for O1 (tunnel-lost -> reconnect), O2 (servers re-listen after
// reconnect) and O3 (inbound backpressure). These run against the mock native
// binding (test/fixtures/mock-native.js), loaded via WIRESHADE_NATIVE_PATH, so
// they do not need the real .node addon or the not-yet-shipped contract methods.

const path = require('node:path');
process.env.WIRESHADE_NATIVE_PATH = path.join(__dirname, 'fixtures', 'mock-native.js');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { WireShadeClient } = require('../index.js');
const { ServerSocket } = require('../lib/server');
const { TunnelSocket } = require('../lib/agent');

const noop = () => {};
const once = (em, ev) => new Promise((res) => em.once(ev, res));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout ${ms}ms: ${what}`)), ms); })
    ]).finally(() => clearTimeout(timer));
}

async function waitFor(fn, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (fn()) return;
        await tick(5);
    }
    throw new Error(`waitFor timeout: ${what}`);
}

function makeClient(extra = {}) {
    return new WireShadeClient({
        logging: false,
        reconnect: { enabled: true, delay: 15, maxDelay: 15, backoffMultiplier: 1, healthCheckInterval: 0 },
        handshakeTimeout: 1000,
        wireguard: {
            privateKey: 'privA', peerPublicKey: 'pubB',
            endpoint: '127.0.0.1:51820', sourceIp: '10.0.0.1'
        },
        ...extra
    });
}

// ---------------------------------------------------------------------------
// O1: a tunnel drop after handshake funnels into the normal reconnect path.
// ---------------------------------------------------------------------------
test('O1: waitForDisconnect resolving triggers "tunnel lost" disconnect + reconnect', async () => {
    const client = makeClient();
    try {
        await withTimeout(client.start(), 2000, 'start');
        const gw1 = client.gw;

        let derr;
        client.once('disconnect', (e) => { derr = e; });
        const reconnected = once(client, 'reconnect');

        gw1._testDrop(); // simulate WireGuard session loss

        await withTimeout(reconnected, 2000, 'reconnect after tunnel lost');
        assert.ok(derr instanceof Error, 'disconnect emitted an Error');
        assert.match(derr.message, /tunnel lost/);
        assert.notEqual(client.gw, gw1, 'a fresh native instance was created');
    } finally {
        await client.close();
    }
});

test('O1: a tunnel drop after close() does not resurrect the connection', async () => {
    const client = makeClient();
    await withTimeout(client.start(), 2000, 'start');
    const gw1 = client.gw;
    await client.close();

    let reconnectFired = false;
    client.on('reconnect', () => { reconnectFired = true; });
    gw1._testDrop(); // stale watcher must be a no-op
    await tick(60);
    assert.equal(reconnectFired, false);
});

// ---------------------------------------------------------------------------
// O2: tracked listeners are re-created on the new gw after a reconnect.
// ---------------------------------------------------------------------------
test('O2: a previously-registered server still accepts connections after reconnect', async () => {
    const client = makeClient();
    try {
        await withTimeout(client.start(), 2000, 'start');
        const gw1 = client.gw;

        let accepted = 0;
        await client.listen(7000, (sock) => { accepted++; sock.on('error', noop); sock.destroy(); });
        assert.ok(gw1._listeners.has(7000), 'listening on gw1');

        const reconnected = once(client, 'reconnect');
        gw1._testDrop();
        await withTimeout(reconnected, 2000, 'reconnect');

        const gw2 = client.gw;
        assert.notEqual(gw2, gw1);
        await waitFor(() => gw2._listeners.has(7000), 2000, 're-listen on gw2');

        gw2._testIncoming(7000);
        await waitFor(() => accepted === 1, 2000, 'connection accepted after reconnect');
        assert.equal(accepted, 1);
    } finally {
        await client.close();
    }
});

test('O2: a user-closed server does NOT come back after reconnect', async () => {
    const client = makeClient();
    try {
        await withTimeout(client.start(), 2000, 'start');
        const gw1 = client.gw;

        const s1 = await client.listen(7001, noop);
        await client.listen(7002, noop);

        s1.close();
        await once(s1, 'close'); // ensure the listener is untracked before the drop

        const reconnected = once(client, 'reconnect');
        gw1._testDrop();
        await withTimeout(reconnected, 2000, 'reconnect');

        const gw2 = client.gw;
        await waitFor(() => gw2._listeners.has(7002), 2000, 're-listen 7002');
        assert.ok(gw2._listeners.has(7002), '7002 restored');
        assert.ok(!gw2._listeners.has(7001), '7001 (user-closed) not restored');
    } finally {
        await client.close();
    }
});

test('O2: forwardRemote survives a reconnect (uses listen under the hood)', async () => {
    const client = makeClient();
    try {
        await withTimeout(client.start(), 2000, 'start');
        const gw1 = client.gw;
        await client.forwardRemote(7010, '127.0.0.1', 65000);
        assert.ok(gw1._listeners.has(7010));

        const reconnected = once(client, 'reconnect');
        gw1._testDrop();
        await withTimeout(reconnected, 2000, 'reconnect');

        await waitFor(() => client.gw._listeners.has(7010), 2000, 'forwardRemote re-listened');
        assert.ok(client.gw._listeners.has(7010));
    } finally {
        await client.close();
    }
});

// ---------------------------------------------------------------------------
// O3: inbound backpressure via pauseConnection/resumeConnection.
// ---------------------------------------------------------------------------
function fakeGw() {
    const paused = [];
    const resumed = [];
    return {
        paused, resumed,
        pauseConnection(id) { paused.push(id); return Promise.resolve(); },
        resumeConnection(id) { resumed.push(id); return Promise.resolve(); },
        closeConnection() { return Promise.resolve(); }
    };
}

test('O3 (server): push()=false pauses the connection, draining resumes it', async () => {
    const gw = fakeGw();
    const fakeServer = { gw, port: 7100, log: noop, _forget: noop };
    const sock = new ServerSocket(fakeServer, 42);
    sock.on('error', noop);

    // 64 KB exceeds the default 16 KB highWaterMark -> push() returns false.
    sock._onNativeData(Buffer.alloc(64 * 1024));
    assert.deepEqual(gw.paused, [42], 'pauseConnection(42) called');

    sock.resume(); // consume -> _read() fires -> resume
    await waitFor(() => gw.resumed.includes(42), 1000, 'resumeConnection(42)');
    assert.ok(gw.resumed.includes(42));
    sock.destroy();
});

test('O3 (agent): push()=false pauses the connection, draining resumes it', async () => {
    const gw = fakeGw();
    const sock = new TunnelSocket({ gw });
    sock.connId = 7; // normally set from conn.id in _attach()
    sock.on('error', noop);

    sock._onNativeData(Buffer.alloc(64 * 1024));
    assert.deepEqual(gw.paused, [7], 'pauseConnection(7) called');

    sock.resume();
    await waitFor(() => gw.resumed.includes(7), 1000, 'resumeConnection(7)');
    assert.ok(gw.resumed.includes(7));
    sock.destroy();
});

test('O3: no-op when the native pause/resume methods are absent', async () => {
    const gw = { closeConnection() { return Promise.resolve(); } }; // no pause/resume
    const fakeServer = { gw, port: 7101, log: noop, _forget: noop };
    const sock = new ServerSocket(fakeServer, 1);
    sock.on('error', noop);
    assert.doesNotThrow(() => sock._onNativeData(Buffer.alloc(64 * 1024)));
    sock.resume();
    await tick(20);
    sock.destroy();

    // agent side: no gw / no connId -> also a no-op
    const t = new TunnelSocket({});
    t.on('error', noop);
    assert.doesNotThrow(() => t._onNativeData(Buffer.alloc(64 * 1024)));
    t.destroy();
});
