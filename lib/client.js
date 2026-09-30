'use strict';

const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const dns = require('dns');
const { getBinding } = require('./binding');
const { WireShadeAgent } = require('./agent');
const { WireShadeServer } = require('./server');
const { readWireGuardConfig } = require('./config_parser');

const { WireShade } = getBinding();

/** Transport types understood by the high-level client. */
const TRANSPORT_UDP = 'udp';
const TRANSPORT_WEBSOCKET = 'websocket';

/** Default WireGuard PersistentKeepalive (seconds) if none is configured. 0 disables it. */
const DEFAULT_PERSISTENT_KEEPALIVE = 25;

/**
 * Connection states
 */
const ConnectionState = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting'
};

class WireShadeClient extends EventEmitter {
    /**
     * @param {Object|string} configOrPath - Config object OR path to .conf file
     * @param {Object} [options] - Additional options if using config path
     */
    constructor(configOrPath, options = {}) {
        super();

        let config = configOrPath;
        if (typeof configOrPath === 'string') {
            config = {
                ...options,
                wireguard: readWireGuardConfig(configOrPath)
            };
        }

        this.config = config;
        this.logging = config.logging !== false;
        this.hosts = config.hosts || {};
        this.agents = { http: null, https: null, tcp: null };
        this.servers = [];
        // Tracked listen() registrations (port + callback + options + current server),
        // so they can be re-created on a fresh gw after a reconnect (O2).
        this._listeners = [];
        this.gw = null;

        // Connection state
        this.state = ConnectionState.DISCONNECTED;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.healthCheckTimer = null;
        this._generation = 0;      // invalidates in-flight _initNative() runs
        this._closed = false;      // set by close(); stops auto-reconnect
        this._isReconnect = false; // current _initNative() run is a reconnect
        this._shutdownPromise = Promise.resolve();

        // Reconnection config with defaults
        this.reconnectConfig = {
            enabled: config.reconnect?.enabled !== false,
            maxAttempts: config.reconnect?.maxAttempts ?? 10,
            delay: config.reconnect?.delay ?? 1000,
            maxDelay: config.reconnect?.maxDelay ?? 30000,
            backoffMultiplier: config.reconnect?.backoffMultiplier ?? 1.5,
            healthCheckInterval: config.reconnect?.healthCheckInterval ?? 30000
        };

        // Property-style callbacks are registered as event listeners only and
        // are not invoked directly anywhere else -> each fires exactly once.
        if (typeof config.onConnect === 'function') this.on('connect', config.onConnect);
        if (typeof config.onDisconnect === 'function') this.on('disconnect', config.onDisconnect);
        if (typeof config.onReconnect === 'function') this.on('reconnect', config.onReconnect);

        // Pre-create wrappers (lazy or eager)
        this._httpWrapper = this._wrapModule(http, () => this.getHttpAgent());
        this._httpsWrapper = this._wrapModule(https, () => this.getHttpsAgent());
    }

    /**
     * Access the `http` module wrapper that routes requests through VPN
     */
    get http() { return this._httpWrapper; }

    /**
     * Access the `https` module wrapper that routes requests through VPN
     */
    get https() { return this._httpsWrapper; }

    set onConnect(cb) { this.on('connect', cb); }
    set onDisconnect(cb) { this.on('disconnect', cb); }
    set onReconnect(cb) { this.on('reconnect', cb); }

    log(msg, ...args) {
        if (this.logging) {
            console.log(msg, ...args);
        }
    }

    /**
     * Start the VPN connection.
     * Resolves once the WireGuard handshake with the peer has completed.
     * Rejects if the first connection attempt fails (auto-reconnect, if
     * enabled, continues in the background) or if close() is called first.
     * @returns {Promise<void>}
     */
    start() {
        return new Promise((resolve, reject) => {
            if (this.state === ConnectionState.CONNECTED) {
                return resolve();
            }

            const cleanup = () => {
                this.removeListener('connect', onConnect);
                this.removeListener('disconnect', onDisconnect);
                this.removeListener('close', onClose);
            };
            const onConnect = () => {
                cleanup();
                resolve();
            };
            const onDisconnect = (err) => {
                cleanup();
                reject(err || new Error('Disconnected during startup'));
            };
            const onClose = () => {
                cleanup();
                reject(new Error('Client was closed before the connection was established'));
            };

            this.on('connect', onConnect);
            this.on('disconnect', onDisconnect);
            this.on('close', onClose);

            // Already connecting (start() called twice, or auto-reconnect running): just wait.
            if (this.state === ConnectionState.CONNECTING || this.state === ConnectionState.RECONNECTING) {
                return;
            }

            this._closed = false;
            this._initNative();
        });
    }

    /**
     * Shut down a native instance (idempotent, never rejects).
     * @returns {Promise<void>}
     */
    _shutdownGw(gw) {
        if (!gw || typeof gw.shutdown !== 'function') return Promise.resolve();
        try {
            return Promise.resolve(gw.shutdown()).catch((err) => {
                this.log('[WireShadeClient] Shutdown error:', err?.message || err);
            });
        } catch (err) {
            return Promise.resolve();
        }
    }

    /**
     * Tear down the current native instance and the agents bound to it.
     * @returns {Promise<void>} resolves when all native tasks shut down so far have stopped
     */
    _teardownNative() {
        if (this.agents.http) this.agents.http.destroy();
        if (this.agents.https) this.agents.https.destroy();
        if (this.agents.tcp) this.agents.tcp.destroy();
        this.agents.http = null;
        this.agents.https = null;
        this.agents.tcp = null;

        const gw = this.gw;
        this.gw = null;
        if (gw) {
            const prev = this._shutdownPromise;
            this._shutdownPromise = Promise.all([prev, this._shutdownGw(gw)]).then(() => { });
        }
        return this._shutdownPromise;
    }

    /** PersistentKeepalive in seconds for the native ctor (null = disabled). */
    _persistentKeepalive() {
        const wg = this.config.wireguard || {};
        let value = wg.persistentKeepalive ?? this.config.persistentKeepalive;
        if (value === undefined || value === null) value = DEFAULT_PERSISTENT_KEEPALIVE;
        value = Number(value);
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
            throw new Error(`Invalid persistentKeepalive: ${value} (expected 0-65535 seconds)`);
        }
        return value === 0 ? null : value;
    }

    /**
     * Internal: build a native WireShade instance for the configured transport.
     * Called on the initial connect AND on every reconnect, so the correct gw
     * type (UDP / WS client / WS server) is recreated each time.
     * @returns {Object} native WireShade instance
     */
    _buildGw() {
        const wg = this.config.wireguard;
        if (!wg) throw new Error('Missing "wireguard" configuration');

        const transport = this.config.transport || {};
        const type = String(transport.type || TRANSPORT_UDP).toLowerCase();
        const keepalive = this._persistentKeepalive();

        // Optional per-connection TCP window (bytes). undefined = native default
        // (512 KiB); read from config.tcpBufferSize or transport.tcpBufferSize.
        const tcpBufferSize = this.config.tcpBufferSize ?? transport.tcpBufferSize;

        // Default transport: UDP, i.e. today's positional constructor. The 8th
        // arg (tcpBufferSize) is optional; undefined keeps the native default.
        if (type === TRANSPORT_UDP) {
            return new WireShade(
                wg.privateKey,
                wg.peerPublicKey,
                wg.presharedKey || null,
                wg.endpoint,
                wg.sourceIp,
                wg.listenPort || null,
                keepalive,
                tcpBufferSize
            );
        }

        if (type === TRANSPORT_WEBSOCKET || type === 'ws') {
            // Options common to both WS roles, mapped from wireguard + transport.
            // Optional fields are only added when set: the native binding expects
            // them omitted, not passed as null.
            const base = {
                privateKey: wg.privateKey,
                peerPublicKey: wg.peerPublicKey,
                sourceIp: wg.sourceIp
            };
            if (wg.presharedKey) base.presharedKey = wg.presharedKey;
            if (keepalive != null) base.persistentKeepalive = keepalive;
            if (transport.pathPrefix != null) base.pathPrefix = transport.pathPrefix;
            if (transport.keepaliveSec != null) base.keepaliveSec = transport.keepaliveSec;
            if (transport.tls != null) base.tls = transport.tls;
            if (tcpBufferSize != null) base.tcpBufferSize = tcpBufferSize;

            const role = String(transport.role || 'client').toLowerCase();
            if (role === 'server') {
                if (typeof WireShade.wsServer !== 'function') {
                    throw new Error('This native binding does not support the WebSocket server transport');
                }
                if (!transport.listen) {
                    throw new Error('transport.listen ("host:port") is required for a websocket server');
                }
                base.listen = transport.listen;
                return WireShade.wsServer(base);
            }

            // Client (default). The WG endpoint is irrelevant: the server
            // terminates the tunnel, so it is not required here.
            if (typeof WireShade.wsClient !== 'function') {
                throw new Error('This native binding does not support the WebSocket client transport');
            }
            if (!transport.url) {
                throw new Error('transport.url ("ws://…" or "wss://…") is required for a websocket client');
            }
            base.url = transport.url;
            if (transport.headers != null) base.headers = transport.headers;

            const mode = transport.mode != null ? String(transport.mode).toLowerCase() : null;
            if (mode != null) base.mode = mode;
            if (mode === 'wstunnel') {
                // In wstunnel mode the server forwards to the real WireGuard
                // endpoint (r/rp in the JWT). Take it from transport.remoteHost/
                // remotePort, else parse it from the WireGuard endpoint.
                let rh = transport.remoteHost;
                let rp = transport.remotePort;
                if ((rh == null || rp == null) && wg.endpoint) {
                    const i = String(wg.endpoint).lastIndexOf(':');
                    if (i !== -1) {
                        if (rh == null) rh = wg.endpoint.slice(0, i);
                        if (rp == null) rp = parseInt(wg.endpoint.slice(i + 1), 10);
                    }
                }
                if (rh != null) base.remoteHost = rh;
                if (rp != null) base.remotePort = rp;
            }
            return WireShade.wsClient(base);
        }

        throw new Error(`Unknown transport type: ${transport.type}`);
    }

    /**
     * Internal: (re)create the native instance and wait for the WireGuard handshake.
     */
    async _initNative(isReconnect = false) {
        const gen = ++this._generation;
        this._isReconnect = isReconnect || this.state === ConnectionState.RECONNECTING || this.reconnectAttempts > 0;
        this.state = ConnectionState.CONNECTING;
        this.emit('stateChange', this.state);
        this._stopHealthCheck();

        try {
            // The previous instance (UDP socket, timers) must be gone before
            // the same listen port is bound again.
            await this._teardownNative();
            if (gen !== this._generation) return;

            const gw = this._buildGw();
            this.gw = gw;

            this.agents.tcp = new WireShadeAgent(gw, {
                keepAlive: true,
                logging: this.logging
            });

            // The native tunnel is built and (for a WS server) bound. This fires
            // on every (re)connect, before the WireGuard handshake completes, so a
            // server-role wrapper can resolve start() once it is listening for a
            // peer instead of waiting for one to hand-shake.
            this.emit('transportReady', gw);

            const timeout = this.config.handshakeTimeout ?? this.config.wireguard?.handshakeTimeout;
            await (timeout != null ? gw.waitForHandshake(timeout) : gw.waitForHandshake());

            if (gen !== this._generation) return; // closed / superseded meanwhile
            this._onConnected();
            this._watchDisconnect(gen, gw);
        } catch (err) {
            if (gen !== this._generation) return;
            this._handleConnectionError(err);
        }
    }

    /**
     * Called when connection is established
     */
    _onConnected() {
        const wasReconnecting = this._isReconnect;
        this._isReconnect = false;
        this.state = ConnectionState.CONNECTED;
        this.reconnectAttempts = 0;

        this.emit('stateChange', this.state);
        this.log(wasReconnecting ? '[WireShadeClient] Reconnected successfully!' : '[WireShadeClient] Connected!');
        this.emit('connect');
        if (wasReconnecting) {
            this.emit('reconnect');
            // The old native instance is gone; re-create every tracked listener
            // on the new gw so servers (incl. forwardRemote) survive the reconnect.
            this._rebuildListeners();
        }

        this._startHealthCheck();
    }

    /**
     * O1: After a successful handshake, watch for the WireGuard session dropping.
     * `waitForDisconnect()` resolves when the native watch-state leaves `Ready`
     * (and immediately after shutdown). If the drop was NOT caused by close() or a
     * superseding (re)connect, funnel it into the normal reconnect path.
     *
     * @param {number} gen generation this watcher belongs to (see _generation)
     * @param {Object} gw  native instance this watcher belongs to
     */
    _watchDisconnect(gen, gw) {
        // Feature-detect: the native method may not exist yet (older binary).
        if (!gw || typeof gw.waitForDisconnect !== 'function') return;

        let promise;
        try {
            promise = gw.waitForDisconnect();
        } catch (_) {
            return;
        }

        const onDrop = (err) => {
            // Stale watcher: a newer connect/reconnect ran (gen bumped), the client
            // was closed, or this gw was already torn down/replaced. Do nothing so
            // the promise cannot leak an error across reconnects/close.
            if (gen !== this._generation || this._closed) return;
            if (gw !== this.gw || this.state !== ConnectionState.CONNECTED) return;
            this.log('[WireShadeClient] Tunnel lost (WireGuard session dropped)');
            this._handleConnectionError(err || new Error('tunnel lost'));
        };

        Promise.resolve(promise).then(
            () => onDrop(new Error('tunnel lost')),
            (err) => onDrop(err instanceof Error ? err : new Error('tunnel lost'))
        );
    }

    /**
     * Handle connection errors
     */
    _handleConnectionError(err) {
        this.log('[WireShadeClient] Connection error:', err?.message || err);

        if (this._closed || this.state === ConnectionState.DISCONNECTED) {
            return; // Already closed
        }

        this._stopHealthCheck();
        this._teardownNative();

        this.state = ConnectionState.DISCONNECTED;
        this.emit('stateChange', this.state);
        this.emit('disconnect', err);

        // Attempt reconnection if enabled (and no listener closed the client)
        if (this.reconnectConfig.enabled && !this._closed) {
            this._scheduleReconnect();
        }
    }

    /**
     * Schedule a reconnection attempt
     */
    _scheduleReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Check max attempts
        if (this.reconnectConfig.maxAttempts > 0 &&
            this.reconnectAttempts >= this.reconnectConfig.maxAttempts) {
            this.log('[WireShadeClient] Max reconnection attempts reached');
            this.emit('reconnectFailed');
            return;
        }

        // Calculate delay with exponential backoff
        const delay = Math.min(
            this.reconnectConfig.delay * Math.pow(this.reconnectConfig.backoffMultiplier, this.reconnectAttempts),
            this.reconnectConfig.maxDelay
        );

        this.reconnectAttempts++;
        this.state = ConnectionState.RECONNECTING;
        this.emit('stateChange', this.state);

        this.log(`[WireShadeClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.reconnectConfig.maxAttempts || 'unlimited'})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this._closed) return;
            this.emit('reconnecting', this.reconnectAttempts);
            this._initNative();
        }, delay);
    }

    /**
     * Start periodic health checks
     */
    _startHealthCheck() {
        this._stopHealthCheck();

        if (this.reconnectConfig.healthCheckInterval > 0) {
            this.healthCheckTimer = setInterval(() => {
                this._performHealthCheck();
            }, this.reconnectConfig.healthCheckInterval);
        }
    }

    /**
     * Stop health checks
     */
    _stopHealthCheck() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }

    /**
     * Perform a health check (attempt a simple operation)
     */
    async _performHealthCheck() {
        // For now, we rely on the WireGuard keepalives
        // Future: Could ping a known VPN host
        this.emit('healthCheck');
    }

    /**
     * Manually trigger reconnection. The old native instance is shut down first.
     * @returns {Promise<void>} settles when the attempt finished (success or failure;
     * failures are reported via the 'disconnect' event)
     */
    reconnect() {
        this.log('[WireShadeClient] Manual reconnect triggered');
        this._closed = false;
        this.reconnectAttempts = 0;
        this._stopHealthCheck();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        return this._initNative(true);
    }

    getHttpAgent() {
        if (!this.agents.http) {
            this.agents.http = new http.Agent({
                keepAlive: true,
                lookup: this._customLookup.bind(this)
            });
            this.agents.http.createConnection = (options, cb) => {
                if (!this.agents.tcp) {
                    throw new Error("WireShade connection not started. Please await client.start() first.");
                }
                return this.agents.tcp.createConnection(options, cb);
            };
        }
        return this.agents.http;
    }

    getHttpsAgent() {
        if (!this.agents.https) {
            this.agents.https = new https.Agent({
                keepAlive: true,
                lookup: this._customLookup.bind(this),
            });

            this.agents.https.createConnection = (options, cb) => {
                if (!this.agents.tcp) {
                    throw new Error("WireShade connection not started. Please await client.start() first.");
                }
                const rawSocket = this.agents.tcp.createConnection(options);
                const tlsOptions = {
                    ...options,
                    socket: rawSocket,
                    servername: options.servername || options.hostname || options.host
                };
                return tls.connect(tlsOptions, cb);
            };
        }
        return this.agents.https;
    }

    addHost(hostname, ip) {
        this.hosts[hostname] = ip;
    }

    async forwardLocal(localPort, remoteHost, remotePort) {
        return new Promise((resolve, reject) => {
            const server = net.createServer((clientSocket) => {
                if (!this.agents.tcp) {
                    clientSocket.destroy();
                    return;
                }
                const tunnelSocket = this.agents.tcp.createConnection({
                    host: remoteHost,
                    port: remotePort,
                    lookup: this._customLookup.bind(this)
                });

                clientSocket.pipe(tunnelSocket);
                tunnelSocket.pipe(clientSocket);

                const cleanup = () => {
                    clientSocket.destroy();
                    tunnelSocket.destroy();
                };
                clientSocket.on('error', cleanup);
                tunnelSocket.on('error', cleanup);
                clientSocket.on('close', cleanup);
                tunnelSocket.on('close', cleanup);
            });

            server.listen(localPort, () => {
                this.servers.push(server);
                resolve(server);
            });

            server.on('error', reject);
        });
    }

    /**
     * Listen on a VPN port and forward all traffic to a local destination (Reverse Port Forwarding).
     * @param {number} vpnPort - The port to listen on inside the VPN.
     * @param {string} targetHost - The local host to forward to (e.g., 'localhost').
     * @param {number} targetPort - The local port to forward to.
     * @returns {Promise<WireShadeServer>}
     */
    async forwardRemote(vpnPort, targetHost, targetPort) {
        return this.listen(vpnPort, (vpnSocket) => {
            const localSocket = net.connect(targetPort, targetHost, () => {
                // Pipe data between VPN socket and Local socket
                vpnSocket.pipe(localSocket);
                localSocket.pipe(vpnSocket);
            });

            const cleanup = () => {
                vpnSocket.destroy();
                localSocket.destroy();
            };

            vpnSocket.on('error', cleanup);
            localSocket.on('error', cleanup);
            vpnSocket.on('close', cleanup);
            localSocket.on('close', cleanup);
        });
    }

    _customLookup(hostname, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        if (this.hosts[hostname]) {
            if (options && options.all) {
                return callback(null, [{ address: this.hosts[hostname], family: 4 }]);
            }
            return callback(null, this.hosts[hostname], 4);
        }
        dns.lookup(hostname, options, callback);
    }

    /**
     * Internal: Wrap http/https module to inject agent
     */
    _wrapModule(module, agentGetter) {
        const wrapper = { ...module };

        wrapper.request = (...args) => {
            // Determine where options object is
            let options = typeof args[0] === 'string' || args[0] instanceof URL
                ? args[1]
                : args[0];

            // Handle case where options is actually callback (if valid usage) or missing
            if (typeof options === 'function' || !options) {
                options = {};
                if (typeof args[0] === 'string' || args[0] instanceof URL) {
                    if (typeof args[1] === 'function') {
                        return module.request(args[0], { agent: agentGetter() }, args[1]);
                    } else if (!args[1]) {
                        return module.request(args[0], { agent: agentGetter() });
                    }
                } else {
                    return module.request({ ...args[0], agent: agentGetter() }, args[1]);
                }
            }

            // If we are here, options exists and is an object.
            const newOptions = { ...options, agent: agentGetter() };

            if (typeof args[0] === 'string' || args[0] instanceof URL) {
                return module.request(args[0], newOptions, args[2]);
            } else {
                return module.request(newOptions, args[1]);
            }
        };

        wrapper.get = (...args) => {
            const req = wrapper.request(...args);
            req.end();
            return req;
        };

        return wrapper;
    }

    /**
     * Start a TCP server listener on the VPN interface.
     * The registration is tracked so the listener is automatically re-created on
     * the new native instance after a reconnect (O2).
     * @param {number} port
     * @param {Function} [onConnection] - (socket) => void
     * @param {Object} [options] - forwarded to WireShadeServer
     * @returns {Promise<WireShadeServer>}
     */
    async listen(port, onConnection, options = {}) {
        if (!this.gw) throw new Error("WireShade not initialized");

        const entry = { port, onConnection, options, server: null };
        const server = await this._createServer(entry);
        this._listeners.push(entry);
        return server;
    }

    /**
     * Internal: create (or re-create) a tracked server on the current gw.
     * @param {{port:number,onConnection?:Function,options:Object,server:?WireShadeServer}} entry
     * @returns {Promise<WireShadeServer>}
     */
    async _createServer(entry) {
        const server = new WireShadeServer(this.gw, { logging: this.logging, ...entry.options });

        if (entry.onConnection) {
            server.on('connection', entry.onConnection);
        }

        await server.listen(entry.port);
        entry.server = server;
        this.servers.push(server);

        // A user-initiated close() (not our reconnect rebuild) stops tracking this
        // listener so it does NOT come back on the next reconnect.
        server.once('close', () => {
            if (server._wsRebuilding) return; // closed by _rebuildListeners()
            const li = this._listeners.indexOf(entry);
            if (li !== -1) this._listeners.splice(li, 1);
            const si = this.servers.indexOf(server);
            if (si !== -1) this.servers.splice(si, 1);
        });

        return server;
    }

    /**
     * Internal (O2): re-create every tracked listener on the new gw after a
     * reconnect. Stale server objects are closed quietly; listeners the user
     * closed in the meantime are no longer tracked and are skipped.
     */
    _rebuildListeners() {
        for (const entry of this._listeners.slice()) {
            if (this._listeners.indexOf(entry) === -1) continue; // user-closed meanwhile

            const stale = entry.server;
            entry.server = null;
            if (stale) {
                stale._wsRebuilding = true; // suppress the user-close bookkeeping above
                const si = this.servers.indexOf(stale);
                if (si !== -1) this.servers.splice(si, 1);
                try { stale.close(); } catch (_) { /* quiet */ }
            }

            this._createServer(entry).catch((err) => {
                this.log(`[WireShadeClient] Failed to re-listen on port ${entry.port} after reconnect: ${err?.message || err}`);
            });
        }
    }

    /**
     * Perform an HTTP GET request
     * @param {string} url
     * @param {Object} [options] - see request()
     * @returns {Promise<string|Object>}
     */
    async get(url, options = {}) {
        return this.request(url, { ...options, method: 'GET' });
    }

    /**
     * Perform an HTTP(S) request through the tunnel.
     * @param {string|URL} urlStr
     * @param {Object} [options] - http.request options plus:
     *   - body: string|Buffer request body
     *   - encoding: body encoding for the resolved string (default 'utf8')
     *   - fullResponse: if true, resolve with
     *       { statusCode, statusMessage, headers, body: string, rawBody: Buffer }
     * @returns {Promise<string|Object>} body string (default) or full response object
     */
    request(urlStr, options = {}) {
        return new Promise((resolve, reject) => {
            const { body, fullResponse, encoding = 'utf8', ...requestOptions } = options;
            const isHttps = String(urlStr).startsWith('https:');
            const agent = isHttps ? this.getHttpsAgent() : this.getHttpAgent();
            const mod = isHttps ? https : http;

            let settled = false;
            const fail = (err) => {
                if (settled) return;
                settled = true;
                reject(err);
            };

            const req = mod.request(urlStr, { ...requestOptions, agent }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('error', fail);
                res.on('aborted', () => fail(new Error('Response aborted')));
                res.on('close', () => {
                    if (!res.complete) fail(new Error('Connection closed before the response was complete'));
                });
                res.on('end', () => {
                    if (settled) return;
                    settled = true;
                    const rawBody = Buffer.concat(chunks);
                    const text = rawBody.toString(encoding);
                    if (fullResponse) {
                        resolve({
                            statusCode: res.statusCode,
                            statusMessage: res.statusMessage,
                            headers: res.headers,
                            body: text,
                            rawBody
                        });
                    } else {
                        resolve(text);
                    }
                });
            });

            req.on('error', fail);

            if (body !== undefined && body !== null) {
                req.write(body);
            }
            req.end();
        });
    }

    /**
     * Create a TCP connection through the tunnel
     * @param {Object} options - { host, port }
     * @param {Function} [connectionListener] - called as (null, socket) once connected
     * @returns {import('stream').Duplex} socket-like stream; errors are emitted as 'error'
     */
    connect(options, connectionListener) {
        if (!this.agents.tcp) throw new Error("WireShade not initialized");
        return this.agents.tcp.createConnection(
            { lookup: this._customLookup.bind(this), ...options },
            connectionListener
        );
    }

    /**
     * Start a SOCKS5 proxy that routes every accepted connection through the tunnel.
     * Point any SOCKS5-aware app at it (browser, curl --socks5-hostname, proxychains).
     * @param {number} port
     * @param {string} [host='127.0.0.1']
     * @param {Object} [options] - { auth, logging } (see WireShadeSocksServer)
     * @returns {Promise<import('./socks_server').WireShadeSocksServer>}
     */
    async socks(port, host = '127.0.0.1', options = {}) {
        if (!this.agents.tcp) throw new Error("WireShade not initialized. Await start() first.");
        const { WireShadeSocksServer } = require('./socks_server');
        const server = new WireShadeSocksServer(this, options);
        await server.listen(port, host);
        this.servers.push(server);
        return server;
    }

    /**
     * Ping a remote host via ICMP
     * @param {string} ip - IP address to ping
     * @returns {Promise<number>} Round trip time in milliseconds
     */
    ping(ip) {
        if (!this.gw) return Promise.reject(new Error("WireShade not initialized"));
        return this.gw.ping(ip);
    }

    /**
     * Close the client: stops reconnects/health checks, closes all servers and
     * connections and shuts down the native tunnel.
     * @returns {Promise<void>} resolves when the native task has stopped
     */
    close() {
        const wasConnected = this.state === ConnectionState.CONNECTED;
        const wasClosed = this._closed && this.state === ConnectionState.DISCONNECTED;

        this._closed = true;
        this._generation++; // invalidate in-flight connection attempts
        this._isReconnect = false;
        this.state = ConnectionState.DISCONNECTED;

        this._stopHealthCheck();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this._listeners = []; // stop tracking; nothing should be rebuilt after close()
        this.servers.forEach(s => s.close());
        this.servers = [];
        const done = this._teardownNative();

        if (!wasClosed) {
            this.emit('stateChange', this.state);
            if (wasConnected) this.emit('disconnect');
            this.emit('close');
        }

        return done;
    }
}

module.exports = { WireShadeClient, ConnectionState };
