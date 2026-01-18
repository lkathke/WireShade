const http = require('http');
const { Duplex } = require('stream');
const dns = require('dns');

class WireShadeAgent extends http.Agent {
  constructor(wireShade, options) {
    super(options);
    this.gw = wireShade;
    this.options = options || {};

    // Configure Logger
    // Priority: options.logger -> console.log (unless logging===false)
    this.log = this.options.logger || (this.options.logging === false ? () => { } : console.log);
    this.error = this.options.logger || console.error;
  }
  createConnection(options, cb) {
    const { host, port } = options;
    const log = this.log;
    const error = this.error;

    log(`[Agent] Connecting to ${host}:${port}`);

    const stream = new Duplex({
      allowHalfOpen: true,
      read(size) { },
      write(chunk, encoding, callback) {
        log(`[AgentStream] write called with ${chunk.length} bytes`);
        if (this.connection) {
          log(`[AgentStream] Sending immediately...`);
          this.connection.send(chunk).then(() => {
            log(`[AgentStream] Send completed for ${chunk.length} bytes`);
            callback();
          }).catch((err) => {
            error(`[AgentStream] Send error:`, err);
            callback(err);
          });
        } else {
          log(`[AgentStream] Buffering - connection not ready yet`);
          if (!this.pendingBuffer) this.pendingBuffer = [];
          this.pendingBuffer.push({ chunk, callback });
        }
      }
    });

    // Mock Socket methods required by http.Agent/ClientRequest
    stream.setTimeout = (msecs, callback) => {
      if (callback) stream.once('timeout', callback);
      return stream;
    };
    stream.setNoDelay = (enable) => stream;
    stream.setKeepAlive = (enable, initialDelay) => stream;
    stream.ref = () => stream;
    stream.unref = () => stream;

    // Use custom lookup if provided in options (Standard node http.Agent behavior), else default dns.lookup
    const lookup = options.lookup || dns.lookup;

    lookup(host, { family: 4 }, (err, address, family) => {
      if (err) {
        return cb(err);
      }
      log(`[Agent] Resolved ${host} to ${address}`);

      this.gw.connect(address, parseInt(port),
        (err, data) => {
          const buffer = data || (Buffer.isBuffer(err) ? err : null);
          if (buffer) {
            log(`[Agent] Received ${buffer.length} bytes via connection`);
            stream.push(buffer);
          } else if (err && !data) {
            error('[Agent] Receive error:', err);
            stream.destroy(err);
          }
        },
        () => {
          stream.push(null);
        }
      ).then(conn => {
        log(`[Agent] Connected! Setting stream.connection...`);
        stream.connection = conn;
        stream.emit('connect');

        log(`[Agent] Checking pendingBuffer: ${stream.pendingBuffer ? stream.pendingBuffer.length + ' items' : 'none'}`);
        if (stream.pendingBuffer && stream.pendingBuffer.length > 0) {
          log(`[AgentStream] Flushing ${stream.pendingBuffer.length} buffered chunks`);
          const flushPromises = stream.pendingBuffer.map(({ chunk, callback }) => {
            log(`[AgentStream] Flushing chunk of ${chunk.length} bytes...`);
            return conn.send(chunk).then(() => {
              log(`[AgentStream] Flush completed for ${chunk.length} bytes`);
              callback();
            }).catch(err => {
              error(`[AgentStream] Flush error:`, err);
              callback(err);
            });
          });
          stream.pendingBuffer = null;
          Promise.all(flushPromises).then(() => {
            log(`[Agent] All buffered data flushed, calling cb`);
            if (cb) cb(null, stream);
          });
        } else {
          log(`[Agent] No buffered data, calling cb immediately`);
          if (cb) cb(null, stream);
        }
      }).catch(err => {
        error('[Agent] Connection failed:', err.message, err.code, err);
        if (cb) cb(err);
        else stream.emit('error', err);
      });
    });

    return stream;
  }
}

module.exports = { WireShadeAgent };
