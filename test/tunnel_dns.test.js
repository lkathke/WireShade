'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');
const { createPeers } = require('./fixtures/peers');
const { resolveA } = require('../lib/tunnel_dns');

function skipName(buf, off) {
    while (off < buf.length) {
        const len = buf[off];
        if (len === 0) return off + 1;
        if ((len & 0xc0) === 0xc0) return off + 2;
        off += 1 + len;
    }
    return off;
}

// A tiny TCP DNS server that answers every A query with `answerIp`.
function dnsResponder(answerIp) {
    return (socket) => {
        socket.on('error', () => {});
        let acc = Buffer.alloc(0);
        let expected = null;
        socket.on('data', (chunk) => {
            acc = Buffer.concat([acc, chunk]);
            if (expected === null && acc.length >= 2) { expected = acc.readUInt16BE(0); acc = acc.subarray(2); }
            if (expected === null || acc.length < expected) return;
            const query = acc.subarray(0, expected);
            const id = query.readUInt16BE(0);
            const qEnd = skipName(query, 12) + 4;                 // name + QTYPE + QCLASS
            const question = query.subarray(12, qEnd);
            const ip = answerIp.split('.').map(Number);
            const header = Buffer.alloc(12);
            header.writeUInt16BE(id, 0);
            header.writeUInt16BE(0x8180, 2);                      // QR + RD + RA
            header.writeUInt16BE(1, 4);                           // QDCOUNT
            header.writeUInt16BE(1, 6);                           // ANCOUNT
            const answer = Buffer.concat([
                Buffer.from([0xc0, 0x0c]),                        // name pointer -> question
                Buffer.from([0x00, 0x01, 0x00, 0x01]),            // type A, class IN
                Buffer.from([0x00, 0x00, 0x00, 0x3c]),            // TTL 60
                Buffer.from([0x00, 0x04]),                        // RDLENGTH
                Buffer.from(ip)                                   // RDATA
            ]);
            const msg = Buffer.concat([header, question, answer]);
            const framed = Buffer.concat([Buffer.from([(msg.length >> 8) & 0xff, msg.length & 0xff]), msg]);
            socket.write(framed);
        });
    };
}

let peers;

before(async () => {
    peers = await createPeers();
    await Promise.all([peers.a.start(), peers.b.start()]);
    // Peer B: fake DNS on :53 (answers everything with ipB) + echo on :8080.
    await peers.b.listen(53, dnsResponder(peers.ipB));
    await peers.b.listen(8080, (s) => { s.on('error', () => {}); s.pipe(s); });
});

after(async () => {
    if (peers) await Promise.all([peers.a.close(), peers.b.close()]);
});

test('resolveA over the tunnel returns the A record', async () => {
    const ip = await resolveA(peers.a, peers.ipB, 'anything.internal', { timeout: 5000 });
    assert.equal(ip, peers.ipB);
});

test('SOCKS5 with in-tunnel DNS resolves a domain and connects', async () => {
    const srv = await peers.a.socks(0, '127.0.0.1', { dns: peers.ipB });
    const port = srv.server.address().port;
    try {
        // Ask the proxy for a DOMAIN (ATYP=0x03); it must resolve via tunnel DNS.
        const sock = net.connect(port, '127.0.0.1');
        await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
        sock.write(Buffer.from([0x05, 1, 0x00]));               // greeting no-auth
        await readN(sock, 2);
        const name = Buffer.from('echo.internal');
        sock.write(Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name,
            Buffer.from([(8080 >> 8) & 0xff, 8080 & 0xff])
        ]));
        const rep = await readN(sock, 10);
        assert.equal(rep[1], 0x00, 'SOCKS CONNECT should succeed via tunnel DNS');

        const msg = 'dns-' + crypto.randomBytes(6).toString('hex');
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

function readN(sock, n) {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const onData = (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length >= n) {
                sock.removeListener('data', onData);
                if (buf.length > n) sock.unshift(buf.subarray(n));
                resolve(buf.subarray(0, n));
            }
        };
        sock.on('data', onData);
        sock.once('error', reject);
    });
}
