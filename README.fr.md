# 👻 WireShade avec Node.js

**L'implémentation ultime de WireGuard® en espace utilisateur pour Node.js**

[![npm version](https://img.shields.io/npm/v/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![npm downloads](https://img.shields.io/npm/dm/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**WireShade** permet à votre application Node.js de se connecter directement à un VPN WireGuard **sans privilèges root**, sans modules noyau et sans modifier les paramètres réseau du système. Il s'exécute entièrement en espace utilisateur grâce à une pile TCP/IP personnalisée écrite en Rust (`smoltcp`) intégrée directement dans Node.js : aucune interface TUN/TAP n'est jamais créée.

<div align="center">

[🇺🇸 English](README.md) | [🇩🇪 Deutsch](README.de.md) | [🇪🇸 Español](README.es.md) | [🇫🇷 Français](README.fr.md) | [🇨🇳 中文](README.zh.md)

</div>

---

## 🚀 Pourquoi WireShade ?

*   **🛡️ Discrétion et sécurité :** Routez un trafic Node.js précis via un VPN WireGuard tandis que le reste du trafic système reste normal. Idéal pour le web scraping, les bots ou la communication sécurisée entre services.
*   **🌍 Tunneling inverse :** Exposez un serveur local Express/Fastify/Next.js ou un service TCP brut au réseau VPN privé, même derrière un NAT ou un pare-feu.
*   **🔌 Client sans configuration :** Pas besoin d'installer WireGuard sur l'hôte. Un simple `npm install` et c'est parti.
*   **🧱 Transport WebSocket / WSS :** Transportez tout le tunnel WireGuard sur une seule connexion `ws://` ou `wss://` pour percer les pare-feux restrictifs et les proxys HTTP uniquement.
*   **🔄 Reconnexion automatique :** Backoff, contrôles de santé et événements intégrés pour survivre aux coupures et aux changements de réseau.
*   **⚡ Hautes performances :** Propulsé par Rust et NAPI-RS pour des performances quasi natives.

## 🧠 Fonctionnement

WireShade contourne la pile réseau du système d'exploitation hôte en exécutant une **pile TCP/IP en espace utilisateur** ([smoltcp](https://github.com/smoltcp-rs/smoltcp)) à l'intérieur de votre processus Node.js :

1.  **Handshake :** WireShade effectue un véritable handshake WireGuard avec le pair (via UDP ou via un WebSocket).
2.  **Encapsulation :** Les paquets IP sont chiffrés et encapsulés dans les trames de transport.
3.  **Routage en espace utilisateur :** Les paquets déchiffrés sont traités par `smoltcp` en Rust, qui gère l'état TCP, la retransmission et la mise en tampon.
4.  **Intégration Node.js :** Les données circulent entre Rust et les instances `net.Socket` / `http.Agent` de Node.js via des bindings NAPI hautes performances.

Cela signifie : **aucune interface réseau virtuelle**, **pas de root**, **aucun conflit** avec les VPN existants et une prise en charge **multiplateforme** sans modules noyau.

## ✅ Plateformes prises en charge

Les binaires natifs sont **précompilés pour les six cibles suivantes et chargés automatiquement** au moment du `require()` — sans compilateur ni étape de build à l'installation.

| Target triple | Plateforme | Architecture |
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

## ⚡ Démarrage rapide

### À partir d'un objet de configuration

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

### À partir d'un fichier `.conf` WireGuard

Passez une chaîne de chemin plutôt qu'un objet de configuration : un fichier standard `[Interface]` / `[Peer]` est analysé pour vous (y compris `PersistentKeepalive`) :

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

const body = await client.get('http://10.0.0.1/');
console.log(body);

await client.close();
```

Pour de vraies requêtes via `axios`, `node-fetch`, `ws`, etc., passez les agents du tunnel :

```javascript
const axios = require('axios');
const res = await axios.get('https://internal.service/api', {
    httpAgent: client.getHttpAgent(),
    httpsAgent: client.getHttpsAgent()
});
```

---

## 🧱 Transport WebSocket / WSS

Au lieu d'UDP, WireShade peut transporter tout le tunnel WireGuard sur une **seule connexion WebSocket**. C'est le moyen fiable de « simplement passer » à travers les pare-feux et proxys restrictifs qui n'autorisent que HTTP(S). Les deux pairs sont des instances WireShade : l'un fait office de **serveur** WS (termine TLS + le tunnel), l'autre de **client** WS.

### Pair serveur

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

### Pair client

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

Tout le reste — `connect`, `listen`, `forwardLocal`, `forwardRemote`, `ping`, les wrappers `http`/`https` et la reconnexion automatique — fonctionne de façon identique sur WebSocket. Voir [`examples/13_websocket_highlevel.js`](examples/13_websocket_highlevel.js) (haut niveau) et [`examples/11_websocket_wss.js`](examples/11_websocket_wss.js) (binding natif).

**`ws://` vs `wss://` :** utilisez `ws://` en clair (omettez le bloc `tls` du serveur) lorsque TLS est déjà terminé devant WireShade par un reverse proxy comme nginx ou Caddy ; utilisez `wss://` natif (avec `tls: { cert, key }`) pour que WireShade termine TLS lui-même. Côté client, `tls.ca` épingle (pinning) un certificat précis, `tls.servername` remplace le SNI et `tls.insecureSkipVerify` désactive entièrement la vérification — **pour les tests uniquement, jamais en production**.

> **Compromis — TCP sur TCP :** le transport WebSocket tunnelise WireGuard (et donc votre TCP interne) à l'intérieur d'un flux TCP/TLS externe. C'est excellent pour la traversée de pare-feux/proxys et pour des liens fiables et ordonnés, mais sur des chemins à pertes ou à forte gigue, les deux boucles de contrôle de congestion empilées peuvent se gêner mutuellement (« TCP meltdown »). Quand le réseau n'est pas fiable, le transport UDP pur se comporte généralement mieux ; quand il faut juste passer, le WebSocket l'emporte.

---

## 📖 API principale

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
Crée un client à partir d'un objet de configuration ou d'un chemin vers un fichier `.conf` (`new WireShade('wg.conf')`). `config.wireguard` prend les champs WireGuard habituels : `privateKey`, `peerPublicKey`, `presharedKey`, `endpoint`, `sourceIp`, `listenPort`, `persistentKeepalive`. `persistentKeepalive` est en secondes (`PersistentKeepalive` dans les fichiers `.conf`), vaut `25` par défaut, et `0` le désactive. Autres options : `logging` (défaut `true`), `handshakeTimeout` (ms, défaut `10000`), `hosts`, `reconnect`, `transport` et `onConnect`/`onDisconnect`/`onReconnect`.

**`client.start()`** → `Promise<void>`
Se connecte et se résout **une fois le véritable handshake WireGuard avec le pair terminé** (rejette en cas de timeout, d'erreur DNS/bind, ou si `close()` est appelé avant). Lorsque les deux pairs sont des instances WireShade, démarrez-les simultanément : `Promise.all([a.start(), b.start()])`.

**`client.close()`** → `Promise<void>`
Arrête les reconnexions et les contrôles de santé, ferme tous les serveurs/connexions et arrête le tunnel natif. Se résout une fois la tâche native arrêtée. (`close()` est l'équivalent haut niveau du `shutdown()` natif.)

**Reconnexion** — configurez-la via le bloc `reconnect` ; les changements d'état sont émis sous forme d'événements :

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

Les listeners enregistrés (`listen`/`forwardRemote`) sont automatiquement recréés sur le nouveau tunnel après une reconnexion.

**`client.ping(ip)`** → `Promise<number>` — écho ICMP ; se résout avec le temps d'aller-retour en ms.

**`client.connect({ host, port })`** → `Duplex` — un flux compatible `net.Socket` à travers le tunnel. Émet `'connect'`, `'data'`, `'end'`, `'error'`.

**`client.listen(port, [onConnection])`** → `Promise<Server>` — un serveur TCP sur l'**IP du VPN** ; `onConnection` reçoit un socket par connexion.

**`client.forwardLocal(localPort, remoteHost, remotePort)`** → `Promise` — expose un service côté VPN sur votre machine locale (`localhost:localPort` → `remoteHost:remotePort` à l'intérieur du VPN).

**`client.forwardRemote(vpnPort, targetHost, targetPort)`** → `Promise` — expose un service local aux pairs du VPN (IP VPN `:vpnPort` → `targetHost:targetPort` sur votre machine).

```javascript
await client.forwardLocal(3333, '10.0.0.5', 5432);   // reach VPN Postgres via localhost:3333
await client.forwardRemote(8080, 'localhost', 3000); // publish local :3000 on the VPN at :8080
```

**`client.get(url, [opts])` / `client.request(url, [opts])`** → `Promise<string | object>` — HTTP(S) à travers le tunnel. Se résout avec la chaîne du corps (`opts.encoding`, défaut `utf8`) ; avec `opts.fullResponse: true`, avec `{ statusCode, statusMessage, headers, body, rawBody }`. `opts.body` définit un corps de requête.

**`client.getHttpAgent()` / `client.getHttpsAgent()`** — `http.Agent` / `https.Agent` routant à travers le tunnel (pour `axios`, `node-fetch`, `ws`, …).

**`client.addHost(hostname, ip)`** — associe un nom d'hôte à une IP du VPN sans toucher à `/etc/hosts` ; l'association est utilisée pour les requêtes et redirections propres au client.

**`generateKeyPair()`** → `{ privateKey, publicKey }` — une nouvelle paire de clés WireGuard.

**`parseConfig(text)` / `readConfig(path)`** — analyse une configuration WireGuard depuis une chaîne ou un fichier vers un objet de configuration.

**`generateSelfSignedCert(sans)`** → `{ certPem, keyPem }` — un certificat auto-signé + clé (PEM) pour les subject alternative names indiqués, pratique pour `wss://` en dev/test sans OpenSSL.

**`new WireShadeWsServer({ listen, pathPrefix, tls, wireguard, ... })`** — le pair serveur WebSocket. `listen` est `"host:port"` ; fournissez `tls: { cert, key }` pour `wss://` ou omettez-le pour `ws://`. Son `start()` se résout dès que le socket est **lié et en écoute** (avant tout handshake d'un pair), afin d'enregistrer `listen`/`forwardRemote` immédiatement. Toutes les autres méthodes et événements de `WireShadeClient` s'appliquent de la même façon.

---

## 📊 Benchmarks

WireShade fournit deux scripts de benchmark. Les chiffres dépendent de la machine ; exécutez-les vous-même.

```bash
# Raw tunnel goodput + CPU-per-core on loopback (crypto/CPU cost, not RTT/loss):
BENCH_TRANSPORT=udp BENCH_SECONDS=5 BENCH_CHUNK=262144 node bench/throughput.js
#   BENCH_TRANSPORT = udp | ws | wss

# Real iperf3 driven through the tunnel (needs iperf3 in PATH; skips cleanly if absent):
BENCH_TRANSPORT=udp node bench/iperf3.js
```

`bench/throughput.js` mesure le goodput et le coût CPU par cœur de tout le chemin (crypto WireGuard + `smoltcp` + la frontière NAPI) en loopback : il isole le débit crypto/CPU, pas la latence ni la perte réseau. `bench/iperf3.js` fait passer une véritable paire client/serveur `iperf3` à travers le tunnel pour un chiffre standard de l'industrie, et se saute automatiquement (sortie 0) si `iperf3` n'est pas installé.

---

## 📚 Exemples

Les scripts exécutables se trouvent dans [`examples/`](examples/) :

| Fichier | Montre |
| :--- | :--- |
| `01_quickstart.js` | Se connecter, requêter et écouter : le « hello world ». |
| `02_http_request.js` | Requête HTTP GET simple avec `client.get()`. |
| `03_https_custom_dns.js` | HTTPS avec un nom d'hôte mappé sur une IP du VPN. |
| `04_tcp_socket.js` | Envoi/réception TCP brut à travers le tunnel. |
| `05_internet_routing.js` | Router le trafic internet public via la passerelle du VPN. |
| `06_simple_server.js` | Héberger un serveur TCP/HTTP à l'intérieur du tunnel. |
| `07_express_app.js` | Exposer une app Express via le VPN (tunnel inverse). |
| `08_local_forwarding.js` | `forwardLocal` — atteindre un service du VPN sur `localhost`. |
| `09_reconnect_config.js` | Reconnexion, contrôles de santé et suivi des événements. |
| `10_remote_forwarding.js` | `forwardRemote` — publier un service local sur le VPN. |
| `11_websocket_wss.js` | WireGuard sur WSS avec le binding **natif**. |
| `13_websocket_highlevel.js` | WireGuard sur WSS avec l'API **haut niveau**. |
| `local_vpn.js` | Deux pairs locaux formant un tunnel P2P pour les tests. |

---

## 🎯 Cas d'usage

*   **Microservices :** connecter des services entre clouds sans exposer de ports publics.
*   **Web scraping :** exécuter plusieurs instances sur différents endpoints pour faire tourner les IP de sortie.
*   **Accès développeur :** atteindre des bases de données internes privées depuis un portable, en toute sécurité.
*   **IoT et edge :** connecter des appareils derrière des NAT restrictifs vers un serveur central.

---

## 📜 Licence

Licence MIT.

*WireGuard est une marque déposée de Jason A. Donenfeld.*
</content>
