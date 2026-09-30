'use strict';

// Mock native binding for the JS-layer tests (O1/O2/O3).
//
// Loaded via WIRESHADE_NATIVE_PATH so `require()` returns this module in place
// of the real .node addon (see lib/binding.js). It implements the same method
// surface as NativeWireShade, including the new contract methods that the real
// binary does not have yet:
//   - waitForDisconnect(): Promise<void>   (O1)
//   - pauseConnection(id) / resumeConnection(id): Promise<void>   (O3)
//
// Extra helpers prefixed with `_test` let the tests drive the mock:
//   - MockWireShade.instances : every instance created, newest last
//   - inst._testDrop()              : simulate a WireGuard session loss
//   - inst._testIncoming(port, ...) : simulate an inbound connection on a listener
//   - inst.paused / inst.resumed    : ids passed to pause/resume (O3)

const noop = () => {};

class MockConnection {
    constructor(id) {
        this.id = id;
    }
    send() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
}

class MockWireShade {
    constructor(privateKey, peerPublicKey, presharedKey, endpoint, sourceIp, listenPort, keepalive) {
        this.args = { privateKey, peerPublicKey, presharedKey, endpoint, sourceIp, listenPort, keepalive };
        this._shutdown = false;
        this._connSeq = 1;
        this._listeners = new Map(); // port -> { onConnection, onData, onClose }
        this._disconnectResolvers = [];
        this.paused = [];   // connection ids passed to pauseConnection()
        this.resumed = [];  // connection ids passed to resumeConnection()
        MockWireShade.instances.push(this);
    }

    waitForHandshake(_timeout) {
        return this._shutdown
            ? Promise.reject(new Error('shutdown'))
            : Promise.resolve();
    }

    // O1 contract: resolves when the watch-state leaves Ready (or after shutdown).
    waitForDisconnect() {
        if (this._shutdown) return Promise.resolve();
        return new Promise((resolve) => this._disconnectResolvers.push(resolve));
    }

    shutdown() {
        this._shutdown = true;
        const rs = this._disconnectResolvers.splice(0);
        rs.forEach((r) => r());
        return Promise.resolve();
    }

    connect(destIp, destPort, _onData, _onClose) {
        if (this._shutdown) return Promise.reject(new Error('shutdown'));
        return Promise.resolve(new MockConnection(this._connSeq++));
    }

    listen(port, onConnection, onData, onClose) {
        if (this._shutdown) return Promise.reject(new Error('shutdown'));
        this._listeners.set(port, { onConnection, onData, onClose });
        return Promise.resolve();
    }

    sendTo(_id, _data) { return Promise.resolve(); }
    closeConnection(_id) { return Promise.resolve(); }
    ping(_ip) { return Promise.resolve(0); }

    // O3 contract.
    pauseConnection(id) { this.paused.push(id); return Promise.resolve(); }
    resumeConnection(id) { this.resumed.push(id); return Promise.resolve(); }

    // ---- test helpers -----------------------------------------------------
    _testDrop() {
        const rs = this._disconnectResolvers.splice(0);
        rs.forEach((r) => r());
    }

    _testIncoming(port, remoteIp = '10.0.0.9', remotePort = 40000) {
        const l = this._listeners.get(port);
        if (!l) throw new Error(`mock: no listener on port ${port}`);
        const connId = this._connSeq++;
        l.onConnection(null, connId, remoteIp, remotePort);
        return connId;
    }
}

MockWireShade.instances = [];

module.exports = { WireShade: MockWireShade, MockWireShade, MockConnection };
