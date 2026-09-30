# 👻 WireShade using Node.js

**The Ultimate Userspace WireGuard® Implementation for Node.js**

[![npm version](https://img.shields.io/npm/v/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![npm downloads](https://img.shields.io/npm/dm/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**WireShade** lets your Node.js application connect directly to a WireGuard VPN **without root privileges**, kernel modules, or changes to your system network settings. It runs entirely in userspace using a custom Rust-based TCP/IP stack (`smoltcp`) integrated directly into Node.js — no TUN/TAP interface is ever created.

<div align="center">

[🇺🇸 English](README.md) | [🇩🇪 Deutsch](README.de.md) | [🇪🇸 Español](README.es.md) | [🇫🇷 Français](README.fr.md) | [🇨🇳 中文](README.zh.md)

</div>

---

## 🚀 Why WireShade?

*   **🛡️ Stealth & Security:** Route specific Node.js traffic through a WireGuard VPN while the rest of your system traffic stays normal. Perfect for web scraping, bots, or secure service-to-service communication.
*   **🌍 Reverse Tunneling:** Expose a local Express/Fastify/Next.js server or a raw TCP service to the private VPN network, even behind a NAT or firewall.
*   **🔌 Zero-Config Client:** No need to install WireGuard on the host. Just `npm install` and go.
*   **🧱 WebSocket / WSS Transport:** Carry the whole WireGuard tunnel over a single `ws://` or `wss://` connection to punch through restrictive firewalls and HTTP-only proxies.
*   **🔄 Automatic Reconnection:** Built-in backoff, health checks, and events to survive connection drops and network changes.
*   **⚡ High Performance:** Powered by Rust and NAPI-RS for near-native performance.

## 🧠 How it Works

WireShade bypasses the host OS network stack by running a **userspace TCP/IP stack** ([smoltcp](https://github.com/smoltcp-rs/smoltcp)) inside your Node.js process:

1.  **Handshake:** WireShade performs a real WireGuard handshake with the peer (over UDP, or over a WebSocket).
2.  **Encapsulation:** IP packets are encrypted and encapsulated in the transport frames.
3.  **Userspace Routing:** Decrypted packets are handled by `smoltcp` in Rust, which manages TCP state, retransmission, and buffering.
4.  **Node.js Integration:** Data moves between Rust and Node.js `net.Socket` / `http.Agent` instances over high-performance NAPI bindings.

This means: **no virtual network interface**, **no root**, **no conflict** with existing VPNs, and **cross-platform** support without kernel modules.

## ✅ Supported Platforms

Native binaries are **prebuilt for the following six targets and loaded automatically** at `require()` time — no compiler or build step needed on install.

| Target triple | Platform | Arch |
| :--- | :--- | :--- |
| `x86_64-pc-windows-msvc` | Windows | x64 |
| `x86_64-apple-darwin` | macOS | Intel |
| `aarch64-apple-darwin` | macOS | Apple Silicon |
| `x86_64-unknown-linux-gnu` | Linux | x64 |
| `aarch64-unknown-linux-gnu` | Linux | ARM64 |
| `armv7-unknown-linux-gnueabihf` | Linux / Raspberry Pi | ARMv7 |

## 📦 Installation

```bash
npm i wireshade
```

---

## ⚡ Quickstart

### From a config object

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade({
    wireguard: {
        privateKey: '<base64 private key>',
        peerPublicKey: '<base64 peer public key>',
        endpoint: 'vpn.example.com:51820',
        sourceIp: '10.0.0.2',            // our address inside the tunnel
        persistentKeepalive: 25          // seconds; 0 disables (default 25)
    }
});

await client.start();                    // resolves once the WireGuard handshake completes

// HTTP GET through the tunnel:
const body = await client.get('http://10.0.0.1/');
console.log(body);

await client.close();
```

### From a WireGuard `.conf` file

Pass a path string instead of a config object — a standard `[Interface]` / `[Peer]` file is parsed for you (including `PersistentKeepalive`):

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

const body = await client.get('http://10.0.0.1/');
console.log(body);

await client.close();
```

For real requests via `axios`, `node-fetch`, `ws`, etc., pass the tunnel agents:

```javascript
const axios = require('axios');
const res = await axios.get('https://internal.service/api', {
    httpAgent: client.getHttpAgent(),
    httpsAgent: client.getHttpsAgent()
});
```

---

## 🧱 WebSocket / WSS Transport

Instead of UDP, WireShade can carry the entire WireGuard tunnel over a **single WebSocket connection**. This is the reliable way to "just get through" restrictive firewalls and proxies that only allow HTTP(S). Both peers are WireShade instances: one runs as the WS **server** (terminates TLS + the tunnel), the other as the WS **client**.

### Server peer

```javascript
const { WireShadeWsServer, generateKeyPair, generateSelfSignedCert } = require('wireshade');

const server = generateKeyPair();
const client = generateKeyPair();

// Self-signed cert for the names the client will connect to — no OpenSSL needed.
const { certPem, keyPem } = generateSelfSignedCert(['vpn.example.com']);

const srv = new WireShadeWsServer({
    listen: '0.0.0.0:443',
    pathPrefix: 'v1',
    tls: { cert: certPem, key: keyPem },   // omit `tls` entirely for plaintext ws://
    wireguard: {
        privateKey: server.privateKey,
        peerPublicKey: client.publicKey,
        sourceIp: '10.0.0.1'
    }
});

await srv.start();                         // resolves once bound & listening (no peer needed yet)

// Now register tunnel services just like the UDP client:
await srv.listen(8080, (socket) => {
    socket.on('data', () => socket.end('pong'));
});
```

### Client peer

```javascript
const fs = require('fs');
const { WireShade } = require('wireshade');

// The server's certificate, as a PEM string (copied from the server).
const certPem = fs.readFileSync('server-cert.pem', 'utf8');

const client = new WireShade({
    wireguard: {
        privateKey: '<client private key>',
        peerPublicKey: '<server public key>',
        sourceIp: '10.0.0.2'               // no `endpoint`: the server terminates the tunnel
    },
    transport: {
        type: 'websocket',                 // 'udp' (default) | 'websocket'
        url: 'wss://vpn.example.com:443',  // ws:// (plaintext) or wss:// (native TLS)
        pathPrefix: 'v1',
        tls: {
            ca: certPem,                   // pin the self-signed cert (PEM)
            servername: 'vpn.example.com'  // SNI override (optional)
            // insecureSkipVerify: true    // TEST ONLY — disables cert verification
        }
    }
});

await client.start();                      // resolves on the WireGuard handshake over WSS

const body = await client.get('http://10.0.0.1:8080/');
console.log(body);
await client.close();
```

Everything else — `connect`, `listen`, `forwardLocal`, `forwardRemote`, `ping`, the `http`/`https` wrappers and the auto-reconnect logic — works identically over WebSocket. See [`examples/13_websocket_highlevel.js`](examples/13_websocket_highlevel.js) (high-level) and [`examples/11_websocket_wss.js`](examples/11_websocket_wss.js) (native binding).

**`ws://` vs `wss://`:** use plaintext `ws://` (omit the server `tls` block) when TLS is already terminated in front of WireShade by a reverse proxy such as nginx or Caddy; use native `wss://` (with `tls: { cert, key }`) to let WireShade terminate TLS itself. On the client, `tls.ca` pins a specific certificate, `tls.servername` overrides SNI, and `tls.insecureSkipVerify` disables verification entirely — **for testing only, never in production**.

> **Trade-off — TCP over TCP:** the WebSocket transport tunnels WireGuard (and therefore your inner TCP) inside an outer TCP/TLS stream. It is excellent for firewall/proxy traversal and reliable, ordered links, but on lossy or high-jitter paths the two stacked congestion-control loops can fight ("TCP meltdown"). When the network is unreliable, the plain UDP transport generally behaves better; when you just need to get through, WebSocket wins.

---

## 📖 Core API

```javascript
const {
    WireShade,          // = WireShadeClient, the high-level client (main export)
    WireShadeWsServer,  // high-level WebSocket server peer
    generateKeyPair,
    generateSelfSignedCert,
    parseConfig, readConfig,
    ConnectionState
} = require('wireshade');
```

**`new WireShade(configOrPath, [options])`**
Create a client from a config object, or from a path to a `.conf` file (`new WireShade('wg.conf')`). `config.wireguard` takes the usual WireGuard fields: `privateKey`, `peerPublicKey`, `presharedKey`, `endpoint`, `sourceIp`, `listenPort`, `persistentKeepalive`. `persistentKeepalive` is in seconds (`PersistentKeepalive` in `.conf` files), defaults to `25`, and `0` disables it. Other options: `logging` (default `true`), `handshakeTimeout` (ms, default `10000`), `hosts`, `reconnect`, `transport`, and `onConnect`/`onDisconnect`/`onReconnect`.

**`client.start()`** → `Promise<void>`
Connects and resolves **once the real WireGuard handshake with the peer has completed** (rejects on timeout, DNS/bind error, or if `close()` is called first). When both peers are WireShade instances, start them concurrently: `Promise.all([a.start(), b.start()])`.

**`client.close()`** → `Promise<void>`
Stops reconnects and health checks, closes all servers/connections, and shuts down the native tunnel. Resolves once the native task has stopped. (`close()` is the high-level equivalent of the native `shutdown()`.)

**Reconnection** — configure via the `reconnect` block; state changes surface as events:

```javascript
const client = new WireShade({
    wireguard: { /* ... */ },
    reconnect: {
        enabled: true,             // default true
        maxAttempts: 10,           // 0 = unlimited
        delay: 1000,               // initial backoff (ms)
        maxDelay: 30000,           // backoff ceiling (ms)
        backoffMultiplier: 1.5,    // exponential backoff factor
        healthCheckInterval: 30000 // ms; 0 disables
    }
});

client.on('connect',     () => console.log('tunnel up'));
client.on('disconnect',  (err) => console.log('tunnel down:', err?.message));
client.on('reconnect',   () => console.log('tunnel restored'));
client.on('stateChange', (state) => console.log('state:', state)); // see ConnectionState
```

Tracked listeners (`listen`/`forwardRemote`) are automatically re-created on the new tunnel after a reconnect.

**`client.ping(ip)`** → `Promise<number>` — ICMP echo; resolves with the round-trip time in ms.

**`client.connect({ host, port })`** → `Duplex` — a `net.Socket`-compatible stream through the tunnel. Emits `'connect'`, `'data'`, `'end'`, `'error'`.

**`client.listen(port, [onConnection])`** → `Promise<Server>` — a TCP server on the **VPN IP**; `onConnection` receives a socket per connection.

**`client.forwardLocal(localPort, remoteHost, remotePort)`** → `Promise` — expose a VPN-side service on your local machine (`localhost:localPort` → `remoteHost:remotePort` inside the VPN).

**`client.forwardRemote(vpnPort, targetHost, targetPort)`** → `Promise` — expose a local service to VPN peers (VPN IP `:vpnPort` → `targetHost:targetPort` on your machine).

```javascript
await client.forwardLocal(3333, '10.0.0.5', 5432);   // reach VPN Postgres via localhost:3333
await client.forwardRemote(8080, 'localhost', 3000); // publish local :3000 on the VPN at :8080
```

**`client.get(url, [opts])` / `client.request(url, [opts])`** → `Promise<string | object>` — HTTP(S) through the tunnel. Resolves with the body string (`opts.encoding`, default `utf8`); with `opts.fullResponse: true` resolves with `{ statusCode, statusMessage, headers, body, rawBody }`. `opts.body` sets a request body.

**`client.getHttpAgent()` / `client.getHttpsAgent()`** — `http.Agent` / `https.Agent` routing through the tunnel (for `axios`, `node-fetch`, `ws`, …).

**`client.addHost(hostname, ip)`** — map a hostname to a VPN IP without touching `/etc/hosts`; the mapping is used for the client's own requests and forwards.

**`generateKeyPair()`** → `{ privateKey, publicKey }` — a fresh WireGuard key pair.

**`parseConfig(text)` / `readConfig(path)`** — parse a WireGuard config from a string or file into a config object.

**`generateSelfSignedCert(sans)`** → `{ certPem, keyPem }` — a self-signed certificate + key (PEM) for the given subject alternative names, handy for `wss://` dev/test without OpenSSL.

**`new WireShadeWsServer({ listen, pathPrefix, tls, wireguard, ... })`** — the WebSocket server peer. `listen` is `"host:port"`; provide `tls: { cert, key }` for `wss://` or omit it for `ws://`. Its `start()` resolves as soon as the socket is **bound and listening** (before any peer handshakes), so you can register `listen`/`forwardRemote` immediately. All other `WireShadeClient` methods and events apply.

---

## 📊 Benchmarks

WireShade ships two benchmark scripts. Numbers are machine-dependent, so run them yourself.

```bash
# Raw tunnel goodput + CPU-per-core on loopback (crypto/CPU cost, not RTT/loss):
BENCH_TRANSPORT=udp BENCH_SECONDS=5 BENCH_CHUNK=262144 node bench/throughput.js
#   BENCH_TRANSPORT = udp | ws | wss

# Real iperf3 driven through the tunnel (needs iperf3 in PATH; skips cleanly if absent):
BENCH_TRANSPORT=udp node bench/iperf3.js
```

`bench/throughput.js` measures the goodput and per-core CPU cost of the full path (WireGuard crypto + `smoltcp` + the NAPI boundary) on loopback — it isolates crypto/CPU throughput, not network latency or loss. `bench/iperf3.js` drives a real `iperf3` client/server pair through the tunnel for an industry-standard number, and auto-skips (exit 0) if `iperf3` is not installed.

---

## 📚 Examples

Runnable scripts live in [`examples/`](examples/):

| File | Shows |
| :--- | :--- |
| `01_quickstart.js` | Connect, request, and listen — the "hello world". |
| `02_http_request.js` | Simple HTTP GET with `client.get()`. |
| `03_https_custom_dns.js` | HTTPS with a custom hostname mapped to a VPN IP. |
| `04_tcp_socket.js` | Raw TCP send/receive through the tunnel. |
| `05_internet_routing.js` | Route public-internet traffic out via the VPN gateway. |
| `06_simple_server.js` | Host a TCP/HTTP server inside the tunnel. |
| `07_express_app.js` | Expose an Express app over the VPN (reverse tunnel). |
| `08_local_forwarding.js` | `forwardLocal` — reach a VPN service on `localhost`. |
| `09_reconnect_config.js` | Reconnection, health checks, and event monitoring. |
| `10_remote_forwarding.js` | `forwardRemote` — publish a local service to the VPN. |
| `11_websocket_wss.js` | WireGuard over WSS using the **native** binding. |
| `13_websocket_highlevel.js` | WireGuard over WSS using the **high-level** API. |
| `local_vpn.js` | Two local peers forming a P2P tunnel for testing. |

---

## 🎯 Use Cases

*   **Microservices:** connect services across clouds without exposing public ports.
*   **Web scraping:** run multiple instances on different endpoints to rotate egress IPs.
*   **Developer access:** reach private internal databases from a laptop, securely.
*   **IoT & edge:** connect devices behind restrictive NATs back to a central server.

---

## 📜 License

MIT License.

*WireGuard is a registered trademark of Jason A. Donenfeld.*
</content>
</invoke>
