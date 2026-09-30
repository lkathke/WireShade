'use strict';

const { WireShadeClient, ConnectionState } = require('./client');

/**
 * WireShadeWsServer - high-level server-role wrapper (Topology B from
 * docs/WEBSOCKET_TRANSPORT.md): a WireShade WireGuard peer that accepts the
 * tunnel over a WebSocket (ws) or WebSocket-over-TLS (wss) connection.
 *
 * It is a thin subclass of {@link WireShadeClient} that pins the transport to
 * `{ type: 'websocket', role: 'server' }`, so listen()/connect()/forwardRemote()/
 * forwardLocal(), the http(s) agents, events and the reconnect + O1/O2/O3 logic
 * all come for free and behave identically to the UDP client.
 *
 * Usage (docs §5):
 *
 *   const { WireShadeWsServer, generateSelfSignedCert } = require('wireshade');
 *   const { certPem, keyPem } = generateSelfSignedCert(['localhost']);
 *   const srv = new WireShadeWsServer({
 *     listen: '0.0.0.0:443',
 *     pathPrefix: 'v1',
 *     tls: { cert: certPem, key: keyPem },   // omit => plaintext ws://
 *     wireguard: { privateKey, peerPublicKey, sourceIp }
 *   });
 *   await srv.start();                       // resolves once bound & listening for a peer
 *   await srv.listen(8080, (sock) => sock.on('data', () => sock.end('pong')));
 */
class WireShadeWsServer extends WireShadeClient {
    /**
     * @param {Object} config
     * @param {string} config.listen - bind address, "host:port".
     * @param {Object} config.wireguard - { privateKey, peerPublicKey, presharedKey?, sourceIp, persistentKeepalive? }
     * @param {string} [config.pathPrefix] - expected upgrade path prefix.
     * @param {number} [config.keepaliveSec] - WS ping keepalive interval (seconds).
     * @param {Object} [config.tls] - { cert, key } PEM. Omit for plaintext ws://.
     * @param {Object} [config.reconnect] - reconnection config (see WireShadeClient).
     */
    constructor(config = {}) {
        const { listen, pathPrefix, keepaliveSec, tls, wireguard, transport, ...rest } = config;
        if (!listen) {
            throw new Error('WireShadeWsServer requires "listen" ("host:port")');
        }
        super({
            ...rest,
            wireguard,
            transport: {
                // Allow callers to pass extra transport knobs, but the role and
                // type are fixed for this wrapper.
                ...transport,
                type: 'websocket',
                role: 'server',
                listen,
                pathPrefix,
                keepaliveSec,
                tls
            }
        });
    }

    /**
     * Start the WS server: bind and begin accepting a WireShade peer.
     *
     * Unlike the client's start() (which resolves once the WireGuard handshake
     * with the peer completes), this resolves as soon as the transport is bound
     * and listening, so listen()/forwardRemote() can be registered before any
     * peer has connected. Rejects if the client is closed before it binds.
     * @returns {Promise<void>}
     */
    start() {
        if (this.state === ConnectionState.CONNECTED) return Promise.resolve();

        return new Promise((resolve, reject) => {
            const cleanup = () => {
                this.removeListener('transportReady', onReady);
                this.removeListener('connect', onReady);
                this.removeListener('disconnect', onError);
                this.removeListener('close', onClose);
            };
            const onReady = () => { cleanup(); resolve(); };
            const onError = (err) => { cleanup(); reject(err || new Error('Disconnected during startup')); };
            const onClose = () => { cleanup(); reject(new Error('Server was closed before it started listening')); };

            this.on('transportReady', onReady);
            this.on('connect', onReady);
            this.on('disconnect', onError);
            this.on('close', onClose);

            // Already (re)connecting: just wait for the signals above.
            if (this.state === ConnectionState.CONNECTING || this.state === ConnectionState.RECONNECTING) {
                return;
            }

            this._closed = false;
            this._initNative();
        });
    }
}

module.exports = { WireShadeWsServer };
