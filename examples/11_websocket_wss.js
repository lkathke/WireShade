'use strict';

/*
 * WireShade WebSocket (WSS) end-to-end proof — native transport layer.
 *
 * Topology B from docs/WEBSOCKET_TRANSPORT.md: both ends are WireShade peers,
 * the WireGuard tunnel is carried over a single WebSocket-over-TLS connection.
 *
 *   WireShade WS-Server (Peer B, 10.0.0.1)  <== wss ==>  WireShade WS-Client (Peer A, 10.0.0.2)
 *
 * The server terminates TLS with a self-signed certificate; the client pins
 * that certificate (no real CA needed). Once the WireGuard handshake completes
 * over WSS, the client opens a TCP connection through the tunnel to a tiny echo
 * service on the server and verifies the round-trip.
 *
 * This uses the NATIVE binding directly (WireShade.wsServer / .wsClient /
 * generateSelfSignedCert). The high-level JS API (WireShadeClient) grows the
 * `transport:{...}` option in a later round.
 *
 * Run:  node examples/11_websocket_wss.js
 * Exits 0 on success, 1 on failure.
 */

const { getBinding } = require('../lib/binding');
const { generateKeyPair } = require('../index.js');

const native = getBinding();
const { WireShade, generateSelfSignedCert } = native;

const HOST = '127.0.0.1';
const PORT = 8443;
const SERVER_IP = '10.0.0.1';
const CLIENT_IP = '10.0.0.2';
const TCP_PORT = 8080;
const MESSAGE = 'ping';
const EXPECTED = 'pong';

function fail(msg) {
    console.error('FAIL:', msg);
    process.exit(1);
}

async function main() {
    // 1) Self-signed certificate valid for 'localhost' (client connects by name
    //    so SNI + verification match a DNS SAN).
    const { certPem, keyPem } = generateSelfSignedCert(['localhost']);
    console.log('generated self-signed certificate for localhost');

    // 2) WireGuard key pairs for both peers.
    const server = generateKeyPair();
    const client = generateKeyPair();

    // 3) WSS server (Peer B): terminates TLS AND the WireGuard tunnel.
    const wsServer = WireShade.wsServer({
        privateKey: server.privateKey,
        peerPublicKey: client.publicKey,
        sourceIp: SERVER_IP,
        persistentKeepalive: 25,
        listen: `${HOST}:${PORT}`,
        tls: { cert: certPem, key: keyPem }
    });

    // A tiny TCP echo service inside the tunnel: reply EXPECTED to any data.
    await wsServer.listen(
        TCP_PORT,
        (err, connId, remoteIp, remotePort) => {
            if (err) return console.error('server onConnection error:', err);
            console.log(`server: tunnel connection ${connId} from ${remoteIp}:${remotePort}`);
        },
        (err, connId, data) => {
            if (err) return console.error('server onData error:', err);
            console.log(`server: received ${JSON.stringify(data.toString())}, replying ${JSON.stringify(EXPECTED)}`);
            wsServer.sendTo(connId, Buffer.from(EXPECTED)).catch((e) => console.error('server sendTo:', e));
        },
        (_err, connId) => {
            console.log(`server: tunnel connection ${connId} closed`);
        }
    );
    console.log(`server: listening on tunnel ${SERVER_IP}:${TCP_PORT}, WSS on wss://${HOST}:${PORT}`);

    // 4) WSS client (Peer A): pins the self-signed certificate, connects by name.
    const wsClient = WireShade.wsClient({
        privateKey: client.privateKey,
        peerPublicKey: server.publicKey,
        sourceIp: CLIENT_IP,
        persistentKeepalive: 25,
        url: `wss://localhost:${PORT}`,
        tls: { ca: certPem }
    });

    // 5) Wait for the WireGuard handshake to complete over WSS.
    await wsClient.waitForHandshake(15000);
    console.log('client: WireGuard handshake complete over WSS');

    // 6) Talk through the tunnel: open a TCP connection and verify the echo.
    const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for echo')), 10000);
        let got = '';
        wsClient
            .connect(
                SERVER_IP,
                TCP_PORT,
                (err, data) => {
                    if (err) return reject(err);
                    got += data.toString();
                    if (got.length >= EXPECTED.length) {
                        clearTimeout(timer);
                        resolve(got);
                    }
                },
                () => {
                    // onClose: if we already have the answer this is fine.
                    clearTimeout(timer);
                    if (got) resolve(got);
                }
            )
            .then((conn) => {
                console.log(`client: connected through tunnel (id ${conn.id}), sending ${JSON.stringify(MESSAGE)}`);
                return conn.send(Buffer.from(MESSAGE));
            })
            .catch(reject);
    });

    if (result !== EXPECTED) {
        fail(`unexpected echo: got ${JSON.stringify(result)}, expected ${JSON.stringify(EXPECTED)}`);
    }
    console.log(`client: received ${JSON.stringify(result)} — round-trip over WSS OK`);

    await wsClient.shutdown();
    await wsServer.shutdown();
    console.log('SUCCESS: WireGuard over WSS handshake + TCP echo verified');
    // Give the native tasks a tick to unwind, then exit cleanly.
    setTimeout(() => process.exit(0), 150);
}

main().catch((err) => {
    fail(err && err.stack ? err.stack : String(err));
});
