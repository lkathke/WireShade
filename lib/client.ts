import EventEmitter from "events";
import http from "http";
import https from "https";
import tls from "tls";
import net from "net";
import dns from "dns";
import { Duplex } from "stream";
import { WireShadeAgent } from "./agent";
import { WireShadeServer } from "./server";
import { readWireGuardConfig } from "./config_parser";
import type {
  ClientConfig,
  ReconnectConfig,
  ConnectionState,
  NativeWireShade as NativeWireShadeType,
  AgentRecord,
  HttpWrapper,
} from "./types";

let binding: { WireShade: new (...args: any[]) => NativeWireShadeType };
try {
  binding = require("../wireshade.node");
} catch (e) {
  try {
    binding = require("../wireshade.win32-x64-msvc.node");
  } catch (e2: any) {
    throw new Error("Could not load native binding: " + e2.message);
  }
}
const { WireShade: NativeWireShadeClass } = binding;

export const ConnectionStateValue = {
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  RECONNECTING: "reconnecting",
} as const;

export class WireShadeClient extends EventEmitter {
  public config: ClientConfig;
  private hosts: Record<string, string>;
  private agents: AgentRecord;
  private servers: (WireShadeServer | net.Server)[];
  private gw: NativeWireShadeType | null;

  public state: ConnectionState;
  private reconnectAttempts: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null;
  private reconnectConfig: ReconnectConfig;

  private _httpWrapper: HttpWrapper;
  private _httpsWrapper: HttpWrapper;

  private logging: boolean;

  constructor(
    configOrPath: ClientConfig | string,
    options: Partial<ClientConfig> = {},
  ) {
    super();

    let config: ClientConfig = configOrPath as ClientConfig;
    if (typeof configOrPath === "string") {
      config = {
        ...options,
        wireguard: readWireGuardConfig(configOrPath),
      };
    }

    this.config = config;
    this.hosts = config.hosts || {};
    this.agents = { http: null, https: null, tcp: null };
    this.servers = [];
    this.gw = null;
    this.logging = config.logging !== false;

    this.state = "disconnected" as ConnectionState;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.healthCheckTimer = null;

    this.reconnectConfig = {
      enabled: config.reconnect?.enabled !== false,
      maxAttempts: config.reconnect?.maxAttempts ?? 10,
      delay: config.reconnect?.delay ?? 1000,
      maxDelay: config.reconnect?.maxDelay ?? 30000,
      backoffMultiplier: config.reconnect?.backoffMultiplier ?? 1.5,
      healthCheckInterval: config.reconnect?.healthCheckInterval ?? 30000,
    };

    if (config.onConnect) this.on("connect", config.onConnect);
    if (config.onDisconnect) this.on("disconnect", config.onDisconnect);
    if (config.onReconnect) this.on("reconnect", config.onReconnect);

    this._httpWrapper = this._wrapModule(http, () => this.getHttpAgent());
    this._httpsWrapper = this._wrapModule(https, () => this.getHttpsAgent());
  }

  get http(): HttpWrapper {
    return this._httpWrapper;
  }
  get https(): HttpWrapper {
    return this._httpsWrapper;
  }

  set onConnect(cb: () => void) {
    this.on("connect", cb);
  }
  set onDisconnect(cb: (err?: Error) => void) {
    this.on("disconnect", cb);
  }

  private log(msg: string, ...args: unknown[]): void {
    if (this.logging) {
      console.log(msg, ...args);
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.state === "connected") {
        return resolve();
      }

      const onConnect = () => {
        cleanup();
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        this.removeListener("connect", onConnect);
        this.removeListener("error", onError);
      };

      this.once("connect", onConnect);
      this.once("disconnect", (err?: Error) => {
        if (this.state !== "connected") {
          cleanup();
          reject(err || new Error("Disconnected during startup"));
        }
      });

      this._initNative();
    });
  }

  private _initNative(): void {
    this.state = "connecting";
    this.emit("stateChange", this.state);

    try {
      this.gw = new NativeWireShadeClass(
        this.config.wireguard!.privateKey,
        this.config.wireguard!.peerPublicKey,
        this.config.wireguard!.presharedKey || null,
        this.config.wireguard!.endpoint,
        this.config.wireguard!.sourceIp,
        this.config.wireguard!.listenPort || null,
      );

      this.agents.tcp = new WireShadeAgent(this.gw, {
        keepAlive: true,
        logging: this.logging,
        onConnectionError: (err: Error) => this._handleConnectionError(err),
      });

      this.agents.http = null;
      this.agents.https = null;

      setTimeout(() => {
        if (this.state === "connecting") {
          this._onConnected();
        }
      }, 1000);
    } catch (err: unknown) {
      this.log("[WireShadeClient] Connection failed:", (err as Error).message);
      this._handleConnectionError(err as Error);
    }
  }

  private _onConnected(): void {
    const wasReconnecting = this.state === "reconnecting";
    this.state = "connected";
    this.reconnectAttempts = 0;

    this.emit("stateChange", this.state);
    this.emit("connect");

    if (wasReconnecting) {
      this.log("[WireShadeClient] Reconnected successfully!");
      this.emit("reconnect");
      if (this.config.onReconnect) this.config.onReconnect();
    } else {
      this.log("[WireShadeClient] Connected!");
      if (this.config.onConnect) this.config.onConnect();
    }

    this._startHealthCheck();
  }

  private _handleConnectionError(err: Error): void {
    this.log("[WireShadeClient] Connection error:", err?.message || err);

    if (this.state === "disconnected") {
      return;
    }

    this.state = "disconnected";
    this.emit("stateChange", this.state);
    this.emit("disconnect", err);

    if (this.config.onDisconnect) this.config.onDisconnect(err);

    if (this.reconnectConfig.enabled) {
      this._scheduleReconnect();
    }
  }

  private _scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (
      this.reconnectConfig.maxAttempts > 0 &&
      this.reconnectAttempts >= this.reconnectConfig.maxAttempts
    ) {
      this.log("[WireShadeClient] Max reconnection attempts reached");
      this.emit("reconnectFailed");
      return;
    }

    const delay = Math.min(
      this.reconnectConfig.delay *
        Math.pow(
          this.reconnectConfig.backoffMultiplier,
          this.reconnectAttempts,
        ),
      this.reconnectConfig.maxDelay,
    );

    this.reconnectAttempts++;
    this.state = "reconnecting";
    this.emit("stateChange", this.state);

    this.log(
      `[WireShadeClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.reconnectConfig.maxAttempts || "∞"})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.emit("reconnecting", this.reconnectAttempts);
      this._initNative();
    }, delay);
  }

  private _startHealthCheck(): void {
    this._stopHealthCheck();

    if (this.reconnectConfig.healthCheckInterval > 0) {
      this.healthCheckTimer = setInterval(() => {
        this._performHealthCheck();
      }, this.reconnectConfig.healthCheckInterval);
    }
  }

  private _stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private async _performHealthCheck(): Promise<void> {
    this.emit("healthCheck");
  }

  reconnect(): void {
    this.log("[WireShadeClient] Manual reconnect triggered");
    this.reconnectAttempts = 0;
    this._stopHealthCheck();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this._initNative();
  }

  getHttpAgent(): http.Agent {
    if (!this.agents.http) {
      this.agents.http = new http.Agent({
        keepAlive: true,
        lookup: this._customLookup.bind(this) as any,
      });
      this.agents.http.createConnection = (
        options: any,
        cb?: (...args: any[]) => void,
      ): any => {
        if (!this.agents.tcp) {
          throw new Error(
            "WireShade connection not started. Please await client.start() first.",
          );
        }
        return this.agents.tcp.createConnection(options, cb) as net.Socket;
      };
    }
    return this.agents.http;
  }

  getHttpsAgent(): https.Agent {
    if (!this.agents.https) {
      this.agents.https = new https.Agent({
        keepAlive: true,
        lookup: this._customLookup.bind(this) as any,
      });

      this.agents.https.createConnection = (
        options: any,
        cb?: (...args: any[]) => void,
      ): any => {
        if (!this.agents.tcp) {
          throw new Error(
            "WireShade connection not started. Please await client.start() first.",
          );
        }
        const rawSocket = this.agents.tcp.createConnection(
          options,
        ) as net.Socket;
        const tlsOptions: tls.ConnectionOptions = {
          ...options,
          socket: rawSocket,
          servername: options.hostname || (options.host as string),
        };
        return tls.connect(tlsOptions, cb);
      };
    }
    return this.agents.https;
  }

  addHost(hostname: string, ip: string): void {
    this.hosts[hostname] = ip;
  }

  async forwardLocal(
    localPort: number,
    remoteHost: string,
    remotePort: number,
  ): Promise<net.Server> {
    if (!this.agents.tcp) throw new Error("WireShade not initialized");
    const tcpAgent = this.agents.tcp;

    return new Promise((resolve, reject) => {
      const server = net.createServer((clientSocket: net.Socket) => {
        const tunnelSocket = tcpAgent.createConnection({
          host: remoteHost,
          port: remotePort,
        }) as Duplex;

        clientSocket.pipe(tunnelSocket);
        tunnelSocket.pipe(clientSocket);

        const cleanup = () => {
          clientSocket.destroy();
          tunnelSocket.destroy();
        };
        clientSocket.on("error", cleanup);
        tunnelSocket.on("error", cleanup);
        clientSocket.on("close", cleanup);
        tunnelSocket.on("close", cleanup);
      });

      server.listen(localPort, () => {
        this.servers.push(server);
        resolve(server);
      });

      server.on("error", reject);
    });
  }

  async forwardRemote(
    vpnPort: number,
    targetHost: string,
    targetPort: number,
  ): Promise<WireShadeServer> {
    return this.listen(vpnPort, (vpnSocket: net.Socket) => {
      const localSocket = net.connect(targetPort, targetHost, () => {
        vpnSocket.pipe(localSocket);
        localSocket.pipe(vpnSocket);
      });

      const cleanup = () => {
        vpnSocket.destroy();
        localSocket.destroy();
      };

      vpnSocket.on("error", cleanup);
      localSocket.on("error", cleanup);
      vpnSocket.on("close", cleanup);
      localSocket.on("close", cleanup);
    });
  }

  private _customLookup(
    hostname: string,
    options: dns.LookupOneOptions | dns.LookupAllOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void,
  ): void {
    if (this.hosts[hostname]) {
      return callback(null, this.hosts[hostname]!, 4);
    }
    dns.lookup(hostname, options as dns.LookupOptions, callback as any);
  }

  private _wrapModule(
    module: typeof http | typeof https,
    agentGetter: () => http.Agent,
  ): HttpWrapper {
    const wrapper: Record<string, unknown> = {
      ...(module as unknown as Record<string, unknown>),
    };

    wrapper.request = (...args: any[]): http.ClientRequest => {
      let options: any =
        typeof args[0] === "string" || args[0] instanceof URL
          ? args[1]
          : args[0];

      if (typeof options === "function" || !options) {
        options = {};
        if (typeof args[0] === "string" || args[0] instanceof URL) {
          if (typeof args[1] === "function") {
            return (module as any).request(
              args[0],
              { agent: agentGetter() },
              args[1],
            );
          } else if (!args[1]) {
            return (module as any).request(args[0], { agent: agentGetter() });
          }
        } else {
          return (module as any).request(
            { ...args[0], agent: agentGetter() },
            args[1],
          );
        }
      }

      const newOptions = { ...options, agent: agentGetter() };

      if (typeof args[0] === "string" || args[0] instanceof URL) {
        return (module as any).request(args[0], newOptions, args[2]);
      } else {
        return (module as any).request(newOptions, args[1]);
      }
    };

    wrapper.get = (...args: any[]): http.ClientRequest => {
      const req = (wrapper.request as (...a: any[]) => http.ClientRequest)(
        ...args,
      );
      req.end();
      return req;
    };

    return wrapper as unknown as HttpWrapper;
  }

  async listen(
    port: number,
    onConnection?: (socket: net.Socket) => void,
  ): Promise<WireShadeServer> {
    if (!this.gw) throw new Error("WireShade not initialized");

    const server = new WireShadeServer(this.gw, { logging: this.logging });

    if (onConnection) {
      server.on("connection", onConnection);
    }

    await server.listen(port);
    this.servers.push(server);
    return server;
  }

  async get(url: string, options: { body?: string } = {}): Promise<string> {
    return this.request(url, { ...options, method: "GET" });
  }

  request(
    urlStr: string,
    options: { body?: string; method?: string } = {},
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const isHttps = urlStr.startsWith("https:");
      const agent = isHttps ? this.getHttpsAgent() : this.getHttpAgent();
      const mod = isHttps ? https : http;

      const req = mod.request(urlStr, { ...options, agent }, (res) => {
        let data = "";
        res.on("data", (c: Buffer | string) => (data += c));
        res.on("end", () => resolve(data));
      });

      req.on("error", reject);

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  connect(
    options: { host: string; port: number },
    connectionListener?: (...args: any[]) => void,
  ): Duplex {
    if (!this.agents.tcp) throw new Error("WireShade not initialized");
    return this.agents.tcp.createConnection(
      options,
      connectionListener,
    ) as unknown as Duplex;
  }

  ping(ip: string): Promise<number> {
    if (!this.gw) throw new Error("WireShade not initialized");
    return this.gw.ping(ip);
  }

  close(): void {
    this.state = "disconnected";
    this.reconnectConfig.enabled = false;

    this._stopHealthCheck();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    if (this.agents.http) this.agents.http.destroy();
    if (this.agents.https) this.agents.https.destroy();
    if (this.agents.tcp) this.agents.tcp.destroy();
    this.servers.forEach((s) => s.close());

    this.emit("stateChange", this.state);
    this.emit("close");

    if (this.config.onDisconnect) {
      this.config.onDisconnect();
    }
  }
}
