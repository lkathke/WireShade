/// <reference types="node" />

import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// Native binding (Rust, napi-rs)
//
// Callbacks follow the napi-rs ThreadsafeFunction convention: the first
// argument is an error slot (always `null` in practice), followed by values.
// Native logging is controlled via the `RUST_LOG` environment variable,
// e.g. `RUST_LOG=wireshade=debug` (default: warnings and errors).
// ---------------------------------------------------------------------------

/** Client TLS options for {@link NativeWireShade.wsClient}. */
export interface WsClientTlsOptions {
  /** PEM of a CA / self-signed certificate to trust (pinning). Without it the system / webpki root store is used. */
  ca?: string | null
  /** Reserved: SNI override (currently the host of `url` is used for SNI). */
  servername?: string | null
  /** Disable certificate verification entirely. TEST ONLY — never use in production. */
  insecureSkipVerify?: boolean | null
}

/** Options for {@link NativeWireShade.wsClient}. */
export interface WsClientOptions {
  privateKey: string
  peerPublicKey: string
  presharedKey?: string | null
  sourceIp: string
  /** WireGuard persistent keepalive in seconds (0 / omitted = disabled). */
  persistentKeepalive?: number | null
  /** Target URL, `ws://host:port` or `wss://host:port`. */
  url: string
  /** Optional path appended to the URL (e.g. `v1` -> `/v1`). */
  pathPrefix?: string | null
  /** Extra HTTP headers sent on the upgrade request. */
  headers?: Record<string, string> | null
  /** WebSocket ping keepalive interval in seconds (default 20). */
  keepaliveSec?: number | null
  tls?: WsClientTlsOptions | null
}

/** Server TLS options for {@link NativeWireShade.wsServer}. Providing it enables `wss`. */
export interface WsServerTlsOptions {
  /** Certificate chain PEM. */
  cert: string
  /** Private key PEM. */
  key: string
}

/** Options for {@link NativeWireShade.wsServer}. */
export interface WsServerOptions {
  privateKey: string
  peerPublicKey: string
  presharedKey?: string | null
  sourceIp: string
  /** WireGuard persistent keepalive in seconds (0 / omitted = disabled). */
  persistentKeepalive?: number | null
  /** Bind address, `host:port`. */
  listen: string
  /** Optional expected path prefix (accepted but not enforced in this round). */
  pathPrefix?: string | null
  /** WebSocket ping keepalive interval in seconds (default 20). */
  keepaliveSec?: number | null
  /** TLS cert + key PEM. Omit for plaintext `ws`. */
  tls?: WsServerTlsOptions | null
}

/** A self-signed certificate and its private key, both PEM-encoded. */
export interface CertPair {
  certPem: string
  keyPem: string
}

/** Userspace WireGuard tunnel with an embedded TCP/IP stack. */
export declare class NativeWireShade {
  /**
   * Create the tunnel over UDP (the original transport). Throws only for
   * invalid keys or an invalid source IP. Endpoint DNS resolution and the UDP
   * bind run asynchronously inside the network task; failures are reported
   * through {@link waitForHandshake}.
   *
   * @param privateKey          Base64 WireGuard private key.
   * @param peerPublicKey       Base64 public key of the peer.
   * @param presharedKey        Optional base64 preshared key.
   * @param endpoint            Peer endpoint, `host:port`.
   * @param sourceIp            Our IPv4 address inside the tunnel.
   * @param listenPort          Optional local UDP port (default: random).
   * @param persistentKeepalive Optional persistent keepalive in seconds (0 / omitted = off).
   */
  constructor(
    privateKey: string,
    peerPublicKey: string,
    presharedKey: string | null | undefined,
    endpoint: string,
    sourceIp: string,
    listenPort?: number | null,
    persistentKeepalive?: number | null
  )

  /**
   * Alias for the positional UDP constructor: identical behavior, matching the
   * transport factory naming (`overUdp` / `wsClient` / `wsServer`).
   */
  static overUdp(
    privateKey: string,
    peerPublicKey: string,
    presharedKey: string | null | undefined,
    endpoint: string,
    sourceIp: string,
    listenPort?: number | null,
    persistentKeepalive?: number | null
  ): NativeWireShade

  /**
   * Create the tunnel as a WebSocket client (`ws://` or `wss://`). One binary
   * frame carries one WireGuard packet; WS pings keep the connection alive.
   * Returns a WireShade with the same method surface as the UDP constructor.
   */
  static wsClient(options: WsClientOptions): NativeWireShade

  /**
   * Create the tunnel as a WebSocket server. Binds `listen` and accepts one WS
   * client at a time (1:1 peer model); if the connection drops the tunnel goes
   * Ready -> Connecting and a new client is awaited. TLS (wss) is enabled by
   * providing `tls.cert` + `tls.key`; without it plaintext `ws` is served.
   * Returns a WireShade with the same method surface as the UDP constructor.
   */
  static wsServer(options: WsServerOptions): NativeWireShade

  /**
   * Resolves once the WireGuard handshake has completed (immediately if it
   * already has). Rejects on timeout (default 10000 ms), when setup failed
   * (DNS / UDP bind, with a descriptive message) or after {@link shutdown}.
   * May be called repeatedly.
   */
  waitForHandshake(timeoutMs?: number | null): Promise<void>

  /**
   * Resolves once the WireGuard session is lost, i.e. the tunnel state leaves
   * `Ready` (session dropped → reconnecting, or setup failed / shut down).
   * Resolves immediately if the tunnel is not currently in the ready state
   * (never handshook, already reconnecting, or shut down). Safe to call
   * repeatedly and concurrently; typically started right after
   * {@link waitForHandshake} resolves to detect a dropped tunnel.
   */
  waitForDisconnect(): Promise<void>

  /**
   * Stop the network task. All open connections receive `onClose`; pending
   * connects, sends and pings are rejected. Afterwards every method fails.
   * Idempotent.
   */
  shutdown(): Promise<void>

  /**
   * Open a TCP connection through the tunnel. Resolves once the connection is
   * established; rejects on RST (`Connection refused`) or after 10 s
   * (`Connection timed out`).
   *
   * `onClose` fires exactly once per connection: on peer EOF (FIN), on RST,
   * when the connection is closed, or on shutdown.
   */
  connect(
    destIp: string,
    destPort: number,
    onData: (err: Error | null, data: Buffer) => void,
    onClose: (err: Error | null) => void
  ): Promise<NativeConnection>

  /**
   * Listen for incoming TCP connections on the tunnel IP (backlog of 4
   * concurrent handshakes). Rejects if the port is already being listened on.
   *
   * `onClose` fires exactly once per connection (peer EOF, RST, closed, shutdown).
   */
  listen(
    port: number,
    onConnection: (err: Error | null, connId: number, remoteIp: string, remotePort: number) => void,
    onData: (err: Error | null, connId: number, data: Buffer) => void,
    onClose: (err: Error | null, connId: number) => void
  ): Promise<void>

  /**
   * Send data on a connection (client or server) by ID. Resolves once all
   * bytes are queued in the TCP send buffer (backpressure, no data loss);
   * rejects if the connection is unknown, closing or closed.
   */
  sendTo(connectionId: number, data: Buffer): Promise<void>

  /** Gracefully close a connection by ID. Already queued data is sent before the FIN. */
  closeConnection(connectionId: number): Promise<void>

  /**
   * Pause inbound delivery on a connection (by ID): the engine stops draining
   * its RX queue, so the TCP window closes and the peer throttles. Data already
   * buffered is delivered once resumed. Unknown/closed id resolves as a no-op.
   */
  pauseConnection(connectionId: number): Promise<void>

  /**
   * Resume inbound delivery on a connection paused via {@link pauseConnection},
   * draining already-buffered data through the `onData` callback. Unknown/closed
   * id resolves as a no-op.
   */
  resumeConnection(connectionId: number): Promise<void>

  /** ICMP echo request. Resolves with the round-trip time in ms; rejects after 2 s. */
  ping(destIp: string): Promise<number>
}

/** Established client TCP connection returned by {@link NativeWireShade.connect}. */
export declare class NativeConnection {
  private constructor()
  /** The connection id, usable with pauseConnection/resumeConnection. */
  readonly id: number
  /** Resolves once all bytes are queued in the TCP send buffer. */
  send(data: Buffer): Promise<void>
  /** Gracefully close the connection. Already queued data is sent before the FIN. */
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// High-level JavaScript API (lib/*.js)
// ---------------------------------------------------------------------------

export declare const ConnectionState: Readonly<Record<string, string>>

export declare class WireShadeClient extends EventEmitter {
  constructor(configOrPath: string | Record<string, any>, options?: Record<string, any>)
  [key: string]: any
}

export declare class WireShadeAgent {
  constructor(gw: NativeWireShade, options?: Record<string, any>)
  [key: string]: any
}

export declare class WireShadeServer extends EventEmitter {
  constructor(gw: NativeWireShade, options?: Record<string, any>)
  [key: string]: any
}

/** The high-level client is the main export. */
export { WireShadeClient as WireShade }

export declare function parseWireGuardConfig(content: string): Record<string, any>
export declare function readWireGuardConfig(path: string): Record<string, any>
export { parseWireGuardConfig as parseConfig, readWireGuardConfig as readConfig }
export declare function generateKeyPair(): { privateKey: string; publicKey: string }

/**
 * Generate a self-signed certificate (and key) for the given subject
 * alternative names, PEM-encoded. Convenience for `wss` test/dev setups
 * without OpenSSL. Provided by the native binding (see {@link NativeWireShade.wsServer}).
 */
export declare function generateSelfSignedCert(subjectAltNames: string[]): CertPair
