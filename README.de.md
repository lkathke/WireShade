# 👻 WireShade - Node.js WireGuard Client

**Die ultimative Userspace WireGuard® Implementierung für Node.js**

[![npm version](https://img.shields.io/npm/v/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**WireShade** ermöglicht es deiner Node.js-Anwendung, sich direkt mit einem WireGuard-VPN zu verbinden – **ohne Root-Rechte**, Kernel-Module oder Änderungen an den Systemeinstellungen. Es läuft vollständig im Userspace unter Verwendung eines benutzerdefinierten Rust-basierten TCP/IP-Stacks (`smoltcp`), der direkt in Node.js integriert ist.

<div align="center">

[🇺🇸 English](README.md) | [🇩🇪 Deutsch](README.de.md) | [🇪🇸 Español](README.es.md) | [🇫🇷 Français](README.fr.md) | [🇨🇳 中文](README.zh.md)

</div>

---

## 🚀 Warum WireShade?

WireShade löst komplexe Netzwerk-Herausforderungen mit einer sauberen, nativen Lösung:

*   **🛡️ Sicherheit & Stealth:** Route spezifischen Node.js-Traffic durch ein sicheres WireGuard-VPN, während der Rest deines Systems das normale Internet nutzt. Perfekt für **Web-Scraping**, **Bots** oder **sichere Kommunikation**.
*   **🌍 Reverse Tunneling:** Mache einen lokalen Express-Server, WebSocket-Server oder Next.js App im privaten VPN-Netzwerk verfügbar, selbst hinter NAT oder Firewalls.
*   **🔌 Zero-Config Client:** Keine Installation von WireGuard auf dem Host-System notwendig. Einfach `npm install` und loslegen.
*   **🔄 Automatischer Reconnect:** Eingebaute Logik, um Verbindungsabbrüche und Netzwerkwechsel nahtlos zu handhaben.
*   **⚡ Hohe Performance:** Angetrieben durch Rust und NAPI-RS für nahezu native Geschwindigkeit.

## 🧠 Wie es funktioniert (Technical Deep Dive)

WireShade umgeht den Netzwerkstack des Host-Betriebssystems, indem es einen **Userspace TCP/IP-Stack** ([smoltcp](https://github.com/smoltcp-rs/smoltcp)) direkt in deinem Node.js-Prozess ausführt.

1.  **Handshake:** WireShade baut einen WireGuard-Handshake über UDP auf.
2.  **Kapselung:** IP-Pakete werden verschlüsselt und in UDP-Pakete verpackt.
3.  **Userspace Routing:** Entschlüsselte Pakete werden von `smoltcp` in Rust verarbeitet (TCP-State, Retransmission, Buffering).
4.  **Node.js Integration:** Daten fließen über hochperformante NAPI-Bindings zwischen Rust-Streams und Node.js `net.Socket`/`http.Agent`-Instanzen.

Diese Architektur bedeutet:
- **Kein virtuelles Netzwerkinterface (TUN/TAP)** wird auf deinem OS erstellt.
- **Root-Rechte sind NICHT erforderlich.**
- **Kein Konflikt** mit bestehenden VPNs oder Systemnetzwerken.
- **Plattformunabhängige** Kompatibilität (Windows, macOS, Linux, **Raspberry Pi**, Docker Container) ohne Kernel-Module.

## 📦 Installation

```bash
npm install wireshade
```

---

## 🛠️ Anwendungsbeispiele

Alle Beispiele gehen davon aus, dass der Client initialisiert ist:
```javascript
const { WireShade, readConfig } = require('wireshade');
const client = new WireShade(readConfig('./wg0.conf'));
await client.start();
```

### 1. HTTP/HTTPS Requests (Client)
Nutze WireShade als transparenten Agent für deine Requests.

**Vereinfachte API:**
```javascript
const html = await client.get('https://internal.service/api');
console.log(html);
```

**Natives `http`/`https` Modul:**
```javascript
const https = require('https');

https.get('https://api.internal/data', { agent: client.getHttpsAgent() }, (res) => {
    res.pipe(process.stdout);
});
```

**Axios:**
```javascript
const axios = require('axios');

// Nutze die Agents in der Axios-Config
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

### 2. TCP & WebSockets ins VPN (Client)
Verbinde dich zu reinen TCP-Diensten oder WebSockets, die im VPN laufen.

**Raw TCP:**
```javascript
const socket = client.connect({ host: '10.0.0.5', port: 22 });
socket.write('SSH-2.0-MyClient\r\n');
```

**WebSockets (mit `ws` Library):**
```javascript
const WebSocket = require('ws');

// Nutze den WireShade Agent für den Handshake
const ws = new WebSocket('ws://10.0.0.5:8080/stream', {
    agent: client.getHttpAgent() 
});

ws.on('open', () => console.log('Verbunden mit VPN WebSocket!'));
```

### 3. Server veröffentlichen (Express, Next.js, WebSockets)
Mache deinen lokalen Server **nur** über das VPN erreichbar (Reverse Tunneling).

**Express / Next.js / Fastify:**
```javascript
const express = require('express');
const http = require('http');
const { WireShadeServer } = require('wireshade');

// 1. Setup der App
const app = express();
app.get('/', (req, res) => res.send('🎉 Versteckt im VPN!'));

// 2. HTTP Server vorbereiten (noch nicht listen())
const httpServer = http.createServer(app);

// 3. Auf dem VPN lauschen
const vpnServer = new WireShadeServer(client);
vpnServer.on('connection', (socket) => {
    httpServer.emit('connection', socket); // Leite VPN-Socket an HTTP-Server
});

await vpnServer.listen(80); // Lausche auf Port 80 der VPN-IP
console.log('Server online unter http://<VPN-IP>/');
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
WireShade unterstützt sowohl **Local Forwarding** (Zugriff auf VPN-Dienst lokal) als auch **Remote Forwarding** (Lokalen Dienst ins VPN stellen).

**Local Forwarding (VPN -> Localhost):**
Greife auf eine PostgreSQL-Datenbank (`10.0.0.5:5432`) im VPN über `localhost:3333` zu.
```javascript
await client.forwardLocal(3333, '10.0.0.5', 5432);
console.log('Verbinde deinen DB-Client mit localhost:3333');
```

**Remote Forwarding (Localhost -> VPN):**
Stelle deinen lokalen Entwicklungsserver (`localhost:3000`) im VPN auf Port `8080` bereit.
```javascript
// Lausche auf VPN Port 8080 -> Leite weiter an localhost:3000
await client.forwardRemote(8080, 'localhost', 3000);
console.log('VPN-Nutzer können deinen Server unter http://<VPN-IP>:8080 erreichen');
```

---

## ⚙️ Konfiguration & Features

### Auto-Reconnection (Verbindungswiederherstellung)
WireShade enthält robuste Logik für Reconnects.

```javascript
const client = new WireShadeClient({
    wireguard: { ... },
    reconnect: {
        enabled: true,
        maxAttempts: 10,
        delay: 1000,
        backoffMultiplier: 1.5
    }
});

client.on('reconnecting', (attempt) => console.log(`🔄 Verbinde neu... (${attempt})`));
```

### Custom DNS / Hosts
Mappe interne VPN-Hostnamen auf IP-Adressen, ohne `/etc/hosts` anzufassen.

```javascript
const client = new WireShadeClient({
    wireguard: { ... },
    hosts: {
        'intern-api.local': '10.0.0.4',
        'db-prod': '10.0.0.5'
    }
});
```

## 📚 API Referenz

**`new WireShadeClient(config)`**
- Erstellt eine neue VPN-Instanz. `config` entspricht den Standard-WireGuard-Parametern (`privateKey`, `endpoint`, etc.).

**`client.start()`**
- Verbindet mit dem VPN. Gibt ein `Promise` zurück, das bei Verbindung aufgelöst wird.

**`client.get(url, [options])`**
- Helper für einfache HTTP GET Requests durch den Tunnel. Gibt den Body zurück.

**`client.connect(options)`**
- Erstellt einen rohen TCP-Socket (`net.Socket`), der durch den Tunnel verbunden ist.

**`client.listen(port, [callback])`**
- Startet einen TCP-Server, der auf der **VPN-IP** am angegebenen Port lauscht.

**`client.forwardLocal(localPort, remoteHost, remotePort)`**
- Leitet einen lokalen Port an ein Ziel im VPN weiter.

**`client.forwardRemote(vpnPort, targetHost, targetPort)`**
- Leitet einen Port der VPN-IP an ein lokales Ziel weiter (Reverse Port Forwarding).

**`client.getHttpAgent() / client.getHttpsAgent()`**
- Gibt einen Node.js `http.Agent` / `https.Agent` zurück, der so konfiguriert ist, dass er Traffic durch den Tunnel leitet.

---

---

## 🎯 Use Cases (Einsatzgebiete)

*   **Microservices Kommunikation:** Verbinde sichere Dienste über verschiedene Clouds hinweg, ohne öffentliche Ports zu öffnen.
*   **Web Scraping:** Rotiere IP-Adressen durch Erstellung mehrerer WireShade-Instanzen mit verschiedenen VPN-Endpunkten.
*   **Entwickler-Zugang:** Gib Entwicklern sicheren Zugriff auf interne Datenbanken direkt von ihrem lokalen Rechner.
*   **IoT & Edge:** Verbinde Geräte hinter restriktiven Firewalls sicher mit einem zentralen Server (Reverse Tunneling).

---

## 📜 Lizenz

MIT Lizenz.

*WireGuard ist eine eingetragene Marke von Jason A. Donenfeld.*
