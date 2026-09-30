'use strict';
/*
 * SOCKS5 proxy over the tunnel.
 *
 * Starts a local SOCKS5 proxy that routes every connection through the
 * WireGuard tunnel. Any SOCKS5-aware app can then reach hosts inside the VPN:
 *
 *   curl --socks5-hostname 127.0.0.1:1080 http://10.0.0.1:8080/
 *   proxychains <your-app>
 *   browser -> SOCKS5 127.0.0.1:1080
 *
 * This example wires two loopback peers together (peer B is the "network"),
 * starts the proxy on peer A, and drives it with a tiny inline SOCKS5 client
 * so it runs end-to-end with no external tools.
 *
 * In the real world you would just do:
 *   const client = new WireShadeClient('wg0.conf');
 *   await client.start();
 *   await client.socks(1080);                 // or: wireshade socks -c wg0.conf
 */

const net = require('net');
const { WireShadeClient, generateKeyPair } = require('../index.js');

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

// Minimal SOCKS5 no-auth CONNECT client (IPv4).
async function socksGet(port, destIp, destPort, payload) {
    const s = net.connect(port, '127.0.0.1');
    await new Promise((res, rej) => { s.once('connect', res); s.once('error', rej); });
    s.write(Buffer.from([0x05, 1, 0x00]));                    // greeting: no-auth
    await readN(s, 2);
    const ip = destIp.split('.').map(Number);
    s.write(Buffer.from([0x05, 0x01, 0x00, 0x01, ...ip, (destPort >> 8) & 255, destPort & 255]));
    const rep = await readN(s, 10);
    if (rep[1] !== 0x00) throw new Error('SOCKS CONNECT failed, REP=' + rep[1]);
    return await new Promise((res, rej) => {
        let out = '';
        s.on('data', (d) => { out += d.toString(); if (out.length >= payload.length) { s.destroy(); res(out); } });
        s.once('error', rej);
        s.write(payload);
    });
}

async function main() {
    const keyA = generateKeyPair();
    const keyB = generateKeyPair();
    const portA = 51840, portB = 51841;

    const clientA = new WireShadeClient({ logging: false, reconnect: { enabled: false }, wireguard: {
        privateKey: keyA.privateKey, peerPublicKey: keyB.publicKey,
        endpoint: `127.0.0.1:${portB}`, sourceIp: '10.0.0.1', listenPort: portA } });
    const clientB = new WireShadeClient({ logging: false, reconnect: { enabled: false }, wireguard: {
        privateKey: keyB.privateKey, peerPublicKey: keyA.publicKey,
        endpoint: `127.0.0.1:${portA}`, sourceIp: '10.0.0.2', listenPort: portB } });

    await Promise.all([clientA.start(), clientB.start()]);
    console.log('both peers connected');

    // Peer B exposes a TCP echo service inside the tunnel.
    await clientB.listen(8080, (socket) => { socket.on('error', () => {}); socket.pipe(socket); });

    // Peer A runs a SOCKS5 proxy on localhost:1080.
    const proxy = await clientA.socks(1080, '127.0.0.1');
    console.log('SOCKS5 proxy on 127.0.0.1:1080 -> tunnel');

    // Reach peer B (10.0.0.2:8080) through the proxy.
    const echoed = await socksGet(1080, '10.0.0.2', 8080, 'through-the-socks-proxy');
    console.log('echo via SOCKS5:', JSON.stringify(echoed));

    proxy.close();
    await Promise.all([clientA.close(), clientB.close()]);
    console.log(echoed === 'through-the-socks-proxy'
        ? 'SUCCESS: SOCKS5 proxy tunneled the connection'
        : 'FAIL');
    process.exit(echoed === 'through-the-socks-proxy' ? 0 : 1);
}

main().catch((err) => { console.error('failed:', err); process.exit(1); });
