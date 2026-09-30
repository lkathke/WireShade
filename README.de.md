# 👻 WireShade mit Node.js

**Die ultimative Userspace-WireGuard®-Implementierung für Node.js**

[![npm version](https://img.shields.io/npm/v/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![npm downloads](https://img.shields.io/npm/dm/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**WireShade** ermöglicht es deiner Node.js-Anwendung, sich direkt mit einem WireGuard-VPN zu verbinden – **ohne Root-Rechte**, Kernel-Module oder Änderungen an den Systemnetzwerkeinstellungen. Es läuft vollständig im Userspace mit einem benutzerdefinierten, Rust-basierten TCP/IP-Stack (`smoltcp`), der direkt in Node.js integriert ist – es wird nie ein TUN/TAP-Interface angelegt.

<div align="center">

[🇺🇸 English](README.md) | [🇩🇪 Deutsch](README.de.md) | [🇪🇸 Español](README.es.md) | [🇫🇷 Français](README.fr.md) | [🇨🇳 中文](README.zh.md)

</div>

---

## 🚀 Warum WireShade?

*   **🛡️ Tarnung & Sicherheit:** Leite gezielt bestimmten Node.js-Verkehr durch ein WireGuard-VPN, während der restliche Systemverkehr normal bleibt. Ideal für Web-Scraping, Bots oder sichere Service-zu-Service-Kommunikation.
*   **🌍 Reverse-Tunneling:** Mache einen lokalen Express-/Fastify-/Next.js-Server oder einen rohen TCP-Dienst im privaten VPN-Netzwerk verfügbar – selbst hinter NAT oder Firewall.
*   **🔌 Zero-Config-Client:** WireGuard muss nicht auf dem Host installiert sein. Einfach `npm install` und loslegen.
*   **🧱 WebSocket-/WSS-Transport:** Trage den gesamten WireGuard-Tunnel über eine einzige `ws://`- oder `wss://`-Verbindung, um restriktive Firewalls und reine HTTP-Proxys zu durchbrechen.
*   **🔄 Automatische Wiederverbindung:** Eingebautes Backoff, Health-Checks und Events, um Verbindungsabbrüche und Netzwechsel zu überstehen.
*   **⚡ Hohe Performance:** Angetrieben von Rust und NAPI-RS für nahezu native Geschwindigkeit.

## 🧠 Funktionsweise

WireShade umgeht den Netzwerk-Stack des Host-Betriebssystems, indem es einen **Userspace-TCP/IP-Stack** ([smoltcp](https://github.com/smoltcp-rs/smoltcp)) innerhalb deines Node.js-Prozesses ausführt:

1.  **Handshake:** WireShade führt einen echten WireGuard-Handshake mit dem Peer durch (über UDP oder über einen WebSocket).
2.  **Kapselung:** IP-Pakete werden verschlüsselt und in die Transport-Frames gekapselt.
3.  **Userspace-Routing:** Entschlüsselte Pakete werden von `smoltcp` in Rust verarbeitet, das TCP-Zustand, Retransmission und Pufferung verwaltet.
4.  **Node.js-Integration:** Daten wandern über performante NAPI-Bindings zwischen Rust und Node.js-`net.Socket`-/`http.Agent`-Instanzen.

Das bedeutet: **kein virtuelles Netzwerk-Interface**, **kein Root**, **kein Konflikt** mit vorhandenen VPNs und **plattformübergreifende** Unterstützung ohne Kernel-Module.

## ✅ Unterstützte Plattformen

Native Binaries sind **für die folgenden sechs Targets vorkompiliert und werden automatisch geladen** – beim `require()`, ohne Compiler oder Build-Schritt bei der Installation.

| Target-Triple | Plattform | Architektur |
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

## ⚡ Schnellstart

### Aus einem Config-Objekt

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

### Aus einer WireGuard-`.conf`-Datei

Übergib einen Pfad-String statt eines Config-Objekts – eine Standard-Datei mit `[Interface]` / `[Peer]` wird für dich geparst (inklusive `PersistentKeepalive`):

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

const body = await client.get('http://10.0.0.1/');
console.log(body);

await client.close();
```

Für echte Requests über `axios`, `node-fetch`, `ws` usw. übergibst du die Tunnel-Agents:

```javascript
const axios = require('axios');
const res = await axios.get('https://internal.service/api', {
    httpAgent: client.getHttpAgent(),
    httpsAgent: client.getHttpsAgent()
});
```

---

## 🧱 WebSocket-/WSS-Transport

Statt über UDP kann WireShade den gesamten WireGuard-Tunnel über eine **einzige WebSocket-Verbindung** tragen. Das ist der zuverlässige Weg, um restriktive Firewalls und Proxys, die nur HTTP(S) erlauben, einfach zu durchbrechen. Beide Peers sind WireShade-Instanzen: einer läuft als WS-**Server** (terminiert TLS + den Tunnel), der andere als WS-**Client**.

### Server-Peer

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

### Client-Peer

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

Alles Übrige – `connect`, `listen`, `forwardLocal`, `forwardRemote`, `ping`, die `http`/`https`-Wrapper und die automatische Wiederverbindung – funktioniert über WebSocket identisch. Siehe [`examples/13_websocket_highlevel.js`](examples/13_websocket_highlevel.js) (High-Level) und [`examples/11_websocket_wss.js`](examples/11_websocket_wss.js) (natives Binding).

**`ws://` vs. `wss://`:** Verwende reines `ws://` (lasse den Server-`tls`-Block weg), wenn TLS bereits vor WireShade von einem Reverse-Proxy wie nginx oder Caddy terminiert wird; verwende natives `wss://` (mit `tls: { cert, key }`), damit WireShade TLS selbst terminiert. Auf Client-Seite pinnt `tls.ca` ein bestimmtes Zertifikat, `tls.servername` überschreibt die SNI, und `tls.insecureSkipVerify` deaktiviert die Prüfung vollständig – **nur zum Testen, niemals in Produktion**.

> **Kompromiss – TCP über TCP:** Der WebSocket-Transport tunnelt WireGuard (und damit dein inneres TCP) innerhalb eines äußeren TCP/TLS-Streams. Das ist hervorragend für Firewall-/Proxy-Durchdringung und zuverlässige, geordnete Verbindungen, doch auf verlustreichen oder stark schwankenden Strecken können sich die beiden gestapelten Congestion-Control-Schleifen gegenseitig behindern („TCP-Meltdown"). Ist das Netz unzuverlässig, verhält sich der reine UDP-Transport meist besser; wenn du einfach nur durchkommen musst, gewinnt WebSocket.

---

## 📖 Kern-API

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
Erzeugt einen Client aus einem Config-Objekt oder aus einem Pfad zu einer `.conf`-Datei (`new WireShade('wg.conf')`). `config.wireguard` nimmt die üblichen WireGuard-Felder: `privateKey`, `peerPublicKey`, `presharedKey`, `endpoint`, `sourceIp`, `listenPort`, `persistentKeepalive`. `persistentKeepalive` ist in Sekunden (`PersistentKeepalive` in `.conf`-Dateien), Standard `25`, und `0` deaktiviert es. Weitere Optionen: `logging` (Standard `true`), `handshakeTimeout` (ms, Standard `10000`), `hosts`, `reconnect`, `transport` sowie `onConnect`/`onDisconnect`/`onReconnect`.

**`client.start()`** → `Promise<void>`
Verbindet und resolvt, **sobald der echte WireGuard-Handshake mit dem Peer abgeschlossen ist** (rejectet bei Timeout, DNS-/Bind-Fehler oder wenn `close()` zuerst aufgerufen wird). Wenn beide Peers WireShade-Instanzen sind, starte sie nebenläufig: `Promise.all([a.start(), b.start()])`.

**`client.close()`** → `Promise<void>`
Stoppt Wiederverbindungen und Health-Checks, schließt alle Server/Verbindungen und fährt den nativen Tunnel herunter. Resolvt, sobald der native Task gestoppt ist. (`close()` ist das High-Level-Äquivalent des nativen `shutdown()`.)

**Wiederverbindung** – über den `reconnect`-Block konfigurierbar; Zustandsänderungen erscheinen als Events:

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

Registrierte Listener (`listen`/`forwardRemote`) werden nach einer Wiederverbindung automatisch auf dem neuen Tunnel neu erstellt.

**`client.ping(ip)`** → `Promise<number>` – ICMP-Echo; resolvt mit der Round-Trip-Zeit in ms.

**`client.connect({ host, port })`** → `Duplex` – ein `net.Socket`-kompatibler Stream durch den Tunnel. Emittiert `'connect'`, `'data'`, `'end'`, `'error'`.

**`client.listen(port, [onConnection])`** → `Promise<Server>` – ein TCP-Server auf der **VPN-IP**; `onConnection` erhält pro Verbindung einen Socket.

**`client.forwardLocal(localPort, remoteHost, remotePort)`** → `Promise` – macht einen VPN-seitigen Dienst auf deinem lokalen Rechner verfügbar (`localhost:localPort` → `remoteHost:remotePort` im VPN).

**`client.forwardRemote(vpnPort, targetHost, targetPort)`** → `Promise` – macht einen lokalen Dienst für VPN-Peers verfügbar (VPN-IP `:vpnPort` → `targetHost:targetPort` auf deinem Rechner).

```javascript
await client.forwardLocal(3333, '10.0.0.5', 5432);   // reach VPN Postgres via localhost:3333
await client.forwardRemote(8080, 'localhost', 3000); // publish local :3000 on the VPN at :8080
```

**`client.get(url, [opts])` / `client.request(url, [opts])`** → `Promise<string | object>` – HTTP(S) durch den Tunnel. Resolvt mit dem Body-String (`opts.encoding`, Standard `utf8`); mit `opts.fullResponse: true` mit `{ statusCode, statusMessage, headers, body, rawBody }`. `opts.body` setzt einen Request-Body.

**`client.getHttpAgent()` / `client.getHttpsAgent()`** – `http.Agent` / `https.Agent`, die durch den Tunnel routen (für `axios`, `node-fetch`, `ws`, …).

**`client.addHost(hostname, ip)`** – ordnet einen Hostnamen einer VPN-IP zu, ohne `/etc/hosts` anzufassen; die Zuordnung gilt für die eigenen Requests und Weiterleitungen des Clients.

**`generateKeyPair()`** → `{ privateKey, publicKey }` – ein frisches WireGuard-Schlüsselpaar.

**`parseConfig(text)` / `readConfig(path)`** – parst eine WireGuard-Konfiguration aus einem String oder einer Datei in ein Config-Objekt.

**`generateSelfSignedCert(sans)`** → `{ certPem, keyPem }` – ein selbstsigniertes Zertifikat + Schlüssel (PEM) für die angegebenen Subject Alternative Names, praktisch für `wss://` in Dev/Test ohne OpenSSL.

**`new WireShadeWsServer({ listen, pathPrefix, tls, wireguard, ... })`** – der WebSocket-Server-Peer. `listen` ist `"host:port"`; gib `tls: { cert, key }` für `wss://` an oder lasse es für `ws://` weg. Sein `start()` resolvt, sobald der Socket **gebunden ist und lauscht** (bevor irgendein Peer den Handshake macht), sodass du `listen`/`forwardRemote` sofort registrieren kannst. Alle anderen `WireShadeClient`-Methoden und -Events gelten ebenso.

---

## 📊 Benchmarks

WireShade bringt zwei Benchmark-Skripte mit. Die Werte sind maschinenabhängig, führe sie also selbst aus.

```bash
# Raw tunnel goodput + CPU-per-core on loopback (crypto/CPU cost, not RTT/loss):
BENCH_TRANSPORT=udp BENCH_SECONDS=5 BENCH_CHUNK=262144 node bench/throughput.js
#   BENCH_TRANSPORT = udp | ws | wss

# Real iperf3 driven through the tunnel (needs iperf3 in PATH; skips cleanly if absent):
BENCH_TRANSPORT=udp node bench/iperf3.js
```

`bench/throughput.js` misst den Goodput und die CPU-Kosten pro Kern des gesamten Pfades (WireGuard-Krypto + `smoltcp` + die NAPI-Grenze) über Loopback – es isoliert den Krypto-/CPU-Durchsatz, nicht Netzlatenz oder -verlust. `bench/iperf3.js` treibt ein echtes `iperf3`-Client/Server-Paar durch den Tunnel für einen branchenüblichen Wert und überspringt automatisch (Exit 0), falls `iperf3` nicht installiert ist.

---

## 📚 Beispiele

Ausführbare Skripte liegen in [`examples/`](examples/):

| Datei | Zeigt |
| :--- | :--- |
| `01_quickstart.js` | Verbinden, Request und Listen – das „Hello World". |
| `02_http_request.js` | Einfacher HTTP-GET mit `client.get()`. |
| `03_https_custom_dns.js` | HTTPS mit einem auf eine VPN-IP gemappten Hostnamen. |
| `04_tcp_socket.js` | Rohes TCP-Senden/-Empfangen durch den Tunnel. |
| `05_internet_routing.js` | Internetverkehr über das VPN-Gateway hinausleiten. |
| `06_simple_server.js` | Einen TCP-/HTTP-Server im Tunnel hosten. |
| `07_express_app.js` | Eine Express-App über das VPN verfügbar machen (Reverse-Tunnel). |
| `08_local_forwarding.js` | `forwardLocal` – einen VPN-Dienst über `localhost` erreichen. |
| `09_reconnect_config.js` | Wiederverbindung, Health-Checks und Event-Monitoring. |
| `10_remote_forwarding.js` | `forwardRemote` – einen lokalen Dienst im VPN veröffentlichen. |
| `11_websocket_wss.js` | WireGuard über WSS mit dem **nativen** Binding. |
| `13_websocket_highlevel.js` | WireGuard über WSS mit der **High-Level**-API. |
| `local_vpn.js` | Zwei lokale Peers, die zum Testen einen P2P-Tunnel bilden. |

---

## 🎯 Anwendungsfälle

*   **Microservices:** Dienste über Clouds hinweg verbinden, ohne öffentliche Ports zu öffnen.
*   **Web-Scraping:** mehrere Instanzen an verschiedenen Endpoints betreiben, um Egress-IPs zu rotieren.
*   **Entwickler-Zugriff:** private interne Datenbanken sicher vom Laptop erreichen.
*   **IoT & Edge:** Geräte hinter restriktiven NATs zurück zu einem zentralen Server verbinden.

---

## 📜 Lizenz

MIT-Lizenz.

*WireGuard ist eine eingetragene Marke von Jason A. Donenfeld.*
</content>
