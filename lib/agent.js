'use strict';

const http = require('http');
const net = require('net');
const dns = require('dns');
const { Duplex } = require('stream');
const { addSocketShims } = require('./socket_shim');

const noop = () => { };

/**
 * Creates the logging functions for a component.
 * Priority: options.logger -> console (unless options.logging === false).
 */
function makeLoggers(options) {
    if (typeof options.logger === 'function') {
        return { log: options.logger, error: options.logger };
    }
    if (options.logging === false) {
        return { log: noop, error: noop };
    }
    return { log: console.log, error: console.error };
}

/**
 * Duplex stream representing an outgoing TCP connection through the tunnel.
 * Behaves like a net.Socket for http.Agent / tls.connect / pipe().
 */
class TunnelSocket extends Duplex {
    constructor(options = {}) {
        super({ allowHalfOpen: options.allowHalfOpen === true });
        this.connection = null;
        this.connecting = true;
        this.remoteAddress = undefined;
        this.remotePort = undefined;
        this._remoteEnded = false;
        // O3: native instance + connection id for inbound flow-control.
        this.gw = options.gw || null;
        this.connId = null;
        this._paused = false;

        this._ready = new Promise((resolve, reject) => {
            this._resolveReady = resolve;
            this._rejectReady = reject;
        });
        // Rejections are surfaced through 'error' (destroy); avoid unhandled rejections here.
        this._ready.catch(noop);

        addSocketShims(this);
        this.connecting = true;
    }

    /** @internal called once the native connection is established */
    _attach(conn) {
        if (this.destroyed) {
            // Destroyed while connecting: tear the native connection down again.
            conn.close().catch(noop);
            return false;
        }
        this.connection = conn;
        this.connecting = false;
        // O3: the outbound connection id used by gw.pauseConnection/resumeConnection.
        // Assumption (native contract): NativeConnection exposes a numeric `id`.
        // If it does not, connId stays null and backpressure is a safe no-op.
        this.connId = (conn && typeof conn.id === 'number') ? conn.id : null;
        this._resolveReady(conn);
        return true;
    }

    /** @internal called when connecting failed */
    _fail(err) {
        this.connecting = false;
        this._rejectReady(err);
        this.destroy(err);
    }

    /** @internal data from native */
    _onNativeData(buffer) {
        if (this.destroyed || this._remoteEnded) return;
        if (this._touchIdle) this._touchIdle();
        // O3: push() returning false means the readable buffer is at/above its
        // highWaterMark. Ask the native side to stop draining this connection's
        // RX queue so the TCP window closes and the peer throttles; _read()
        // resumes once the consumer catches up.
        if (!this.push(buffer)) this._pauseNative();
    }

    /** @internal apply inbound backpressure towards the peer (feature-detected no-op) */
    _pauseNative() {
        if (this._paused) return;
        if (!this.gw || this.connId == null || typeof this.gw.pauseConnection !== 'function') return;
        this._paused = true;
        try {
            Promise.resolve(this.gw.pauseConnection(this.connId)).catch(noop);
        } catch (_) { /* quiet */ }
    }

    /** @internal release inbound backpressure (feature-detected no-op) */
    _resumeNative() {
        if (!this._paused) return;
        this._paused = false;
        if (!this.gw || this.connId == null || typeof this.gw.resumeConnection !== 'function') return;
        try {
            Promise.resolve(this.gw.resumeConnection(this.connId)).catch(noop);
        } catch (_) { /* quiet */ }
    }

    /** @internal remote side closed (EOF / RST / Closed) - fires once per connection */
    _onNativeClose() {
        if (this._remoteEnded) return;
        this._remoteEnded = true;
        if (!this.destroyed) this.push(null);
    }

    _read() {
        // Consumer wants more data: lift any inbound backpressure (O3).
        this._resumeNative();
    }

    _write(chunk, encoding, callback) {
        this._ready
            .then((conn) => conn.send(chunk))
            .then(() => {
                if (this._touchIdle) this._touchIdle();
                callback();
            }, callback);
    }

    _final(callback) {
        // Half-close (FIN). Errors are ignored: the connection may already be gone on the native side.
        this._ready
            .then((conn) => {
                this._nativeClosed = true;
                return conn.close();
            })
            .then(() => callback(), () => callback());
    }

    _destroy(err, callback) {
        const conn = this.connection;
        this.connection = null;
        if (conn && !this._nativeClosed) conn.close().catch(noop);
        this._nativeClosed = true;
        // If still connecting, _attach() closes the connection when it arrives.
        this._rejectReady(err || new Error('Socket destroyed'));
        callback(err);
    }
}

class WireShadeAgent extends http.Agent {
    /**
     * @param {Object} wireShade native WireShade instance
     * @param {Object} [options] http.Agent options plus { logging, logger, allowHalfOpen }
     */
    constructor(wireShade, options = {}) {
        super(options);
        this.gw = wireShade;
        this.options = options;
        const { log, error } = makeLoggers(options);
        this.log = log;
        this.error = error;
    }

    /**
     * Opens a TCP connection through the tunnel.
     * The callback is invoked as `cb(null, socket)` once the connection is
     * established. Failures (DNS, RST, timeout, tunnel shutdown) are reported
     * via the socket's 'error' event.
     */
    createConnection(options, cb) {
        const host = options.host || options.hostname || 'localhost';
        const port = parseInt(options.port, 10);
        const { log, error } = this;

        const stream = new TunnelSocket({ allowHalfOpen: options.allowHalfOpen ?? this.options.allowHalfOpen, gw: this.gw });

        const connectTo = (address) => {
            if (stream.destroyed) return;
            stream.remoteAddress = address;
            stream.remotePort = port;
            log(`[Agent] Connecting to ${host}:${port}${address !== host ? ` (${address})` : ''}`);

            let connectPromise;
            try {
                connectPromise = this.gw.connect(
                    address,
                    port,
                    (err, data) => {
                        // napi-rs ThreadsafeFunction: (err, value)
                        if (err && !Buffer.isBuffer(err)) {
                            error('[Agent] Receive error:', err);
                            stream.destroy(err instanceof Error ? err : new Error(String(err)));
                            return;
                        }
                        const buffer = Buffer.isBuffer(data) ? data : (Buffer.isBuffer(err) ? err : null);
                        if (buffer) stream._onNativeData(buffer);
                    },
                    () => stream._onNativeClose()
                );
            } catch (err) {
                connectPromise = Promise.reject(err);
            }

            connectPromise.then((conn) => {
                if (!stream._attach(conn)) return;
                log(`[Agent] Connected to ${address}:${port}`);
                stream.emit('connect');
                stream.emit('ready');
                if (cb) cb(null, stream);
            }).catch((err) => {
                error(`[Agent] Connection to ${address}:${port} failed:`, err?.message || err);
                stream._fail(err instanceof Error ? err : new Error(String(err)));
            });
        };

        if (net.isIPv4(host)) {
            process.nextTick(connectTo, host);
        } else {
            const lookup = options.lookup || dns.lookup;
            lookup(host, { family: 4 }, (err, address) => {
                if (err) {
                    error(`[Agent] DNS lookup for ${host} failed:`, err.message);
                    stream._fail(err);
                    return;
                }
                if (Array.isArray(address)) address = address[0] && address[0].address;
                connectTo(address);
            });
        }

        return stream;
    }
}

module.exports = { WireShadeAgent, TunnelSocket, makeLoggers };
