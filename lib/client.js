const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

let binding;
try {
    binding = require('../wireshade.node');
} catch (e) {
    try {
        binding = require('../wireshade.win32-x64-msvc.node');
    } catch (e2) {
        throw new Error('Could not load native binding: ' + e2.message);
    }
}
const { WireShade } = binding;
const { WireShadeAgent } = require('./agent');
const { WireShadeServer } = require('./server');
const { readWireGuardConfig } = require('./config_parser');
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const dns = require('dns');

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
        this.hosts = config.hosts || {};
        this.agents = { http: null, https: null, tcp: null };
        this.servers = [];
        this.gw = null;

        // Connection state
        this.state = ConnectionState.DISCONNECTED;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.healthCheckTimer = null;

        // Reconnection config with defaults
        this.reconnectConfig = {
            enabled: config.reconnect?.enabled !== false,
            maxAttempts: config.reconnect?.maxAttempts ?? 10,
            delay: config.reconnect?.delay ?? 1000,
            maxDelay: config.reconnect?.maxDelay ?? 30000,
            backoffMultiplier: config.reconnect?.backoffMultiplier ?? 1.5,
            healthCheckInterval: config.reconnect?.healthCheckInterval ?? 30000
        };





        // Support for property-style callbacks
        if (config.onConnect) this.on('connect', config.onConnect);
        if (config.onDisconnect) this.on('disconnect', config.onDisconnect);
        if (config.onReconnect) this.on('reconnect', config.onReconnect);

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

    log(msg, ...args) {
        if (this.config.logging !== false) {
            console.log(msg, ...args);
        }
    }

    /**
     * Start the VPN connection
     * @returns {Promise<void>}
     */
    async start() {
        return new Promise((resolve, reject) => {
            // If already connected, resolve immediately
            if (this.state === ConnectionState.CONNECTED) {
                return resolve();
            }

            const onConnect = () => {
                cleanup();
                resolve();
            };

            const onError = (err) => {
                cleanup();
                reject(err);
            };

            const cleanup = () => {
                this.removeListener('connect', onConnect);
                this.removeListener('error', onError);
                // Also remove the disconnect listener we might catch during startup?
                // For simplicity, rely on error or connect.
            };

            this.once('connect', onConnect);
            // We might also want to catch immediate startup errors
            this.once('disconnect', (err) => {
                if (this.state !== ConnectionState.CONNECTED) {
                    cleanup();
                    reject(err || new Error("Disconnected during startup"));
                }
            });

            this._initNative();
        });
    }

    /**
     * Internal: Initialize native binding
     */
    _initNative() {
        this.state = ConnectionState.CONNECTING;
        this.emit('stateChange', this.state);

        try {
            // Create new native instance
            this.gw = new WireShade(
                this.config.wireguard.privateKey,
                this.config.wireguard.peerPublicKey,
                this.config.wireguard.presharedKey || "",
                this.config.wireguard.endpoint,
                this.config.wireguard.sourceIp
            );

            // Initialize/Update TCP Agent
            this.agents.tcp = new WireShadeAgent(this.gw, {
                keepAlive: true,
                logging: this.logging,
                onConnectionError: (err) => this._handleConnectionError(err)
            });

            // Reset cached agents
            this.agents.http = null;
            this.agents.https = null;

            // Simulate async handshake completion
            // Native currently doesn't expose a "Handshake Complete" event, 
            // so we assume success if no error occurs quickly.
            // Future improvement: Expose handshake state from Rust.
            setTimeout(() => {
                if (this.state === ConnectionState.CONNECTING) {
                    this._onConnected();
                }
            }, 1000); // Reduced to 1s for snappier feel

        } catch (err) {
            this.log('[WireShadeClient] Connection failed:', err.message);
            this._handleConnectionError(err);
        }
    }

    /**
     * Called when connection is established
     */
    _onConnected() {
        const wasReconnecting = this.state === ConnectionState.RECONNECTING;
        this.state = ConnectionState.CONNECTED;
        this.reconnectAttempts = 0;

        this.emit('stateChange', this.state);
        this.emit('connect');

        if (wasReconnecting) {
            this.log('[WireShadeClient] Reconnected successfully!');
            this.emit('reconnect');
            if (this.config.onReconnect) this.config.onReconnect();
        } else {
            this.log('[WireShadeClient] Connected!');
            if (this.config.onConnect) this.config.onConnect();
        }

        // Start health check
        this._startHealthCheck();
    }

    /**
     * Handle connection errors
     */
    _handleConnectionError(err) {
        this.log('[WireShadeClient] Connection error:', err?.message || err);

        if (this.state === ConnectionState.DISCONNECTED) {
            return; // Already closed
        }

        this.state = ConnectionState.DISCONNECTED;
        this.emit('stateChange', this.state);
        this.emit('disconnect', err);

        if (this.config.onDisconnect) this.config.onDisconnect(err);

        // Attempt reconnection if enabled
        if (this.reconnectConfig.enabled) {
            this._scheduleReconnect();
        }
    }

    /**
     * Schedule a reconnection attempt
     */
    _scheduleReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
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

        this.log(`[WireShadeClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.reconnectConfig.maxAttempts || '∞'})`);

        this.reconnectTimer = setTimeout(() => {
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
     * Manually trigger reconnection
     */
    reconnect() {
        this.log('[WireShadeClient] Manual reconnect triggered');
        this.reconnectAttempts = 0;
        this._stopHealthCheck();
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this._initNative();
    }

    getHttpAgent() {
        if (!this.agents.http) {
            this.agents.http = new http.Agent({
                keepAlive: true,
                lookup: this._customLookup.bind(this)
            });
            this.agents.http.createConnection = (options, cb) => {
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
                const rawSocket = this.agents.tcp.createConnection(options);
                const tlsOptions = {
                    ...options,
                    socket: rawSocket,
                    servername: options.hostname || options.host
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
                const tunnelSocket = this.agents.tcp.createConnection({
                    host: remoteHost,
                    port: remotePort
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
        if (this.hosts[hostname]) {
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
     * Start a TCP server listener on the VPN interface
     * @param {number} port
     * @param {Function} [onConnection] - (socket) => void
     * @returns {Promise<WireShadeServer>}
     */
    async listen(port, onConnection) {
        if (!this.gw) throw new Error("WireShade not initialized");

        const server = new WireShadeServer(this.gw, { logging: this.logging });

        if (onConnection) {
            server.on('connection', onConnection);
        }

        await server.listen(port);
        this.servers.push(server);
        return server;
    }

    /**
     * Perform an HTTP GET request
     * @param {string} url 
     * @param {Object} [options] 
     * @returns {Promise<string>} Body content
     */
    async get(url, options = {}) {
        return this.request(url, { ...options, method: 'GET' });
    }

    /**
     * Perform an HTTP request
     * @param {string} url 
     * @param {Object} [options] 
     * @returns {Promise<string>} Body content
     */
    request(urlStr, options = {}) {
        return new Promise((resolve, reject) => {
            const isHttps = urlStr.startsWith('https:');
            const agent = isHttps ? this.getHttpsAgent() : this.getHttpAgent();
            const mod = isHttps ? https : http;

            const req = mod.request(urlStr, { ...options, agent }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve(data));
            });

            req.on('error', reject);

            if (options.body) {
                req.write(options.body);
            }
            req.end();
        });
    }

    /**
     * Create a TCP connection through the tunnel
     * @param {Object} options - { host, port }
     * @returns {net.Socket}
     */
    connect(options, connectionListener) {
        if (!this.agents.tcp) throw new Error("WireShade not initialized");
        return this.agents.tcp.createConnection(options, connectionListener);
    }

    close() {
        this.state = ConnectionState.DISCONNECTED;
        this.reconnectConfig.enabled = false; // Prevent reconnection

        this._stopHealthCheck();
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

        if (this.agents.http) this.agents.http.destroy();
        if (this.agents.https) this.agents.https.destroy();
        if (this.agents.tcp) this.agents.tcp.destroy();
        this.servers.forEach(s => s.close());

        this.emit('stateChange', this.state);
        this.emit('close');

        if (this.config.onDisconnect) {
            this.config.onDisconnect();
        }
    }
}

module.exports = { WireShadeClient, ConnectionState };
