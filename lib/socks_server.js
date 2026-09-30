'use strict';

const net = require('net');
const EventEmitter = require('events');

// SOCKS5 constants
const VERSION = 0x05;
const AUTH_NONE = 0x00;
const AUTH_USERPASS = 0x02;
const AUTH_NO_ACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
// Reply codes
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_HOST_UNREACHABLE = 0x04;
const REP_CONN_REFUSED = 0x05;
const REP_CMD_NOT_SUPPORTED = 0x07;
const REP_ATYP_NOT_SUPPORTED = 0x08;

/**
 * Reads an exact number of bytes from a socket, tolerating fragmentation.
 * Detach() stops buffering and returns any leftover bytes for hand-off to pipe().
 */
function createByteReader(socket) {
    let chunks = [];
    let ended = false;
    let error = null;
    let waiter = null; // { need, resolve, reject }

    const total = () => chunks.reduce((n, c) => n + c.length, 0);

    const settle = () => {
        if (!waiter) return;
        if (error) { const w = waiter; waiter = null; w.reject(error); return; }
        if (total() >= waiter.need) {
            const buf = Buffer.concat(chunks);
            const out = buf.subarray(0, waiter.need);
            chunks = buf.length > waiter.need ? [buf.subarray(waiter.need)] : [];
            const w = waiter; waiter = null; w.resolve(out);
            return;
        }
        if (ended) { const w = waiter; waiter = null; w.reject(new Error('socket closed during SOCKS handshake')); }
    };

    const onData = (d) => { chunks.push(d); settle(); };
    const onEnd = () => { ended = true; settle(); };
    const onError = (e) => { error = e; settle(); };

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);

    return {
        read(need) {
            return new Promise((resolve, reject) => {
                waiter = { need, resolve, reject };
                settle();
            });
        },
        detach() {
            socket.removeListener('data', onData);
            socket.removeListener('end', onEnd);
            socket.removeListener('error', onError);
            const leftover = Buffer.concat(chunks);
            chunks = [];
            return leftover;
        }
    };
}

/**
 * A SOCKS5 proxy (CONNECT) that routes every accepted connection through the
 * WireShade tunnel. Point any SOCKS5-aware app (browser, curl --socks5-hostname,
 * proxychains) at it and reach hosts inside the VPN dynamically.
 */
class WireShadeSocksServer extends EventEmitter {
    /**
     * @param {WireShadeClient} client - a started WireShade client
     * @param {Object} [options]
     * @param {{username:string,password:string}|function(user,pass):boolean} [options.auth]
     *        username/password auth. A function receives (user, pass) and returns bool.
     *        Omit for no-auth.
     * @param {boolean} [options.logging=false]
     */
    constructor(client, options = {}) {
        super();
        this.client = client;
        this.options = options;
        this.logging = options.logging === true;
        this.log = this.logging ? (...a) => console.log('[socks]', ...a) : () => {};
        this.auth = options.auth || null;
        this.server = null;
    }

    /**
     * @param {number} port
     * @param {string} [host='127.0.0.1']
     * @returns {Promise<WireShadeSocksServer>}
     */
    listen(port, host = '127.0.0.1') {
        return new Promise((resolve, reject) => {
            this.server = net.createServer((sock) => this._handle(sock));
            this.server.on('error', (err) => {
                this.emit('error', err);
                reject(err);
            });
            this.server.listen(port, host, () => {
                const addr = this.server.address();
                this.log(`listening on ${addr.address}:${addr.port}`);
                this.emit('listening', addr);
                resolve(this);
            });
        });
    }

    close(callback) {
        if (this.server) this.server.close(callback);
        else if (callback) callback();
        this.emit('close');
    }

    async _handle(sock) {
        sock.on('error', () => {}); // avoid uncaught ECONNRESET from clients
        const reader = createByteReader(sock);
        try {
            await this._negotiate(reader, sock);
            const target = await this._readRequest(reader, sock);
            await this._connectAndPipe(reader, sock, target);
        } catch (err) {
            this.log('handshake failed:', err.message);
            sock.destroy();
        }
    }

    async _negotiate(reader, sock) {
        // greeting: VER, NMETHODS, METHODS[NMETHODS]
        const head = await reader.read(2);
        if (head[0] !== VERSION) throw new Error('not SOCKS5');
        const nMethods = head[1];
        const methods = await reader.read(nMethods);

        const wantUserPass = !!this.auth;
        const offered = new Set(methods);

        if (wantUserPass) {
            if (!offered.has(AUTH_USERPASS)) {
                sock.write(Buffer.from([VERSION, AUTH_NO_ACCEPTABLE]));
                throw new Error('client did not offer username/password auth');
            }
            sock.write(Buffer.from([VERSION, AUTH_USERPASS]));
            await this._userPassAuth(reader, sock);
        } else {
            if (!offered.has(AUTH_NONE)) {
                sock.write(Buffer.from([VERSION, AUTH_NO_ACCEPTABLE]));
                throw new Error('client did not offer no-auth');
            }
            sock.write(Buffer.from([VERSION, AUTH_NONE]));
        }
    }

    async _userPassAuth(reader, sock) {
        // RFC 1929: VER(0x01), ULEN, UNAME, PLEN, PASSWD
        const ver = await reader.read(1);
        if (ver[0] !== 0x01) throw new Error('bad auth version');
        const uLen = (await reader.read(1))[0];
        const uname = (await reader.read(uLen)).toString('utf8');
        const pLen = (await reader.read(1))[0];
        const passwd = (await reader.read(pLen)).toString('utf8');

        let ok;
        if (typeof this.auth === 'function') ok = !!this.auth(uname, passwd);
        else ok = uname === this.auth.username && passwd === this.auth.password;

        sock.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) throw new Error(`auth failed for user "${uname}"`);
    }

    async _readRequest(reader, sock) {
        // VER, CMD, RSV, ATYP, DST.ADDR, DST.PORT
        const req = await reader.read(4);
        if (req[0] !== VERSION) throw new Error('bad request version');
        const cmd = req[1];
        const atyp = req[3];

        if (cmd !== CMD_CONNECT) {
            this._reply(sock, REP_CMD_NOT_SUPPORTED);
            throw new Error(`unsupported command 0x${cmd.toString(16)} (only CONNECT)`);
        }

        let host;
        if (atyp === ATYP_IPV4) {
            host = Array.from(await reader.read(4)).join('.');
        } else if (atyp === ATYP_DOMAIN) {
            const len = (await reader.read(1))[0];
            host = (await reader.read(len)).toString('utf8');
        } else if (atyp === ATYP_IPV6) {
            const raw = await reader.read(16);
            const parts = [];
            for (let i = 0; i < 16; i += 2) parts.push(raw.readUInt16BE(i).toString(16));
            host = parts.join(':');
        } else {
            this._reply(sock, REP_ATYP_NOT_SUPPORTED);
            throw new Error(`unsupported address type 0x${atyp.toString(16)}`);
        }

        const port = (await reader.read(2)).readUInt16BE(0);
        return { host, port };
    }

    _connectAndPipe(reader, sock, target) {
        return new Promise((resolve) => {
            this.log(`CONNECT ${target.host}:${target.port}`);
            let settled = false;

            let tunnel;
            try {
                tunnel = this.client.connect({ host: target.host, port: target.port });
            } catch (err) {
                this._reply(sock, REP_GENERAL_FAILURE);
                sock.destroy();
                return resolve();
            }

            tunnel.on('error', (err) => {
                if (!settled) {
                    settled = true;
                    this.log(`connect failed: ${err.message}`);
                    this._reply(sock, REP_CONN_REFUSED);
                    sock.destroy();
                    resolve();
                }
            });

            tunnel.on('connect', () => {
                if (settled) return;
                settled = true;
                this._reply(sock, REP_SUCCESS);

                // Forward any bytes the client already sent after the request.
                const leftover = reader.detach();
                if (leftover.length) tunnel.write(leftover);

                sock.pipe(tunnel);
                tunnel.pipe(sock);

                const cleanup = () => { sock.destroy(); tunnel.destroy(); };
                sock.on('error', cleanup);
                tunnel.on('error', cleanup);
                sock.on('close', cleanup);
                tunnel.on('close', cleanup);

                this.emit('connection', { host: target.host, port: target.port });
                resolve();
            });
        });
    }

    _reply(sock, code) {
        // VER, REP, RSV, ATYP=IPv4, BND.ADDR=0.0.0.0, BND.PORT=0
        sock.write(Buffer.from([VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
    }
}

module.exports = { WireShadeSocksServer };
