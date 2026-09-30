'use strict';

/*
 * WireShade WebSocket transport — HIGH-LEVEL API (Topology B).
 *
 * The ergonomic counterpart to examples/11_websocket_wss.js (which drives the
 * native binding directly). Here both ends use the high-level JS API:
 *
 *   - Peer B: `WireShadeWsServer`      (WS server, terminates the WG tunnel)
 *   - Peer A: `WireShadeClient` with   `transport: { type: 'websocket', ... }`
 *
 * The WireGuard tunnel is carried over a single WSS connection. The server
 * terminates TLS with a self-signed certificate; the client pins that cert
 * (no real CA needed). Once connected, the client opens an HTTP request AND a
 * raw TCP connection through the tunnel to services the server exposes with
 * forwardRemote()/listen() — all the normal WireShadeClient conveniences work
 * unchanged over WebSocket.
 *
 * Run:  node examples/13_websocket_highlevel.js
 * Exits 0 on success, 1 on failure.
 */

const http = require('http');
const {
    WireShadeClient, WireShadeWsServer, generateKeyPair, generateSelfSignedCert
} = require('../index.js');

const HOST = '127.0.0.1';
const PORT = 8444;
const SERVER_IP = '10.0.0.1';
const CLIENT_IP = '10.0.0.2';
const TCP_PORT = 8080;
const HTTP_PORT = 8081;

function fail(msg) {
    console.error('FAIL:', msg);
    process.exit(1);
}

async function main() {
    // 1) Self-signed certificate valid for 'localhost' (client connects by name).
    const { certPem, keyPem } = generateSelfSignedCert(['localhost', '127.0.0.1']);
    console.log('generated self-signed certificate for localhost');

    // 2) WireGuard key pairs for both peers.
    const server = generateKeyPair();
    const client = generateKeyPair();

    // 3) A plain local HTTP service the server will expose through the tunnel.
    const localHttp = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello from behind the tunnel');
    });
    await new Promise((resolve) => localHttp.listen(HTTP_PORT, '127.0.0.1', resolve));

    // 4) WSS server (Peer B): high-level WireShadeWsServer, terminates TLS + WG.
    const wsServer = new WireShadeWsServer({
        logging: false,
        listen: `${HOST}:${PORT}`,
        pathPrefix: 'v1',
        tls: { cert: certPem, key: keyPem },
        wireguard: {
            privateKey: server.privateKey,
            peerPublicKey: client.publicKey,
            sourceIp: SERVER_IP
        }
    });

    // start() resolves once the WS server is bound and listening for a peer.
    await wsServer.start();
    console.log(`server: listening on wss://${HOST}:${PORT}, tunnel IP ${SERVER_IP}`);

    // A tiny TCP echo service inside the tunnel.
    await wsServer.listen(TCP_PORT, (socket) => {
        socket.on('error', () => {});
        socket.on('data', () => socket.end('pong'));
    });
    // Expose the local HTTP service on a tunnel port via reverse forwarding.
    await wsServer.forwardRemote(HTTP_PORT, '127.0.0.1', HTTP_PORT);
    console.log(`server: tunnel TCP echo on :${TCP_PORT}, HTTP forwarded on :${HTTP_PORT}`);

    // 5) WSS client (Peer A): ergonomic transport config, pins the cert.
    const wsClient = new WireShadeClient({
        logging: false,
        reconnect: { enabled: false },
        wireguard: {
            privateKey: client.privateKey,
            peerPublicKey: server.publicKey,
            sourceIp: CLIENT_IP
        },
        transport: {
            type: 'websocket',
            role: 'client',
            url: `wss://localhost:${PORT}`,
            pathPrefix: 'v1',
            tls: { ca: certPem, servername: 'localhost' }
        }
    });

    // start() resolves once the WireGuard handshake over WSS completes.
    await wsClient.start();
    console.log('client: WireGuard handshake complete over WSS');

    // 6a) Raw TCP through the tunnel.
    const echo = await new Promise((resolve, reject) => {
        const s = wsClient.connect({ host: SERVER_IP, port: TCP_PORT });
        const chunks = [];
        s.on('error', reject);
        s.on('data', (c) => chunks.push(c));
        s.on('end', () => resolve(Buffer.concat(chunks).toString()));
        s.on('connect', () => s.end('ping'));
    });
    if (echo !== 'pong') fail(`unexpected TCP echo: ${JSON.stringify(echo)}`);
    console.log(`client: TCP echo through tunnel -> ${JSON.stringify(echo)}`);

    // 6b) HTTP through the tunnel (client.http wrapper -> tunnel agent).
    const body = await wsClient.get(`http://${SERVER_IP}:${HTTP_PORT}/`);
    if (!body.includes('behind the tunnel')) fail(`unexpected HTTP body: ${JSON.stringify(body)}`);
    console.log(`client: HTTP GET through tunnel -> ${JSON.stringify(body)}`);

    await wsClient.close();
    await wsServer.close();
    await new Promise((resolve) => localHttp.close(resolve));

    console.log('SUCCESS: high-level WireGuard-over-WSS tunnel (TCP + HTTP) verified');
    setTimeout(() => process.exit(0), 150);
}

main().catch((err) => {
    fail(err && err.stack ? err.stack : String(err));
});
