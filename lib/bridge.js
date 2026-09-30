'use strict';

/*
 * WireShadeBridge — a WebSocket(S) -> UDP relay ("bridge") that terminates a
 * WebSocket tunnel and forwards the raw datagrams to a real UDP endpoint,
 * typically a kernel WireGuard server on the same host.
 *
 *   WireShade/wstunnel client ──WSS(:443)──▶ bridge ──UDP──▶ kernel WireGuard ──NAT──▶ internet
 *
 * The bridge does NOT speak WireGuard: it only unwraps the WebSocket framing
 * (1 binary frame = 1 datagram) and relays to/from the target UDP socket. The
 * WireGuard crypto stays end-to-end between the client and the kernel server,
 * which does the NAT/forwarding, so this yields real full-tunnel internet with
 * WSS firewall traversal.
 *
 * wstunnel-compatible: accepts the wstunnel v2 upgrade (`/<prefix>/events`
 * with `Sec-WebSocket-Protocol: v1, authorization.bearer.<jwt>`), so a stock
 * `wstunnel client` works against it. For safety the datagrams are always
 * forwarded to the configured `target` (an open relay is never exposed); the
 * destination requested inside the JWT is ignored unless it is on `allow`.
 */

const http = require('http');
const https = require('https');
const dgram = require('dgram');
const EventEmitter = require('events');
const { WebSocketServer } = require('ws');

const JWT_HEADER_PREFIX = 'authorization.bearer.';

function parseHostPort(s, defPort) {
    const str = String(s);
    const i = str.lastIndexOf(':');
    if (i === -1) return { host: str, port: defPort };
    return { host: str.slice(0, i) || '0.0.0.0', port: parseInt(str.slice(i + 1), 10) };
}

/** Best-effort decode of a wstunnel JWT payload (no verification, like wstunnel). */
function decodeJwt(token) {
    try {
        const payload = token.split('.')[1];
        if (!payload) return null;
        const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return JSON.parse(json);
    } catch (_) {
        return null;
    }
}

class WireShadeBridge extends EventEmitter {
    /**
     * @param {Object} options
     * @param {string} options.target - "host:port" of the real UDP endpoint (e.g. the kernel WG server)
     * @param {string} [options.pathPrefix] - required upgrade path prefix (wstunnel: default 'v1')
     * @param {{cert:string,key:string}} [options.tls] - PEM cert+key for wss (omit => plaintext ws)
     * @param {number} [options.idleTimeoutSec=120] - close an idle relay after N seconds (0 = never)
     * @param {string[]} [options.allow] - optional allow-list of "host:port" targets the JWT may request
     * @param {boolean} [options.logging=false]
     */
    constructor(options = {}) {
        super();
        if (!options.target) throw new Error('WireShadeBridge: options.target ("host:port") is required');
        this.target = parseHostPort(options.target, 51820);
        this.pathPrefix = options.pathPrefix != null ? String(options.pathPrefix).replace(/^\/|\/$/g, '') : null;
        this.tls = options.tls || null;
        this.idleTimeoutMs = (options.idleTimeoutSec != null ? options.idleTimeoutSec : 120) * 1000;
        this.allow = options.allow || null;
        this.logging = options.logging === true;
        this.log = this.logging ? (...a) => console.log('[bridge]', ...a) : () => {};
        this.server = null;
        this.wss = null;
        this.conns = new Set();
    }

    /**
     * @param {string} listen - "host:port" to bind
     * @returns {Promise<WireShadeBridge>}
     */
    listen(listen) {
        const { host, port } = parseHostPort(listen, this.tls ? 443 : 80);
        return new Promise((resolve, reject) => {
            this.server = this.tls
                ? https.createServer({ cert: this.tls.cert, key: this.tls.key })
                : http.createServer();

            // Reject non-tunnel HTTP requests with a bland 400 (looks like a plain server).
            this.server.on('request', (req, res) => { res.statusCode = 400; res.end(); });

            this.wss = new WebSocketServer({
                server: this.server,
                // Reject a bad upgrade path during the handshake (before 'connection').
                verifyClient: (info) => {
                    if (!this.pathPrefix) return true;
                    const path = (info.req.url || '').split('?')[0];
                    return path === `/${this.pathPrefix}/events`;
                },
                // Accept the wstunnel subprotocol "v1" (offered as "v1, authorization.bearer.<jwt>").
                handleProtocols: (protocols) => (protocols.has('v1') ? 'v1' : false)
            });

            this.wss.on('connection', (ws, req) => this._onConnection(ws, req));

            this.server.on('error', (err) => { this.emit('error', err); reject(err); });
            this.server.listen(port, host, () => {
                this.log(`listening on ${this.tls ? 'wss' : 'ws'}://${host}:${port}`
                    + (this.pathPrefix ? `/${this.pathPrefix}/events` : '')
                    + ` -> udp ${this.target.host}:${this.target.port}`);
                this.emit('listening', { host, port });
                resolve(this);
            });
        });
    }

    _onConnection(ws, req) {
        // Path check (wstunnel: /<prefix>/events).
        const url = req.url || '';
        if (this.pathPrefix) {
            const expected = `/${this.pathPrefix}/events`;
            if (url.split('?')[0] !== expected) {
                this.log(`reject: bad path ${url}`);
                ws.close(1008, 'bad path');
                return;
            }
        }

        // Optionally inspect the wstunnel JWT (for logging / allow-list). Target is
        // forced to this.target unless the requested one is explicitly allowed.
        let dest = this.target;
        const proto = req.headers['sec-websocket-protocol'] || '';
        const bearer = proto.split(',').map(s => s.trim()).find(s => s.startsWith(JWT_HEADER_PREFIX));
        if (bearer) {
            const claims = decodeJwt(bearer.slice(JWT_HEADER_PREFIX.length));
            if (claims && claims.r && claims.rp) {
                const req2 = `${claims.r}:${claims.rp}`;
                if (this.allow && this.allow.includes(req2)) dest = { host: claims.r, port: Number(claims.rp) };
                this.log(`client requested ${req2}; forwarding to ${dest.host}:${dest.port}`);
            }
        }

        const udp = dgram.createSocket(dest.host.includes(':') ? 'udp6' : 'udp4');
        const conn = { ws, udp };
        this.conns.add(conn);

        let idleTimer = null;
        const bump = () => {
            if (!this.idleTimeoutMs) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => { this.log('idle timeout'); cleanup(); }, this.idleTimeoutMs);
        };
        let closed = false;
        const cleanup = () => {
            if (closed) return;
            closed = true;
            if (idleTimer) clearTimeout(idleTimer);
            try { ws.close(); } catch (_) {}
            try { udp.close(); } catch (_) {}
            this.conns.delete(conn);
        };

        udp.on('message', (msg) => { bump(); try { ws.send(msg, { binary: true }); } catch (_) {} });
        udp.on('error', (e) => { this.log('udp error', e.message); cleanup(); });

        ws.on('message', (data) => {
            bump();
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            udp.send(buf, dest.port, dest.host, (err) => { if (err) this.log('udp send error', err.message); });
        });
        ws.on('close', cleanup);
        ws.on('error', cleanup);

        bump();
        this.emit('connection', { remote: req.socket.remoteAddress, target: dest });
        this.log(`connection from ${req.socket.remoteAddress} -> ${dest.host}:${dest.port}`);
    }

    close(callback) {
        for (const c of this.conns) { try { c.ws.close(); } catch (_) {} try { c.udp.close(); } catch (_) {} }
        this.conns.clear();
        if (this.wss) try { this.wss.close(); } catch (_) {}
        if (this.server) this.server.close(callback);
        else if (callback) callback();
        this.emit('close');
    }
}

module.exports = { WireShadeBridge };
