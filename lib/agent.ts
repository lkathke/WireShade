import dns from 'dns'
import http from 'http'
import { Duplex } from 'stream'
import type { NativeWireShade, NativeConnection, WireShadeDuplex } from './types'

interface WireShadeAgentOptions extends http.AgentOptions {
    logging?: boolean
    logger?: (...args: unknown[]) => void
    onConnectionError?: (err: Error) => void
}

export class WireShadeAgent extends http.Agent {
    private gw: NativeWireShade
    private options: WireShadeAgentOptions
    private log: (...args: unknown[]) => void
    private error: (...args: unknown[]) => void

    constructor(wireShade: NativeWireShade, options: WireShadeAgentOptions) {
        super(options)
        this.gw = wireShade
        this.options = options || {}

        this.log =
            this.options.logger ||
            (this.options.logging === false ? () => {} : console.log)
        this.error = this.options.logger || console.error
    }

    createConnection(
        options: http.ClientRequestArgs,
        cb?: (err: Error | null, stream: Duplex) => void,
    ): Duplex {
        const { host, port } = options
        const log = this.log
        const error = this.error

        log(`[Agent] Connecting to ${host}:${port}`)

        const stream = this.createStream()

        const lookup: typeof dns.lookup = options.lookup as typeof dns.lookup || dns.lookup

        lookup(host as string, { family: 4 }, (err: NodeJS.ErrnoException | null, address: string, _family: number) => {
            if (err) {
                cb?.(err, stream)
                return
            }
            log(`[Agent] Resolved ${host} to ${address}`)

            this.gw.connect(
                address,
                parseInt(port as string),
                (nativeErr: Error | null, data: Buffer) => {
                    const buffer = data || (Buffer.isBuffer(nativeErr) ? (nativeErr as unknown as Buffer) : null)
                    if (buffer) {
                        log(`[Agent] Received ${buffer.length} bytes via connection`)
                        stream.push(buffer)
                    } else if (nativeErr && !data) {
                        error('[Agent] Receive error:', nativeErr)
                        stream.destroy(nativeErr)
                    }
                },
                (closeErr: Error | null) => {
                    if (closeErr) {
                        stream.destroy(closeErr)
                    } else {
                        stream.push(null)
                    }
                },
            ).then((conn: NativeConnection) => {
                log(`[Agent] Connected! Setting stream.connection...`)
                stream.connection = conn
                stream.emit('connect')

                log(
                    `[Agent] Checking pendingBuffer: ${stream.pendingBuffer ? stream.pendingBuffer.length + ' items' : 'none'}`,
                )
                if (stream.pendingBuffer && stream.pendingBuffer.length > 0) {
                    log(
                        `[AgentStream] Flushing ${stream.pendingBuffer.length} buffered chunks`,
                    )
                    const flushPromises = stream.pendingBuffer.map(
                        ({ chunk, callback }: { chunk: Buffer; callback: (err?: Error) => void }) => {
                            log(`[AgentStream] Flushing chunk of ${chunk.length} bytes...`)
                            return conn
                                .send(chunk)
                                .then(() => {
                                    log(
                                        `[AgentStream] Flush completed for ${chunk.length} bytes`,
                                    )
                                    callback()
                                })
                                .catch((err: Error) => {
                                    error(`[AgentStream] Flush error:`, err)
                                    callback(err)
                                })
                        },
                    )
                    stream.pendingBuffer = null
                    Promise.all(flushPromises).then(() => {
                        log(`[Agent] All buffered data flushed, calling cb`)
                        if (cb) cb(null, stream)
                    })
                } else {
                    log(`[Agent] No buffered data, calling cb immediately`)
                    if (cb) cb(null, stream)
                }
            }).catch((e: Error) => {
                error('[Agent] Connection failed:', e.message, (e as any).code, e)
                if (cb) cb(e, stream)
                else stream.emit('error', e)
            })
        })

        return stream
    }

    private createStream(): WireShadeDuplex {
        const log = this.log
        const error = this.error

        const stream = new Duplex({
            allowHalfOpen: true,
            read(_size: number) {},
            write(chunk: Buffer, _encoding: string, callback: (err?: Error) => void) {
                log(`[AgentStream] write called with ${chunk.length} bytes`)
                if ((stream as WireShadeDuplex).connection) {
                    log(`[AgentStream] Sending immediately...`)
                    ;(stream as WireShadeDuplex).connection!.send(chunk)
                        .then(() => {
                            log(`[AgentStream] Send completed for ${chunk.length} bytes`)
                            callback()
                        })
                        .catch((err: Error) => {
                            error(`[AgentStream] Send error:`, err)
                            callback(err)
                        })
                } else {
                    log(`[AgentStream] Buffering - connection not ready yet`)
                    if (!(stream as WireShadeDuplex).pendingBuffer) (stream as WireShadeDuplex).pendingBuffer = []
                    ;(stream as WireShadeDuplex).pendingBuffer!.push({ chunk, callback })
                }
            },
        }) as WireShadeDuplex

        stream.connection = null
        stream.pendingBuffer = null

        stream.setTimeout = (msecs?: number, callback?: () => void) => {
            if (callback) stream.once('timeout', callback)
            return stream
        }
        stream.setNoDelay = (_enable?: boolean) => stream
        stream.setKeepAlive = (_enable?: boolean, _initialDelay?: number) => stream
        stream.ref = () => stream
        stream.unref = () => stream

        return stream
    }
}