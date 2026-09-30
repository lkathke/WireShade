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

## 🖥️ Command-Line Interface (CLI)

WireShade ships a `wireshade` command that connects a tunnel and exposes a local **SOCKS5 proxy** — no code required. Install it globally, or run it on demand with `npx`. It works the same on **Windows, macOS, and Linux** through the npm bin shim.

```bash
npm i -g wireshade        # installs the `wireshade` command globally
# …or run it without installing:
npx wireshade socks -c wg0.conf
```

### Commands

| Command | Description |
| :--- | :--- |
| `wireshade socks [options]` | Connect and expose a local SOCKS5 proxy |
| `wireshade unset-proxy` | Restore system proxy settings (crash recovery) |
| `wireshade genkey` | Print a new WireGuard key pair |
| `wireshade version` | Print the version |
| `wireshade help` | Show usage |

### `socks` options

| Option | Description |
| :--- | :--- |
| `-c, --config <file>` | WireGuard `.conf` file (`[Interface]` + `[Peer]`) |
| `--private-key <b64>` | Interface private key (when no `--config`) |
| `--peer-key <b64>` | Peer public key (when no `--config`) |
| `--psk <b64>` | Pre-shared key (optional) |
| `--endpoint <host:port>` | WireGuard UDP endpoint (when no `--config`) |
| `--source-ip <ip>` | Tunnel source IP, e.g. `10.0.0.2` (when no `--config`) |
| `--keepalive <sec>` | Persistent keepalive (default `25`) |
| `-t, --transport <udp\|ws\|wss>` | Carrier transport (default `udp`) |
| `--url <ws[s]://host:port>` | WS server URL (required for `ws`/`wss`) |
| `--path-prefix <p>` | WS upgrade path prefix |
| `--ca <file>` | Pin a PEM certificate (`wss`, self-signed) |
| `--insecure` | Skip TLS verification (test only) |
| `-l, --listen <[host:]port>` | Local SOCKS5 bind (default `127.0.0.1:1080`) |
| `--auth <user:pass>` | Require SOCKS5 username/password |
| `--dns <ip>` | Resolve hostnames via this DNS server through the tunnel (DNS-over-TCP); defaults to the `.conf` `DNS =` value |
| `--set-system-proxy` | Point the OS at this proxy; automatically restored on exit |
| `--proxy-method <pac\|registry>` | Windows only; `pac` (default) = real SOCKS5 via a PAC file, `registry` = `socks=` entry (browsers treat it as SOCKS4) |
| `--chrome [url]` | Launch Chrome/Edge/Chromium through this proxy in an isolated profile; closing the browser stops wireshade |
| `--chrome-path <file>` | Browser executable (else auto-detected; also honors `$CHROME_PATH`) |
| `-v, --verbose` | Log each proxied connection |

### Examples

```bash
wireshade socks -c wg0.conf
wireshade socks -c wg0.conf -l 0.0.0.0:1080 --auth alice:secret
wireshade socks -c wg0.conf -t wss --url wss://vpn.example.com:443 --ca server.pem
wireshade socks -c wg0.conf --chrome https://example.internal
wireshade socks -c wg0.conf --set-system-proxy
```

Once it reports the proxy is listening, point any SOCKS5-aware app at it:

```bash
curl --socks5-hostname 127.0.0.1:1080 http://<vpn-host>/
```

*   **proxychains:** add `socks5 127.0.0.1 1080` to `proxychains.conf`, then run `proxychains <your-app>`.
*   **Browser:** set the SOCKS5 host to `127.0.0.1` and the port to `1080` (choose SOCKS v5 with remote DNS so hostnames resolve inside the VPN).

**Full internet through the VPN.** WireShade forwards **any** destination through the tunnel, not just the VPN's own subnet — so full-internet tunneling works **if the WireGuard server is an exit node** (IP forwarding + NAT). The public exit IP is then the server's; WireShade doesn't set it. Pass `--dns <ip>` to keep DNS resolution inside the tunnel too (no leak), which matters for full-tunnel use.

---

## 🎯 Top 10 Use Cases

Copy-paste recipes for what people reach for most. Every snippet is self-contained — swap in your own keys, IPs, and `.conf` path, and run it after `npm i wireshade`.

### 1. Call an internal HTTPS API through the tunnel

Reach a private API that only exists inside the VPN — with the built-in helper or via an axios/got/fetch agent.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// Built-in helper — resolves with the response body:
const json = await client.get('https://10.0.0.1/api/health');
console.log(JSON.parse(json));

// …or hand the tunnel agents to axios / got / node-fetch:
const axios = require('axios');
const { data } = await axios.get('https://internal.api/users', {
    httpAgent: client.getHttpAgent(),
    httpsAgent: client.getHttpsAgent()
});
```

### 2. Connect from an existing WireGuard `.conf`

Point WireShade at a standard config file — no key handling in code.

```javascript
const { WireShade } = require('wireshade');

// A standard [Interface] / [Peer] file is parsed for you.
const client = new WireShade('/etc/wireguard/wg0.conf');
await client.start();

console.log('tunnel up as', client.config.wireguard.sourceIp);
await client.close();
```

### 3. Open a raw TCP connection

Talk to any TCP service (Redis, SMTP, a game server…) over a `net.Socket`-compatible stream.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// A net.Socket-compatible stream straight through the tunnel:
const socket = client.connect({ host: '10.0.0.5', port: 6379 });
socket.on('connect', () => socket.write('PING\r\n'));
socket.on('data', (data) => console.log('reply:', data.toString()));
socket.on('error', (err) => console.error(err.message));
```

### 4. Expose a TCP service inside the VPN

Run a listener on your VPN IP that other peers can dial into.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// A TCP server bound to your VPN IP — reachable by other VPN peers.
await client.listen(9000, (socket) => {
    socket.on('data', (data) => socket.write(`echo: ${data}`));
    socket.on('error', () => {});
});
console.log('listening inside the VPN on :9000');
```

### 5. Local port-forward (like `ssh -L`)

Reach a remote VPN service on a local port — e.g. a private database on `localhost`.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// localhost:5432 → 10.0.0.5:5432 inside the VPN.
await client.forwardLocal(5432, '10.0.0.5', 5432);
console.log('psql -h localhost -p 5432 now reaches the VPN database');
```

### 6. Remote port-forward (like `ssh -R`)

Publish a local service into the VPN so any peer can reach it, even behind NAT.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// Publish your local :3000 to VPN peers at <your VPN IP>:8080.
await client.forwardRemote(8080, 'localhost', 3000);
console.log('local :3000 is now reachable across the VPN on :8080');
```

### 7. Serve an Express/HTTP app through the tunnel

Bridge tunnel connections straight into a Node HTTP server — it never binds a public port.

```javascript
const express = require('express');
const http = require('http');
const { WireShade } = require('wireshade');

const app = express();
app.get('/', (req, res) => res.send('Hello from inside the VPN!'));
const server = http.createServer(app);   // built, but never binds a local port

const client = new WireShade('wg.conf');
await client.start();

// Feed tunnel connections straight into the Express HTTP server.
await client.listen(8080, (socket) => server.emit('connection', socket));
console.log('Express reachable at http://<your VPN IP>:8080');
```

### 8. Map hostnames to VPN IPs (custom DNS)

Use friendly names for VPN hosts without touching `/etc/hosts`.

```javascript
const { WireShade } = require('wireshade');

// Map names up front via the `hosts` option…
const client = new WireShade('wg.conf', {
    hosts: { 'db.internal.lan': '10.0.0.5' }
});
await client.start();

// …or add them at runtime — no /etc/hosts changes needed.
client.addHost('api.internal.lan', '10.0.0.6');

console.log(await client.get('https://api.internal.lan/status'));
```

### 9. Health-check a peer with ICMP ping

Measure round-trip time to a peer and detect when it goes dark.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

try {
    const rttMs = await client.ping('10.0.0.1');
    console.log(`peer alive — round-trip ${rttMs} ms`);
} catch {
    console.error('peer unreachable');
}
```

### 10. Punch through a firewall with WebSocket/WSS

Carry the whole tunnel over a single `wss://` port (443) to get through HTTP-only proxies and strict firewalls.

```javascript
const { WireShade, WireShadeWsServer, generateSelfSignedCert } = require('wireshade');

// --- Server peer (where you can open a port, e.g. 443) ---
const { certPem, keyPem } = generateSelfSignedCert(['vpn.example.com']);
const srv = new WireShadeWsServer({
    listen: '0.0.0.0:443',
    tls: { cert: certPem, key: keyPem },              // omit tls => plaintext ws://
    wireguard: { privateKey: '<server private key>', peerPublicKey: '<client public key>', sourceIp: '10.0.0.1' }
});
await srv.start();                                     // resolves once bound & listening

// --- Client peer (behind the restrictive firewall) ---
const client = new WireShade({
    wireguard: { privateKey: '<client private key>', peerPublicKey: '<server public key>', sourceIp: '10.0.0.2' },
    transport: {
        type: 'websocket',
        url: 'wss://vpn.example.com:443',              // whole tunnel over one TLS port
        tls: { ca: certPem }                           // pin the self-signed cert
    }
});
await client.start();
console.log(await client.get('http://10.0.0.1/'));
```

### 🍳 More recipes

Seven more field-tested patterns — same self-contained style, numbered on from the ten above.

### 11. Reuse an existing DB / Redis client, unchanged

Forward the remote port to `localhost`, then point your existing driver at it — the library itself needs no changes.

```javascript
const { WireShade } = require('wireshade');
const { Client } = require('pg');            // your existing DB driver — untouched

const wg = new WireShade('wg.conf');
await wg.start();

// localhost:5432 → 10.0.0.5:5432 inside the VPN.
await wg.forwardLocal(5432, '10.0.0.5', 5432);

// Point the *unmodified* pg / ioredis client at the local end of the forward:
const db = new Client({ host: 'localhost', port: 5432, user: 'app', database: 'prod' });
await db.connect();
// const redis = new Redis({ host: 'localhost', port: 6379 });  // ioredis — same idea
```

### 12. SSH into a VPN host through a forwarded port

Expose a peer's SSH port on `localhost` and connect with a stock `ssh` client.

```javascript
const { WireShade } = require('wireshade');

const wg = new WireShade('wg.conf');
await wg.start();

// localhost:2222 → 10.0.0.9:22 inside the VPN.
await wg.forwardLocal(2222, '10.0.0.9', 22);
console.log('tunnel ready — now: ssh -p 2222 user@localhost');
```

```bash
ssh -p 2222 user@localhost
```

### 13. Peer-to-peer VPN between two peers — no central server

Two WireShade peers form a direct tunnel: one listens, the other dials in.

```javascript
const { WireShade, generateKeyPair } = require('wireshade');

const a = generateKeyPair();
const b = generateKeyPair();

// Two peers, no central server: A listens on a UDP port, B dials into it.
const peerA = new WireShade({
    wireguard: {
        privateKey: a.privateKey, peerPublicKey: b.publicKey,
        endpoint: '127.0.0.1:51821', sourceIp: '10.0.0.1', listenPort: 51820
    }
});
const peerB = new WireShade({
    wireguard: {
        privateKey: b.privateKey, peerPublicKey: a.publicKey,
        endpoint: '127.0.0.1:51820', sourceIp: '10.0.0.2', listenPort: 51821
    }
});

// start() resolves only after a real handshake, so bring both up together.
await Promise.all([peerA.start(), peerB.start()]);

await peerA.listen(9000, (socket) => socket.end('hello from A'));
const socket = peerB.connect({ host: '10.0.0.1', port: 9000 });
socket.on('data', (d) => console.log('B received:', d.toString()));
```

### 14. Survive drops with auto-reconnect, events, and health checks

Turn on backoff-based reconnection and watch the tunnel's lifecycle through events.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf', {
    reconnect: {
        enabled: true,             // auto-reconnect when the tunnel drops
        maxAttempts: 0,            // 0 = retry forever
        delay: 1000,               // first retry after 1 s
        maxDelay: 30000,           // cap the backoff at 30 s
        backoffMultiplier: 2,      // double the delay each attempt
        healthCheckInterval: 60000 // probe the tunnel every 60 s
    }
});

client.on('stateChange', (state) => console.log('state:', state));
client.on('disconnect', (err) => console.warn('tunnel down:', err?.message));
client.on('reconnect', () => console.log('tunnel restored'));

await client.start();
```

### 15. Run in CI / serverless / containers — without root

No TUN device and no privileges required, so the tunnel works where a kernel VPN can't.

```javascript
const { WireShade } = require('wireshade');

// Self-contained handler — no TUN device, no root, no admin rights.
// Runs as-is in AWS Lambda, GitHub Actions, or an unprivileged container.
exports.handler = async () => {
    const client = new WireShade('wg.conf');
    await client.start();
    try {
        return await client.get('https://10.0.0.1/api/health');
    } finally {
        await client.close();
    }
};
```

### 16. Plaintext `ws://` behind a TLS-terminating reverse proxy

Let nginx/Caddy handle TLS and keep the WireShade side plaintext.

```javascript
const { WireShade } = require('wireshade');

// nginx / Caddy terminates TLS at the edge and proxies to a plaintext ws://
// backend, so the client speaks ws:// and WireShade handles no certificates.
const client = new WireShade({
    wireguard: { privateKey: '<client private key>', peerPublicKey: '<server public key>', sourceIp: '10.0.0.2' },
    transport: {
        type: 'websocket',
        url: 'ws://vpn.example.com',   // the proxy upgrades this to the WS server
        pathPrefix: 'wg'               // e.g. proxy route /wg → the WireShade WS server
    }
});
await client.start();
console.log(await client.get('http://10.0.0.1/'));
```

### 17. Expose the whole VPN as a SOCKS5 proxy

Run a local SOCKS5 proxy that routes every connection through the tunnel — any SOCKS5-aware app can then reach any host inside the VPN, with no per-service forward.

```js
const { WireShadeClient } = require('wireshade');
const client = new WireShadeClient('wg0.conf');
await client.start();
// dynamic proxy: any SOCKS5 app can now reach any host inside the VPN
await client.socks(1080);                       // 127.0.0.1:1080, no auth
// with auth:  await client.socks(1080, '127.0.0.1', { auth: { username:'alice', password:'secret' } });
// in-tunnel DNS:  await client.socks(1080, '127.0.0.1', { dns: '10.0.0.1' });
// then: curl --socks5-hostname 127.0.0.1:1080 http://10.0.0.5/
```

The CLI does exactly this without writing any code: `wireshade socks -c wg0.conf`.

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
| `14_socks_proxy.js` | SOCKS5 proxy over the tunnel. |
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
