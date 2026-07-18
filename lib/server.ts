import { Duplex } from "stream";
import EventEmitter from "events";
import type {
  NativeWireShade,
  WireShadeServerStream,
  WireShadeServerOptions,
  WireShadeServerConnectionInfo,
} from "./types";

export class WireShadeServer extends EventEmitter {
  private gw: NativeWireShade;
  private options: WireShadeServerOptions;
  private logging: boolean;
  private log: (...args: unknown[]) => void;
  private connections: Map<number, WireShadeServerConnectionInfo>;
  private port: number | null;
  private listening: boolean;

  constructor(gw: NativeWireShade, options: WireShadeServerOptions = {}) {
    super();
    this.gw = gw;
    this.options = options;
    this.logging = options.logging !== false;
    this.log = this.logging ? console.log : () => {};
    this.connections = new Map();
    this.port = null;
    this.listening = false;
  }

  async listen(port: number, callback?: () => void): Promise<void> {
    this.port = port;

    try {
      await this.gw.listen(
        port,
        (
          err: Error | null,
          connId: number,
          remoteIp: string,
          remotePort: number,
        ) => {
          if (err) {
            this.log(`[Server] Connection error: ${err}`);
            return;
          }
          this.log(
            `[Server] New connection ${connId} from ${remoteIp}:${remotePort}`,
          );

          const stream = this._createStream(connId);
          stream.remoteAddress = remoteIp;
          stream.remotePort = remotePort;
          this.connections.set(connId, { stream });
          this.emit("connection", stream, {
            remoteAddress: remoteIp,
            remotePort,
          });
        },
        (err: Error | null, connId: number, buffer: Buffer) => {
          if (err) return;
          const conn = this.connections.get(connId);
          if (conn && conn.stream && buffer) {
            this.log(
              `[Server] Received ${buffer.length} bytes on conn ${connId}`,
            );
            conn.stream.push(buffer);
          }
        },
        (err: Error | null, connId: number) => {
          if (err) return;
          this.log(`[Server] Connection ${connId} closed`);
          const conn = this.connections.get(connId);
          if (conn && conn.stream) {
            conn.stream.push(null);
            conn.stream.emit("close");
            this.connections.delete(connId);
          }
        },
      );

      this.listening = true;
      this.log(`[Server] Listening on VPN port ${port}`);
      this.emit("listening");
      if (callback) callback();
    } catch (err) {
      this.emit("error", err);
      throw err;
    }
  }

  private _createStream(connId: number): WireShadeServerStream {
    const self = this;
    const log = this.log;

    const stream = new Duplex({
      allowHalfOpen: true,
      read(_size: number) {},
      write(chunk: Buffer, _encoding: string, callback: (err?: Error) => void) {
        log(`[Server] Writing ${chunk.length} bytes to conn ${connId}`);
        self.gw
          .sendTo(connId, chunk)
          .then(() => callback())
          .catch((err: Error) => {
            log(`[Server] Write error: ${err}`);
            callback(err);
          });
      },
    }) as WireShadeServerStream;

    stream.remoteAddress = null;
    stream.remotePort = null;
    stream.connId = connId;

    stream.end = ((
      data?: Buffer | string,
      encoding?: BufferEncoding,
      callback?: () => void,
    ): WireShadeServerStream => {
      const finish = () => {
        self.gw.closeConnection(connId).catch(() => {});
        self.connections.delete(connId);
        if (callback) callback();
      };
      if (data) {
        stream.write(data, encoding as BufferEncoding, () => finish());
      } else {
        finish();
      }
      return stream;
    }) as typeof stream.end;

    stream.destroy = () => {
      self.gw.closeConnection(connId).catch(() => {});
      self.connections.delete(connId);
      return stream;
    };

    return stream;
  }

  close(callback?: () => void): void {
    this.listening = false;
    this.emit("close");
    if (callback) callback();
  }
}
