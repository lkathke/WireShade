'use strict';

/**
 * Adds the subset of the net.Socket API that http.Agent / http.Server /
 * tls.connect expect, to a tunnel Duplex stream.
 * @param {import('stream').Duplex} stream
 */
function addSocketShims(stream) {
    let idleTimer = null;
    let idleMs = 0;

    const clearIdle = () => {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    };
    const armIdle = () => {
        clearIdle();
        if (idleMs > 0 && !stream.destroyed) {
            idleTimer = setTimeout(() => stream.emit('timeout'), idleMs);
            if (typeof idleTimer.unref === 'function') idleTimer.unref();
        }
    };

    stream.setTimeout = (msecs, callback) => {
        idleMs = Number(msecs) || 0;
        if (callback) {
            if (idleMs > 0) stream.once('timeout', callback);
            else stream.removeListener('timeout', callback);
        }
        armIdle();
        return stream;
    };
    stream._touchIdle = () => { if (idleMs > 0) armIdle(); };
    stream.once('close', clearIdle);

    stream.setNoDelay = () => stream;
    stream.setKeepAlive = () => stream;
    stream.ref = () => stream;
    stream.unref = () => stream;
    stream.address = () => ({ address: stream.localAddress || '0.0.0.0', family: 'IPv4', port: stream.localPort || 0 });
    stream.remoteFamily = 'IPv4';
    stream.connecting = false;
    stream.encrypted = false;
    return stream;
}

module.exports = { addSocketShims };
