# 👻 WireShade using Node.js

**The Ultimate Userspace WireGuard® Implementation for Node.js**

[![npm version](https://img.shields.io/npm/v/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**WireShade** enables your Node.js application to connect directly to a WireGuard VPN **without root privileges**, kernel modules, or modifying system network settings. It runs entirely in userspace using a custom Rust-based TCP/IP stack (`smoltcp`) integrated directly into Node.js.

<div align="center">

[🇺🇸 English](README.md) | [🇩🇪 Deutsch](README.de.md) | [🇪🇸 Español](README.es.md) | [🇫🇷 Français](README.fr.md) | [🇨🇳 中文](README.zh.md)

</div>

---

## 🚀 Why WireShade?

WireShade solves complex networking implementation challenges with a clean, native userspace solution:

*   **🛡️ Stealth & Security:** Route specific Node.js traffic through a secure WireGuard VPN while keeping the rest of your system traffic normal. Perfect for **web scraping**, **bots**, or **secure communication**.
*   **🌍 Reverse Tunneling:** Expose a local Express server, WebSocket server, or Next.js app to the private VPN network, even if you are behind a NAT or firewall.
*   **🔌 Zero-Config Client:** No need to install WireGuard on the host machine. Just `npm install` and go.
*   **🔄 Automatic Reconnection:** Built-in logic to handle connection drops and network changes seamlessly.
*   **⚡ High Performance:** Powered by Rust and NAPI-RS for near-native performance.

## 🧠 How it Works (Technical Deep Dive)

WireShade bypasses the host operating system's network stack by running a **userspace TCP/IP stack** ([smoltcp](https://github.com/smoltcp-rs/smoltcp)) inside your Node.js process. 

1.  **Handshake:** WireShade establishes a WireGuard handshake over UDP.
2.  **Encapsulation:** IP packets are encrypted and encapsulated within UDP packets.
3.  **Userspace Routing:** Decrypted packets are handled by `smoltcp` in Rust, which manages TCP state, retransmission, and buffering.
4.  **Node.js Integration:** Data moves between Rust streams and Node.js `net.Socket`/`http.Agent` instances via high-performance NAPI bindings.

This architecture means:
- **No Virtual Network Interface (TUN/TAP)** is created on your OS.
- **Root privileges are NOT required.**
- **No conflict** with existing VPNs or system networking.
- **Cross-platform** compatibility (Windows, macOS, Linux, **Raspberry Pi**, Docker containers) without kernel modules.

## 📦 Installation

```bash
npm install wireshade
```

_Note: Windows users need basic build tools (Visual Studio Build Tools) if prebuilds are not available, but prebuilt binaries are planned._

---

## 🛠️ Usage Examples

All examples assume you have initialized the client:
```javascript
const { WireShade, readConfig } = require('wireshade');
const client = new WireShade(readConfig('./wg0.conf'));
await client.start();
```

### 1. HTTP/HTTPS Requests (Client)
Use WireShade as a transparent agent for your requests.

**Simplified API:**
```javascript
const html = await client.get('https://internal.service/api');
console.log(html);
```

> **Note on DNS:** You can map custom hostnames like `internal.service` directly to IP addresses in the `hosts` configuration. WireShade will automatically intercept and resolve these names during the request.

**Native `http`/`https` Module:**
```javascript
const https = require('https');

https.get('https://api.internal/data', { agent: client.getHttpsAgent() }, (res) => {
    res.pipe(process.stdout);
});
```

**Axios:**
```javascript
const axios = require('axios');

// Configure Axios to use the VPN agent
const response = await axios.get('https://internal.service/api', {
    httpAgent: client.getHttpAgent(),
    httpsAgent: client.getHttpsAgent()
});
```

**Fetch (`node-fetch`):**
```javascript
const fetch = require('node-fetch');

const response = await fetch('https://internal.service/api', {
    agent: (parsedUrl) => {
        return parsedUrl.protocol === 'https:' 
            ? client.getHttpsAgent() 
            : client.getHttpAgent();
    }
});
```

### 2. TCP & WebSockets to VPN (Client)
Connect to raw TCP services or WebSockets running inside the VPN.

**Raw TCP:**
```javascript
const socket = client.connect({ host: '10.0.0.5', port: 22 });
socket.write('SSH-2.0-MyClient\r\n');
```

**WebSockets (using `ws` library):**
```javascript
const WebSocket = require('ws');

// Use the WireShade agent for the handshake
const ws = new WebSocket('ws://10.0.0.5:8080/stream', {
    agent: client.getHttpAgent() 
});

ws.on('open', () => console.log('Connected to VPN WebSocket!'));
```

### 3. Expose Local Servers (Express, Next.js, WebSockets)
Make your local server accessible **only** via the VPN (Reverse Tunneling).

**Express / Next.js / Fastify:**
```javascript
const express = require('express');
const http = require('http');
const { WireShadeServer } = require('wireshade');

// 1. Setup your App
const app = express();
app.get('/', (req, res) => res.send('🎉 Hidden inside the VPN!'));

// 2. Create standard HTTP server (not listening yet)
const httpServer = http.createServer(app);

// 3. Listen on the VPN
const vpnServer = new WireShadeServer(client);
vpnServer.on('connection', (socket) => {
    httpServer.emit('connection', socket); // Feed VPN socket to HTTP server
});

await vpnServer.listen(80); // Listen on Port 80 of the VPN IP
console.log('Server online at http://<VPN-IP>/');
```

**WebSocket Server:**
```javascript
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
});
```

### 4. Port Forwarding
WireShade supports both **Local Forwarding** (access VPN service locally) and **Remote Forwarding** (expose local service to VPN).

**Local Forwarding (VPN -> Localhost):**
Access a PostgreSQL database running at `10.0.0.5:5432` inside the VPN via `localhost:3333`.
```javascript
await client.forwardLocal(3333, '10.0.0.5', 5432);
console.log('Connect to DB at localhost:3333');
```

**Remote Forwarding (Localhost -> VPN):**
Expose your local development server (`localhost:3000`) to the VPN on port `8080`.
```javascript
// Listen on VPN Port 8080 -> Forward to localhost:3000
await client.forwardRemote(8080, 'localhost', 3000);
console.log('VPN users can access your dev server at http://<VPN-IP>:8080');
```

---

## ⚙️ Configuration & Features

### Auto-Reconnection
WireShade includes robust reconnection logic.

```javascript
const client = new WireShade({
    wireguard: { ... },
    reconnect: {
        enabled: true,
        maxAttempts: 10,
        delay: 1000,           // Start with 1s delay
        backoffMultiplier: 1.5 // Exponential backoff
    }
});

client.on('reconnecting', (attempt) => console.log(`🔄 Reconnecting... (${attempt})`));
```

### Custom DNS / Hosts
Map internal VPN hostnames to IPs without touching `/etc/hosts`.

```javascript
const client = new WireShade({
    wireguard: { ... },
    hosts: {
        'internal-api.local': '10.0.0.4',
        'db-prod': '10.0.0.5'
    }
});
```

## 📚 API Reference

**`new WireShade(config)`**
- Creates a new VPN instance. `config` matches standard WireGuard parameters (`privateKey`, `endpoint`, etc.).

**`client.start()`**
- Connects to the VPN. Returns a `Promise` that resolves on connection.

**`client.get(url, [options])`**
- Helper to make a simple HTTP GET request through the VPN. Returns connection body.

**`client.connect(options)`**
- Creates a raw TCP socket (`net.Socket`) connected through the tunnel.

**`client.listen(port, [callback])`**
- Starts a TCP server listening on the **VPN IP** at the specified port.

**`client.forwardLocal(localPort, remoteHost, remotePort)`**
- Forwards a local port to a remote destination inside the VPN.

**`client.forwardRemote(vpnPort, targetHost, targetPort)`**
- Forwards a listener on the VPN IP to a target on your local machine.

**`client.getHttpAgent() / client.getHttpsAgent()`**
- Returns a Node.js `http.Agent` / `https.Agent` configured to route traffic through the tunnel.

---

---

## 🎯 Use Cases

*   **Microservices Communication:** Connect secure microservices across different clouds without exposing public ports.
*   **Web Scraping:** Rotate IP addresses by creating multiple WireShade instances connected to different VPN endpoints.
*   **Development Access:** Give developers access to private internal databases from their local machines securely.
*   **IoT & Edge:** Connect edge devices behind restrictive NATs back to a central server using server mode.

---

## 📜 License

MIT License.

*WireGuard is a registered trademark of Jason A. Donenfeld.*
