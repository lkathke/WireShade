'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');
const { createPeers } = require('./fixtures/peers');

// --- minimal SOCKS5 client helper ------------------------------------------
function readN(sock, n) {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const onData = (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length >= n) {
                sock.removeListener('data', onData);
                sock.removeListener('error', onErr);
                // push back any surplus
                if (buf.length > n) sock.unshift(buf.subarray(n));
                resolve(buf.subarray(0, n));
            }
        };
        const onErr = (e) => { sock.removeListener('data', onData); reject(e); };
        sock.on('data', onData);
        sock.once('error', onErr);
    });
}

/** Perform a SOCKS5 CONNECT to an IPv4 dest; resolves the socket ready for I/O. */
async function socksConnect(port, host, destIp, destPort, auth) {
    const sock = net.connect(port, host);
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });

    // greeting
    const methods = auth ? [0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));
    const sel = await readN(sock, 2);
    assert.equal(sel[0], 0x05);

    if (auth) {
        assert.equal(sel[1], 0x02, 'server must select user/pass');
        const u = Buffer.from(auth.username);
        const p = Buffer.from(auth.password);
        sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        const ares = await readN(sock, 2);
        if (ares[1] !== 0x00) { sock.destroy(); const e = new Error('auth rejected'); e.authRejected = true; throw e; }
    } else {
        assert.equal(sel[1], 0x00, 'server must select no-auth');
    }

    // CONNECT, IPv4
    const ip = destIp.split('.').map(Number);
    const req = Buffer.from([0x05, 0x01, 0x00, 0x01, ...ip, (destPort >> 8) & 0xff, destPort & 0xff]);
    sock.write(req);
    const rep = await readN(sock, 10); // VER REP RSV ATYP + 4 addr + 2 port
    if (rep[1] !== 0x00) { sock.destroy(); throw new Error('SOCKS connect failed, REP=' + rep[1]); }
    return sock;
}

let peers;

before(async () => {
    peers = await createPeers();
    await Promise.all([peers.a.start(), peers.b.start()]);
    // Echo service inside the tunnel on peer B.
    await peers.b.listen(8080, (socket) => {
        socket.on('error', () => {});
        socket.pipe(socket);
    });
});

after(async () => {
    if (peers) await Promise.all([peers.a.close(), peers.b.close()]);
});

test('SOCKS5 no-auth: CONNECT + echo through the tunnel', async () => {
    const srv = await peers.a.socks(0); // ephemeral port
    const port = srv.server.address().port;
    try {
        const sock = await socksConnect(port, '127.0.0.1', peers.ipB, 8080);
        const msg = 'hello-' + crypto.randomBytes(6).toString('hex');
        const got = await new Promise((resolve, reject) => {
            let buf = '';
            sock.on('data', (d) => { buf += d.toString(); if (buf.length >= msg.length) resolve(buf); });
            sock.once('error', reject);
            sock.write(msg);
        });
        assert.equal(got, msg);
        sock.destroy();
    } finally {
        srv.close();
    }
});

test('SOCKS5 no-auth: 5x concurrent CONNECT + echo', async () => {
    const srv = await peers.a.socks(0);
    const port = srv.server.address().port;
    try {
        await Promise.all(Array.from({ length: 5 }, async () => {
            const sock = await socksConnect(port, '127.0.0.1', peers.ipB, 8080);
            const msg = crypto.randomBytes(16).toString('hex');
            const got = await new Promise((resolve, reject) => {
                let buf = '';
                sock.on('data', (d) => { buf += d.toString(); if (buf.length >= msg.length) resolve(buf); });
                sock.once('error', reject);
                sock.write(msg);
            });
            assert.equal(got, msg);
            sock.destroy();
        }));
    } finally {
        srv.close();
    }
});

test('SOCKS5 auth: wrong credentials are rejected, correct ones work', async () => {
    const srv = await peers.a.socks(0, '127.0.0.1', { auth: { username: 'alice', password: 's3cret' } });
    const port = srv.server.address().port;
    try {
        await assert.rejects(
            () => socksConnect(port, '127.0.0.1', peers.ipB, 8080, { username: 'alice', password: 'wrong' }),
            (e) => e.authRejected === true
        );

        const sock = await socksConnect(port, '127.0.0.1', peers.ipB, 8080, { username: 'alice', password: 's3cret' });
        const got = await new Promise((resolve, reject) => {
            let buf = '';
            sock.on('data', (d) => { buf += d.toString(); if (buf.length >= 4) resolve(buf); });
            sock.once('error', reject);
            sock.write('ping');
        });
        assert.equal(got, 'ping');
        sock.destroy();
    } finally {
        srv.close();
    }
});
