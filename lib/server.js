'use strict';

const { Duplex } = require('stream');
const EventEmitter = require('events');
const { addSocketShims } = require('./socket_shim');
const { makeLoggers } = require('./agent');

const noop = () => { };

/**
 * Duplex stream for an accepted connection on a WireShadeServer.
 */
class ServerSocket extends Duplex {
    constructor(server, connId, options = {}) {
        super({ allowHalfOpen: options.allowHalfOpen === true });
        this._server = server;
        this.connId = connId;
        this.remoteAddress = null;
        this.remotePort = null;
        this.localPort = server.port;
        this._remoteEnded = false;
        this._nativeClosed = false;
        this._paused = false;
        addSocketShims(this);
    }

    /** @internal data from native */
    _onNativeData(buffer) {
        if (this.destroyed || this._remoteEnded) return;
        if (this._touchIdle) this._touchIdle();
        // O3: push() returning false means the readable buffer is at/above its
        // highWaterMark (consumer slower than the peer). Ask the native side to
        // stop draining this connection's RX queue so the TCP window closes and
        // the peer throttles. _read() resumes once the consumer catches up.
        if (!this.push(buffer)) this._pauseNative();
    }

    /** @internal apply inbound backpressure towards the peer (feature-detected no-op) */
    _pauseNative() {
        if (this._paused) return;
        const gw = this._server.gw;
        if (!gw || typeof gw.pauseConnection !== 'function') return;
        this._paused = true;
        try {
            Promise.resolve(gw.pauseConnection(this.connId)).catch(noop);
        } catch (_) { /* quiet */ }
    }

    /** @internal release inbound backpressure (feature-detected no-op) */
    _resumeNative() {
        if (!this._paused) return;
        this._paused = false;
        const gw = this._server.gw;
        if (!gw || typeof gw.resumeConnection !== 'function') return;
        try {
            Promise.resolve(gw.resumeConnection(this.connId)).catch(noop);
        } catch (_) { /* quiet */ }
    }

    /** @internal remote side closed (EOF / RST / Closed) */
    _onNativeClose() {
        if (this._remoteEnded) return;
        this._remoteEnded = true;
        if (!this.destroyed) this.push(null);
    }

    _closeNative() {
        if (this._nativeClosed) return Promise.resolve();
        this._nativeClosed = true;
        const gw = this._server.gw;
        if (!gw) return Promise.resolve();
        try {
            return Promise.resolve(gw.closeConnection(this.connId)).catch(noop);
        } catch (_) {
            return Promise.resolve();
        }
    }

    _read() {
        // Consumer wants more data: lift any inbound backpressure (O3).
        this._resumeNative();
    }

    _write(chunk, encoding, callback) {
        let p;
        try {
            p = this._server.gw.sendTo(this.connId, chunk);
        } catch (err) {
            callback(err);
            return;
        }
        Promise.resolve(p).then(() => {
            if (this._touchIdle) this._touchIdle();
            callback();
        }, (err) => {
            this._server.log(`[Server] Write error on conn ${this.connId}: ${err?.message || err}`);
            callback(err);
        });
    }

    _final(callback) {
        // Graceful half-close (FIN) after all written data has been accepted by the stack.
        this._closeNative().then(() => callback());
    }

    _destroy(err, callback) {
        this._closeNative();
        this._server._forget(this.connId, this);
        callback(err);
    }
}

/**
 * WireShadeServer - A server that listens on a port inside the VPN tunnel.
 *
 * Events: 'listening', 'connection' (socket, info), 'error', 'close'
 */
class WireShadeServer extends EventEmitter {
    /**
     * @param {Object} gw native WireShade instance
     * @param {Object} [options] { logging, logger, allowHalfOpen }
     */
    constructor(gw, options = {}) {
        super();
        this.gw = gw;
        this.options = options;
        this.logging = options.logging !== false;
        const { log, error } = makeLoggers(options);
        this.log = log;
        this.error = error;
        this.connections = new Map();
        this.port = null;
        this.listening = false;
        this._closed = false;
    }

    async listen(port, callback) {
        this.port = port;

        try {
            await this.gw.listen(
                port,
                // onConnection: napi-rs passes (err, connId, remoteIp, remotePort)
                (err, connId, remoteIp, remotePort) => {
                    if (err) {
                        this.error(`[Server] Connection error: ${err}`);
                        return;
                    }
                    if (this._closed) {
                        // Native listeners cannot be removed; reject connections after close().
                        Promise.resolve(this.gw.closeConnection(connId)).catch(noop);
                        return;
                    }
                    this.log(`[Server] New connection ${connId} from ${remoteIp}:${remotePort}`);

                    const stream = new ServerSocket(this, connId, this.options);
                    stream.remoteAddress = remoteIp;
                    stream.remotePort = remotePort;
                    this.connections.set(connId, stream);
                    this.emit('connection', stream, { remoteAddress: remoteIp, remotePort });
                },
                // onData: napi-rs passes (err, connId, buffer)
                (err, connId, buffer) => {
                    if (err) return;
                    const stream = this.connections.get(connId);
                    if (stream && buffer) stream._onNativeData(buffer);
                },
                // onClose: napi-rs passes (err, connId)
                (err, connId) => {
                    if (err) return;
                    this.log(`[Server] Connection ${connId} closed by remote`);
                    const stream = this.connections.get(connId);
                    if (stream) stream._onNativeClose();
                }
            );

            this.listening = true;
            this.log(`[Server] Listening on VPN port ${port}`);
            this.emit('listening');
            if (callback) callback();
        } catch (err) {
            if (this.listenerCount('error') > 0) this.emit('error', err);
            throw err;
        }
    }

    /** @internal */
    _forget(connId, stream) {
        if (this.connections.get(connId) === stream) this.connections.delete(connId);
    }

    address() {
        return { port: this.port, family: 'IPv4', address: '0.0.0.0' };
    }

    /**
     * Stops accepting connections and destroys all active connections.
     * @param {Function} [callback]
     */
    close(callback) {
        if (this._closed) {
            if (callback) process.nextTick(callback);
            return this;
        }
        this._closed = true;
        this.listening = false;
        for (const stream of Array.from(this.connections.values())) {
            stream.destroy();
        }
        this.connections.clear();
        process.nextTick(() => {
            this.emit('close');
            if (callback) callback();
        });
        return this;
    }
}

module.exports = { WireShadeServer, ServerSocket };
