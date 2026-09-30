# 👻 WireShade mit Node.js

**Userspace-WireGuard® für Node.js — eine Bibliothek *und* eine SSH-artige CLI (SOCKS5, Port-Weiterleitung, `ssh`), die über UDP oder WebSocket läuft, ohne Root oder TUN-Gerät.**

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

## 🖥️ Kommandozeilen-Schnittstelle (CLI)

WireShade bringt einen `wireshade`-Befehl mit, der einen Tunnel aufbaut und einen lokalen **SOCKS5-Proxy** bereitstellt — ganz ohne Code. Installiere ihn global oder führe ihn bei Bedarf mit `npx` aus. Dank des npm-Bin-Shims verhält er sich unter **Windows, macOS und Linux** identisch.

```bash
npm i -g wireshade        # installs the `wireshade` command globally
# …or run it without installing:
npx wireshade socks -c wg0.conf
```

### Befehle

| Befehl | Beschreibung |
| :--- | :--- |
| `wireshade ssh [options] [user@]host [-- cmd]` | Per SSH über den Tunnel zu einem Host verbinden |
| `wireshade socks [options]` | Verbinden und einen lokalen SOCKS5-Proxy bereitstellen |
| `wireshade forward [options]` | Verbinden und Ports weiterleiten (`-L` / `-R`, wie `ssh`) |
| `wireshade unset-proxy` | System-Proxy-Einstellungen wiederherstellen (Absturz-Wiederherstellung) |
| `wireshade genkey` | Ein neues WireGuard-Schlüsselpaar ausgeben |
| `wireshade version` | Die Version ausgeben |
| `wireshade help` | Hilfe anzeigen |

### Häufige Beispiele

```bash
# SSH to a host inside the VPN (WireGuard over UDP or WebSocket)
wireshade ssh -c wg0.conf admin@10.0.0.9

# ...over WebSocket, running a one-off remote command
wireshade ssh -c wg0.conf -t wss --url wss://vpn.example.com:443 admin@10.0.0.9 -- uptime

# SOCKS5 proxy, launch Chrome through it (WireGuard over WebSocket/WSS)
wireshade socks -c wg0.conf -t wss --url wss://vpn.example.com:443 --chrome https://example.internal

# SOCKS5 proxy for the whole system (restored on exit)
wireshade socks -c wg0.conf --set-system-proxy

# Forward a local port into the VPN (like ssh -L)
wireshade forward -c wg0.conf -L 8080:10.0.0.5:80

# Reverse forward + a DB port, both directions at once (like ssh -R / -L)
wireshade forward -c wg0.conf -R 2222:127.0.0.1:22 -L 5432:10.0.0.9:5432
```

`wireshade ssh` leitet einen ephemeren lokalen Port über den Tunnel an den Port `:22` des Hosts weiter und führt darauf dein System-`ssh` aus. Nutze `--port` für einen abweichenden SSH-Port und `-- <args>`, um einen Remote-Befehl oder zusätzliche `ssh`-Argumente zu übergeben. Der System-`ssh`-Client muss installiert sein.

### `socks`-Optionen

| Option | Beschreibung |
| :--- | :--- |
| `-c, --config <file>` | WireGuard-`.conf`-Datei (`[Interface]` + `[Peer]`) |
| `--private-key <b64>` | Privater Schlüssel des Interface (wenn kein `--config`) |
| `--peer-key <b64>` | Öffentlicher Schlüssel des Peers (wenn kein `--config`) |
| `--psk <b64>` | Pre-shared Key (optional) |
| `--endpoint <host:port>` | WireGuard-UDP-Endpunkt (wenn kein `--config`) |
| `--source-ip <ip>` | Tunnel-Quell-IP, z. B. `10.0.0.2` (wenn kein `--config`) |
| `--keepalive <sec>` | Persistent Keepalive (Standard `25`) |
| `-t, --transport <udp\|ws\|wss>` | Träger-Transport (Standard `udp`) |
| `--url <ws[s]://host:port>` | WS-Server-URL (erforderlich für `ws`/`wss`) |
| `--path-prefix <p>` | WS-Upgrade-Pfadpräfix |
| `--ca <file>` | PEM-Zertifikat anheften (`wss`, selbstsigniert) |
| `--insecure` | TLS-Verifizierung überspringen (nur zum Testen) |
| `-l, --listen <[host:]port>` | Lokale SOCKS5-Bindung (Standard `127.0.0.1:1080`) |
| `--auth <user:pass>` | SOCKS5-Benutzername/Passwort verlangen |
| `--dns <ip>` | Hostnamen über diesen DNS-Server durch den Tunnel auflösen (DNS-over-TCP); Standard ist der `DNS =`-Wert der `.conf` |
| `--set-system-proxy` | Das Betriebssystem auf diesen Proxy ausrichten; beim Beenden automatisch wiederhergestellt |
| `--proxy-method <pac\|registry>` | Nur Windows; `pac` (Standard) = echtes SOCKS5 über eine PAC-Datei, `registry` = `socks=`-Eintrag (Browser behandeln ihn als SOCKS4) |
| `--chrome [url]` | Chrome/Edge/Chromium über diesen Proxy in einem isolierten Profil starten; das Schließen des Browsers beendet wireshade |
| `--chrome-path <file>` | Browser-Programmdatei (sonst automatisch erkannt; berücksichtigt auch `$CHROME_PATH`) |
| `-v, --verbose` | Jede weitergeleitete Verbindung protokollieren |

### `forward`-Optionen

Nutzt die **gleichen Verbindungs-Flags wie `socks`** (`-c` / `-t` / `--url` / `--ca` / …). Beide Port-Weiterleitungs-Flags sind wiederholbar.

| Option | Beschreibung |
| :--- | :--- |
| `-L <localPort:remoteHost:remotePort>` | Einen lokalen Port ins VPN weiterleiten (wie `ssh -L`) |
| `-R <vpnPort:targetHost:targetPort>` | Einen lokalen Dienst im VPN bereitstellen (wie `ssh -R`) |

### Beispiele

```bash
wireshade socks -c wg0.conf
wireshade socks -c wg0.conf -l 0.0.0.0:1080 --auth alice:secret
wireshade socks -c wg0.conf -t wss --url wss://vpn.example.com:443 --ca server.pem
wireshade socks -c wg0.conf --chrome https://example.internal
wireshade socks -c wg0.conf --set-system-proxy
```

Sobald der Proxy als lauschend gemeldet wird, richte eine beliebige SOCKS5-fähige Anwendung darauf aus:

```bash
curl --socks5-hostname 127.0.0.1:1080 http://<vpn-host>/
```

*   **proxychains:** `socks5 127.0.0.1 1080` in die `proxychains.conf` eintragen und dann `proxychains <your-app>` ausführen.
*   **Browser:** den SOCKS5-Host auf `127.0.0.1` und den Port auf `1080` setzen (SOCKS v5 mit Remote-DNS wählen, damit Hostnamen innerhalb des VPN aufgelöst werden).

**Vollständiges Internet über das VPN.** WireShade leitet **jedes** Ziel durch den Tunnel, nicht nur das VPN-eigene Subnetz — vollständiges Internet-Tunneling funktioniert also, **wenn der WireGuard-Server ein Exit-Knoten ist** (IP-Forwarding + NAT). Die öffentliche Exit-IP ist dann die des Servers; WireShade legt sie nicht fest. Mit `--dns <ip>` bleibt auch die DNS-Auflösung im Tunnel (kein Leak), was für den Full-Tunnel-Einsatz wichtig ist.

---

## 🧭 Tutorial: ein WebSocket-VPN-Server + ein Chrome-Client

Von Anfang bis Ende: Betreibe einen WireShade-**WS-Server** auf einer öffentlichen VM, stelle **nginx / Nginx Proxy Manager** mit einer echten Domain davor (TLS) und **verbinde dich dann per CLI und öffnest Chrome**, dessen Verkehr durch den Tunnel läuft — ohne Root und ohne TUN-Gerät auf beiden Seiten.

### 1. Schlüssel erzeugen

Führe dies zweimal aus — einmal für den Server, einmal für den Client — und notiere jedes Paar:

```bash
wireshade genkey
```

Der Server braucht seinen **eigenen privaten Schlüssel** + den **öffentlichen Schlüssel des Clients**; der Client braucht seinen **eigenen privaten Schlüssel** + den **öffentlichen Schlüssel des Servers**.

### 2. Der Server-Peer

Die CLI ist die Client-Seite; der WS-**Server** ist ein kurzes Skript mit `WireShadeWsServer`. Wähle eine von zwei TLS-Strategien.

**Variante A — WireShade terminiert TLS selbst (`wss://`)**

```javascript
// server.js
const { WireShadeWsServer, generateSelfSignedCert } = require('wireshade');

(async () => {
    // Bring your own PEM (e.g. Let's Encrypt), or generate a self-signed pair:
    const { certPem, keyPem } = generateSelfSignedCert(['vpn.example.com']);

    const srv = new WireShadeWsServer({
        listen: '0.0.0.0:443',
        pathPrefix: 'wg',                    // clients connect to wss://host/wg/...
        tls: { cert: certPem, key: keyPem }, // omit `tls` for plaintext ws:// (Variant B)
        wireguard: {
            privateKey: '<server private key>',
            peerPublicKey: '<client public key>',
            sourceIp: '10.0.0.1'
        }
    });

    await srv.start();                       // resolves once bound & listening
    console.log('WS VPN server up on :443, tunnel IP 10.0.0.1');

    // Expose what the client should reach — either host a service on this VM…
    await srv.listen(8080, (sock) =>
        sock.on('data', () => sock.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello')));

    // …or publish a service reachable FROM this VM (LAN web app, DB, …) into the tunnel:
    await srv.forwardRemote(80, '10.10.0.5', 80); // tunnel 10.0.0.1:80 -> internal 10.10.0.5:80
})();
```

Halte es mit `pm2` oder einer `systemd`-Unit am Laufen.

**Variante B — nginx / Nginx Proxy Manager terminiert TLS auf deiner Domain (empfohlen)**

Lass den Proxy Domain + Zertifikat verwalten und halte WireShade im Klartext auf Loopback:

```javascript
// server.js — behind a TLS-terminating reverse proxy
const { WireShadeWsServer } = require('wireshade');

(async () => {
    const srv = new WireShadeWsServer({
        listen: '127.0.0.1:8000',            // plaintext ws:// on loopback
        pathPrefix: 'wg',                    // no `tls` block: the proxy does TLS
        wireguard: {
            privateKey: '<server private key>',
            peerPublicKey: '<client public key>',
            sourceIp: '10.0.0.1'
        }
    });
    await srv.start();
    console.log('WS VPN server up on 127.0.0.1:8000 (behind the reverse proxy)');
})();
```

nginx-`server`-Block für `vpn.example.com` (Zertifikat via `certbot`):

```nginx
server {
    listen 443 ssl;
    server_name vpn.example.com;

    ssl_certificate     /etc/letsencrypt/live/vpn.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vpn.example.com/privkey.pem;

    location /wg/ {                          # must match pathPrefix
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;            # keep the long-lived tunnel open
    }
}
```

**Nginx Proxy Manager (GUI):** lege einen *Proxy Host* an → Domain `vpn.example.com`, Forward Hostname/Port `127.0.0.1` / `8000` (Schema `http`), aktiviere **Websockets Support**, fordere im *SSL*-Tab ein Let's-Encrypt-Zertifikat an und füge im *Advanced*-Tab einen `location /wg/ { … }`-Block mit denselben `Upgrade`/`Connection`-Headern hinzu, damit der Path-Prefix passt.

### 3. Vom Client verbinden und Chrome starten

Ein einziger CLI-Befehl öffnet den Tunnel über WSS und startet ein **isoliertes Chrome**, dessen Verkehr hindurchläuft:

```bash
wireshade socks \
  -t wss --url wss://vpn.example.com:443 --path-prefix wg \
  --private-key '<client private key>' \
  --peer-key    '<server public key>' \
  --source-ip   10.0.0.2 \
  --dns 10.0.0.1 \
  --chrome http://10.0.0.1:8080/
```

Das Schließen dieses Chrome-Fensters beendet `wireshade` und baut den Tunnel ab. Lieber eine Datei? Eine Client-`.conf` geht auch — beachte: WireShades Parser verlangt weiterhin eine `Endpoint`-Zeile, die der WS-Transport ignoriert:

```ini
# client-wg.conf
[Interface]
PrivateKey = <client private key>
Address    = 10.0.0.2/32
DNS        = 10.0.0.1

[Peer]
PublicKey = <server public key>
Endpoint  = vpn.example.com:443   # required by the parser; unused for ws/wss
```

```bash
wireshade socks -c client-wg.conf -t wss --url wss://vpn.example.com:443 --path-prefix wg --chrome http://10.0.0.1:8080/
```

> **Reichweite des WS-Servers.** Ein Userspace-WireShade-WS-Peer antwortet auf seiner **eigenen** Tunnel-IP (`10.0.0.1`) und auf allem, was du per `forwardRemote()` veröffentlichst — ideal für interne Dashboards, Datenbanken und Web-Apps. **Voller Zugang ins öffentliche Internet** (beliebige Seiten durch das VPN) erfordert, dass der WireGuard-**Server ein Exit-Node ist** (IP-Forwarding + NAT) — eine Kernel-WireGuard-Maschine über den `udp`-Transport, kein Userspace-WS-Peer.

---

## 🎯 Die 10 wichtigsten Anwendungsfälle

Copy-and-paste-Rezepte für die häufigsten Aufgaben. Jedes Snippet ist eigenständig – ersetze einfach Schlüssel, IPs und den `.conf`-Pfad durch deine eigenen und führe es nach `npm i wireshade` aus.

### 1. Eine interne HTTPS-API durch den Tunnel aufrufen

Erreiche eine private API, die es nur innerhalb des VPN gibt – per eingebautem Helfer oder über einen axios-/got-/fetch-Agent.

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

### 2. Mit einer vorhandenen WireGuard-`.conf` verbinden

Zeige WireShade auf eine Standard-Konfigurationsdatei – ganz ohne Schlüssel-Handling im Code.

```javascript
const { WireShade } = require('wireshade');

// A standard [Interface] / [Peer] file is parsed for you.
const client = new WireShade('/etc/wireguard/wg0.conf');
await client.start();

console.log('tunnel up as', client.config.wireguard.sourceIp);
await client.close();
```

### 3. Eine rohe TCP-Verbindung öffnen

Sprich mit jedem TCP-Dienst (Redis, SMTP, ein Game-Server …) über einen `net.Socket`-kompatiblen Stream.

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

### 4. Einen TCP-Dienst im VPN bereitstellen

Betreibe einen Listener auf deiner VPN-IP, den andere Peers erreichen können.

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

### 5. Lokale Portweiterleitung (wie `ssh -L`)

Erreiche einen entfernten VPN-Dienst über einen lokalen Port – z. B. eine private Datenbank auf `localhost`.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// localhost:5432 → 10.0.0.5:5432 inside the VPN.
await client.forwardLocal(5432, '10.0.0.5', 5432);
console.log('psql -h localhost -p 5432 now reaches the VPN database');
```

### 6. Entfernte Portweiterleitung (wie `ssh -R`)

Veröffentliche einen lokalen Dienst im VPN, sodass jeder Peer ihn erreicht – selbst hinter NAT.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// Publish your local :3000 to VPN peers at <your VPN IP>:8080.
await client.forwardRemote(8080, 'localhost', 3000);
console.log('local :3000 is now reachable across the VPN on :8080');
```

### 7. Eine Express-/HTTP-App durch den Tunnel bereitstellen

Leite Tunnel-Verbindungen direkt in einen Node-HTTP-Server – ohne je einen öffentlichen Port zu binden.

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

### 8. Hostnamen auf VPN-IPs abbilden (eigenes DNS)

Nutze sprechende Namen für VPN-Hosts, ohne `/etc/hosts` anzufassen.

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

### 9. Einen Peer per ICMP-Ping überwachen

Miss die Round-Trip-Zeit zu einem Peer und erkenne, wenn er ausfällt.

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

### 10. Mit WebSocket/WSS durch eine Firewall stoßen

Trage den gesamten Tunnel über einen einzigen `wss://`-Port (443), um HTTP-only-Proxys und strenge Firewalls zu überwinden.

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

### 🍳 Weitere Rezepte

Sieben weitere praxiserprobte Muster — im selben eigenständigen Stil, fortlaufend nummeriert nach den zehn oben.

### 11. Einen bestehenden DB-/Redis-Client unverändert weiterverwenden

Leite den entfernten Port auf `localhost` weiter und richte deinen bestehenden Treiber darauf — die Bibliothek selbst muss nicht angepasst werden.

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

### 12. Per SSH über einen weitergeleiteten Port auf einen VPN-Host

Mache den SSH-Port eines Peers auf `localhost` verfügbar und verbinde dich mit einem gewöhnlichen `ssh`-Client.

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

### 13. Peer-to-Peer-VPN zwischen zwei Peers — ohne zentralen Server

Zwei WireShade-Peers bilden einen direkten Tunnel: einer lauscht, der andere wählt sich ein.

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

### 14. Ausfälle überstehen mit Auto-Reconnect, Events und Health-Checks

Aktiviere Reconnect mit Backoff und beobachte den Lebenszyklus des Tunnels über Events.

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

### 15. In CI / Serverless / Containern laufen — ohne Root

Kein TUN-Gerät und keine Rechte nötig, daher funktioniert der Tunnel dort, wo ein Kernel-VPN es nicht kann.

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

### 16. Klartext-`ws://` hinter einem TLS-terminierenden Reverse-Proxy

Überlasse nginx/Caddy die TLS-Terminierung und halte die WireShade-Seite im Klartext.

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

### 17. Das gesamte VPN als SOCKS5-Proxy bereitstellen

Betreibe einen lokalen SOCKS5-Proxy, der jede Verbindung durch den Tunnel leitet — jede SOCKS5-fähige Anwendung erreicht dann jeden Host im VPN, ganz ohne Weiterleitung pro Dienst.

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

Genau das macht die CLI ohne eine einzige Zeile Code: `wireshade socks -c wg0.conf`.

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
| `14_socks_proxy.js` | SOCKS5-Proxy über den Tunnel. |
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
