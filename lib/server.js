const { Duplex } = require('stream');
const EventEmitter = require('events');

/**
 * WireShadeServer - A server that listens on a port inside the VPN tunnel.
 */
class WireShadeServer extends EventEmitter {
    constructor(gw, options = {}) {
        super();
        this.gw = gw;
        this.options = options;
        this.logging = options.logging !== false;
        this.log = this.logging ? console.log : () => { };
        this.connections = new Map();
        this.port = null;
        this.listening = false;
    }

    async listen(port, callback) {
        this.port = port;

        try {
            await this.gw.listen(
                port,
                // onConnection: napi-rs passes (err, connId, remoteIp, remotePort)
                (err, connId, remoteIp, remotePort) => {
                    if (err) {
                        this.log(`[Server] Connection error: ${err}`);
                        return;
                    }
                    this.log(`[Server] New connection ${connId} from ${remoteIp}:${remotePort}`);

                    const stream = this._createStream(connId);
                    stream.remoteAddress = remoteIp;
                    stream.remotePort = remotePort;
                    this.connections.set(connId, { stream });
                    this.emit('connection', stream, { remoteAddress: remoteIp, remotePort });
                },
                // onData: napi-rs passes (err, connId, buffer)
                (err, connId, buffer) => {
                    if (err) return;
                    const conn = this.connections.get(connId);
                    if (conn && conn.stream && buffer) {
                        this.log(`[Server] Received ${buffer.length} bytes on conn ${connId}`);
                        conn.stream.push(buffer);
                    }
                },
                // onClose: napi-rs passes (err, connId)
                (err, connId) => {
                    if (err) return;
                    this.log(`[Server] Connection ${connId} closed`);
                    const conn = this.connections.get(connId);
                    if (conn && conn.stream) {
                        conn.stream.push(null);
                        conn.stream.emit('close');
                        this.connections.delete(connId);
                    }
                }
            );

            this.listening = true;
            this.log(`[Server] Listening on VPN port ${port}`);
            this.emit('listening');
            if (callback) callback();
        } catch (err) {
            this.emit('error', err);
            throw err;
        }
    }

    _createStream(connId) {
        const self = this;
        const log = this.log;

        const stream = new Duplex({
            allowHalfOpen: true,
            read(size) { },
            write(chunk, encoding, callback) {
                log(`[Server] Writing ${chunk.length} bytes to conn ${connId}`);
                self.gw.sendTo(connId, chunk)
                    .then(() => callback())
                    .catch((err) => {
                        log(`[Server] Write error: ${err}`);
                        callback(err);
                    });
            }
        });

        stream.remoteAddress = null;
        stream.remotePort = null;
        stream.connId = connId;

        stream.end = (data, encoding, callback) => {
            const finish = () => {
                self.gw.closeConnection(connId).catch(() => { });
                self.connections.delete(connId);
                if (callback) callback();
            };
            if (data) {
                stream.write(data, encoding, finish);
            } else {
                finish();
            }
        };

        stream.destroy = () => {
            self.gw.closeConnection(connId).catch(() => { });
            self.connections.delete(connId);
        };

        return stream;
    }

    close(callback) {
        this.listening = false;
        this.emit('close');
        if (callback) callback();
    }
}

module.exports = { WireShadeServer };
