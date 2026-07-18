import type { Server, Socket } from 'net'
import type { Duplex } from 'stream'

export interface WireGuardConfig {
  privateKey: string
  sourceIp: string
  peerPublicKey: string
  presharedKey?: string
  endpoint: string
  listenPort: number | null
}

export interface ReconnectConfig {
  enabled: boolean
  maxAttempts: number
  delay: number
  maxDelay: number
  backoffMultiplier: number
  healthCheckInterval: number
}

export interface ClientConfig {
  wireguard?: WireGuardConfig
  hosts?: Record<string, string>
  logging?: boolean
  reconnect?: Partial<ReconnectConfig>
  onConnect?: () => void
  onDisconnect?: (err?: Error) => void
  onReconnect?: () => void
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export const ConnectionStateValue = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
} as const

export interface KeyPair {
  privateKey: string
  publicKey: string
}

export interface AgentRecord {
  http: import('http').Agent | null
  https: import('https').Agent | null
  tcp: import('http').Agent | null
}

export interface WireShadeDuplex extends Duplex {
  remoteAddress: string | null
  remotePort: number | null
  connId: number
  pendingBuffer: { chunk: Buffer; callback: (err?: Error) => void }[] | null
  connection: NativeConnection | null
  setTimeout(msecs?: number, callback?: () => void): this
  setNoDelay(enable?: boolean): this
  setKeepAlive(enable?: boolean, initialDelay?: number): this
  ref(): this
  unref(): this
}

export interface WireShadeServerStream extends Duplex {
  remoteAddress: string | null
  remotePort: number | null
  connId: number
}

export interface WireShadeServerOptions {
  logging?: boolean
}

export interface WireShadeServerConnectionInfo {
  stream: WireShadeServerStream
}

export interface NativeWireShade {
  connect(
    destIp: string,
    destPort: number,
    onData: (err: Error | null, data: Buffer) => void,
    onClose: (err: Error | null) => void
  ): Promise<NativeConnection>
  listen(
    port: number,
    onConnection: (err: Error | null, connId: number, remoteIp: string, remotePort: number) => void,
    onData: (err: Error | null, connId: number, buffer: Buffer) => void,
    onClose: (err: Error | null, connId: number) => void
  ): Promise<void>
  sendTo(connectionId: number, data: Buffer): Promise<void>
  closeConnection(connectionId: number): Promise<void>
  ping(destIp: string): Promise<number>
}

export interface NativeConnection {
  id: number
  send(data: Buffer): Promise<void>
  close(): Promise<void>
}

export interface ForwardLocalResult extends Server {}

export interface HttpWrapper {
  request: typeof import('http').request
  get: typeof import('http').get
  [key: string]: unknown
}

export interface TunnelConnectOptions {
  host: string
  port: number
}