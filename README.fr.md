# 👻 WireShade avec Node.js

**WireGuard® en espace utilisateur pour Node.js : une bibliothèque *et* une CLI façon SSH (SOCKS5, redirection de ports, `ssh`) qui fonctionne sur UDP ou WebSocket, sans root ni périphérique TUN.**

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

Chiffres indicatifs de `bench/throughput_mp.js` sur une seule machine :

| Transport | Goodput (loopback) | CPU (per peer) |
|-----------|--------------------|----------------|
| UDP       | ~2.5 Gbit/s (300 MB/s) | ~1.1 cores |
| WS        | ~2.6 Gbit/s (315 MB/s) | ~1.1 cores |
| WSS       | ~2.0 Gbit/s (240 MB/s) | ~1.1 cores |

Ce sont des chiffres en **loopback** sur une seule machine (les deux pairs dans des processus distincts) : ils mesurent le débit de la crypto + de la pile en espace utilisateur, **pas** la RTT ni la perte de paquets d'un vrai réseau, vos résultats varieront donc selon le CPU. Agrandir les tampons du socket UDP a rendu le chemin UDP ~4× plus rapide : il est passé de CPU inactif/bloqué à ~1 cœur, limité par le CPU sur le ChaCha20-Poly1305 de WireGuard.

Reproduisez avec `BENCH_TRANSPORT=udp|ws|wss node bench/throughput_mp.js`. Pour une contre-vérification sur sockets réels, `node bench/iperf3.js` fait passer iperf3 à travers le tunnel (là, environ ~1,1 Gbit/s UDP / ~1,3 Gbit/s WSS).

---

## 🖥️ Interface en ligne de commande (CLI)

WireShade fournit une commande `wireshade` qui établit un tunnel et expose un **proxy SOCKS5** local — sans écrire de code. Installe-la globalement ou lance-la à la demande avec `npx`. Elle se comporte de façon identique sous **Windows, macOS et Linux** grâce au bin shim de npm.

```bash
npm i -g wireshade        # installs the `wireshade` command globally
# …or run it without installing:
npx wireshade socks -c wg0.conf
```

### Commandes

| Commande | Description |
| :--- | :--- |
| `wireshade ssh [options] [user@]host [-- cmd]` | Se connecter en SSH à un hôte à travers le tunnel |
| `wireshade socks [options]` | Se connecter et exposer un proxy SOCKS5 local |
| `wireshade forward [options]` | Se connecter et transférer des ports (`-L` / `-R`, comme `ssh`) |
| `wireshade bridge [options]` | Relais WS(S) → UDP vers un vrai serveur WireGuard |
| `wireshade unset-proxy` | Restaurer les réglages du proxy système (récupération après plantage) |
| `wireshade genkey` | Afficher une nouvelle paire de clés WireGuard |
| `wireshade version` | Afficher la version |
| `wireshade help` | Afficher l'aide |

### Exemples courants

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

`wireshade ssh` redirige un port local éphémère vers le `:22` de l'hôte à travers le tunnel, puis lance le `ssh` de votre système dessus. Utilisez `--port` pour un port SSH non standard et `-- <args>` pour passer une commande distante ou des arguments `ssh` supplémentaires. Le client `ssh` du système doit être installé.

### Options de `socks`

| Option | Description |
| :--- | :--- |
| `-c, --config <file>` | Fichier `.conf` WireGuard (`[Interface]` + `[Peer]`) |
| `--private-key <b64>` | Clé privée de l'interface (sans `--config`) |
| `--peer-key <b64>` | Clé publique du pair (sans `--config`) |
| `--psk <b64>` | Clé pré-partagée (facultatif) |
| `--endpoint <host:port>` | Endpoint UDP WireGuard (sans `--config`) |
| `--source-ip <ip>` | IP source du tunnel, p. ex. `10.0.0.2` (sans `--config`) |
| `--keepalive <sec>` | Keepalive persistant (par défaut `25`) |
| `-t, --transport <udp\|ws\|wss>` | Transport porteur (par défaut `udp`) |
| `--url <ws[s]://host:port>` | URL du serveur WS (requise pour `ws`/`wss`) |
| `--path-prefix <p>` | Préfixe de chemin de l'upgrade WS |
| `--ca <file>` | Épingler un certificat PEM (`wss`, auto-signé) |
| `--insecure` | Ignorer la vérification TLS (tests uniquement) |
| `-l, --listen <[host:]port>` | Écoute SOCKS5 locale (par défaut `127.0.0.1:1080`) |
| `--auth <user:pass>` | Exiger un identifiant/mot de passe SOCKS5 |
| `--dns <ip>` | Résoudre les noms d'hôte via ce serveur DNS à travers le tunnel (DNS-over-TCP) ; par défaut la valeur `DNS =` du `.conf` |
| `--set-system-proxy` | Diriger le système d'exploitation vers ce proxy ; restauré automatiquement à la sortie |
| `--proxy-method <pac\|registry>` | Windows uniquement ; `pac` (par défaut) = vrai SOCKS5 via un fichier PAC, `registry` = entrée `socks=` (les navigateurs la traitent comme du SOCKS4) |
| `--chrome [url]` | Lancer Chrome/Edge/Chromium via ce proxy dans un profil isolé ; fermer le navigateur arrête wireshade |
| `--chrome-path <file>` | Exécutable du navigateur (sinon détecté automatiquement ; respecte aussi `$CHROME_PATH`) |
| `-v, --verbose` | Journaliser chaque connexion relayée |

### Options de `forward`

Utilise les **mêmes flags de connexion que `socks`** (`-c` / `-t` / `--url` / `--ca` / …). Les deux flags de redirection de port sont répétables.

| Option | Description |
| :--- | :--- |
| `-L <localPort:remoteHost:remotePort>` | Rediriger un port local vers le VPN (comme `ssh -L`) |
| `-R <vpnPort:targetHost:targetPort>` | Publier un service local dans le VPN (comme `ssh -R`) |

### `bridge` — relais vers un vrai serveur WireGuard

S'exécute **sur un VPS** à côté d'un vrai nœud de sortie WireGuard (noyau). Le bridge déballe l'encapsulation WebSocket et relaie les datagrammes bruts vers `--target`, de sorte que le chiffrement WireGuard reste de bout en bout entre le client et le serveur noyau, et le noyau effectue le NAT → un vrai internet en tunnel complet, avec traversée de pare-feu par WSS. Il est **compatible wstunnel-v2**, donc un `wstunnel client` standard fonctionne avec lui. Ce **n'est pas un relais ouvert** — les datagrammes vont toujours vers `--target`.

| Option | Description |
| :--- | :--- |
| `--target <host:port>` | Le vrai serveur UDP WireGuard, p. ex. `127.0.0.1:51820` (**requis**) |
| `--listen <[host:]port>` | Adresse d'écoute (par défaut `0.0.0.0:443` avec `--tls`, sinon `:8080`) |
| `--tls <cert.pem:key.pem>` | Servir `wss` (omettre pour du `ws` en clair derrière un reverse proxy) |
| `--path-prefix <p>` | Exiger le chemin d'upgrade wstunnel `/<p>/events` |
| `--timeout <sec>` | Délai d'inactivité du relais (par défaut `120`) |

```bash
# On the VPS, next to a kernel WireGuard exit node listening on udp/51820:
#   (wg-quick up wg0  +  IP forwarding  +  iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE)
wireshade bridge --target 127.0.0.1:51820 --tls fullchain.pem:privkey.pem --path-prefix v1
```

> Un client WS natif WireShade qui parle directement au bridge arrive bientôt ; aujourd'hui, un `wstunnel client` standard (+ WireGuard noyau) fonctionne déjà à travers lui.

### Exemples

```bash
wireshade socks -c wg0.conf
wireshade socks -c wg0.conf -l 0.0.0.0:1080 --auth alice:secret
wireshade socks -c wg0.conf -t wss --url wss://vpn.example.com:443 --ca server.pem
wireshade socks -c wg0.conf --chrome https://example.internal
wireshade socks -c wg0.conf --set-system-proxy
```

Dès qu'il signale que le proxy écoute, dirige n'importe quelle application compatible SOCKS5 vers lui :

```bash
curl --socks5-hostname 127.0.0.1:1080 http://<vpn-host>/
```

*   **proxychains :** ajoute `socks5 127.0.0.1 1080` à `proxychains.conf`, puis lance `proxychains <your-app>`.
*   **Navigateur :** règle l'hôte SOCKS5 sur `127.0.0.1` et le port sur `1080` (choisis SOCKS v5 avec DNS distant pour que les noms d'hôte soient résolus à l'intérieur du VPN).

**Tout l'internet via le VPN.** WireShade transmet **n'importe quelle** destination à travers le tunnel, pas seulement le sous-réseau propre du VPN — le tunneling de tout l'internet fonctionne donc **si le serveur WireGuard est un nœud de sortie** (routage IP + NAT). L'IP publique de sortie est alors celle du serveur ; WireShade ne la définit pas. Passe `--dns <ip>` pour garder aussi la résolution DNS à l'intérieur du tunnel (sans fuite), ce qui compte pour un usage en tunnel complet.

---

## 🧭 Tutoriel : un serveur VPN par WebSocket + un client Chrome

De bout en bout : faites tourner un **serveur WS** WireShade sur une VM publique, placez **nginx / Nginx Proxy Manager** devant lui sur un vrai domaine (TLS), puis depuis votre portable **connectez-vous avec la CLI et ouvrez Chrome** dont le trafic passe par le tunnel — sans root ni périphérique TUN d'aucun côté.

### 1. Générer les clés

Lancez ceci deux fois — une pour le serveur, une pour le client — et notez chaque paire :

```bash
wireshade genkey
```

Le serveur a besoin de sa **propre clé privée** + de la **clé publique du client** ; le client a besoin de sa **propre clé privée** + de la **clé publique du serveur**.

### 2. Le pair serveur

La CLI est le côté client ; le **serveur** WS est un court script utilisant `WireShadeWsServer`. Choisissez l'une des deux stratégies TLS.

**Variante A — WireShade termine le TLS lui-même (`wss://`)**

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

Gardez-le actif avec `pm2` ou une unité `systemd`.

**Variante B — nginx / Nginx Proxy Manager termine le TLS sur votre domaine (recommandé)**

Laissez le proxy gérer le domaine + le certificat et gardez WireShade en clair sur la loopback :

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

Bloc `server` nginx pour `vpn.example.com` (certificat via `certbot`) :

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

**Nginx Proxy Manager (GUI) :** ajoutez un *Proxy Host* → Domaine `vpn.example.com`, Forward Hostname/Port `127.0.0.1` / `8000` (schéma `http`), activez **Websockets Support**, demandez un certificat Let's Encrypt dans l'onglet *SSL*, et dans l'onglet *Advanced* ajoutez un bloc `location /wg/ { … }` avec les mêmes en-têtes `Upgrade`/`Connection` pour que le préfixe de chemin corresponde.

### 3. Se connecter depuis le client et lancer Chrome

Une seule commande CLI ouvre le tunnel sur WSS et lance un **Chrome isolé** dont le trafic passe par celui-ci :

```bash
wireshade socks \
  -t wss --url wss://vpn.example.com:443 --path-prefix wg \
  --private-key '<client private key>' \
  --peer-key    '<server public key>' \
  --source-ip   10.0.0.2 \
  --dns 10.0.0.1 \
  --chrome http://10.0.0.1:8080/
```

Fermer cette fenêtre Chrome arrête `wireshade` et démonte le tunnel. Vous préférez un fichier ? Un `.conf` client fonctionne aussi — notez que le parseur de WireShade exige toujours une ligne `Endpoint`, que le transport WS ignore :

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

> **Portée du serveur WS.** Un pair WS WireShade en espace utilisateur répond sur sa **propre** IP de tunnel (`10.0.0.1`) et sur tout ce que vous publiez avec `forwardRemote()` — idéal pour atteindre des tableaux de bord internes, des bases de données et des applications web. **Une sortie complète vers l'Internet public** (sites quelconques à travers le VPN) nécessite que le **serveur WireGuard soit un nœud de sortie** (routage IP + NAT) — une machine WireGuard noyau sur le transport `udp`, pas un pair WS en espace utilisateur.

---

## 🎯 Recettes

Des recettes éprouvées sur le terrain, prêtes à copier-coller, pour les besoins les plus courants. Chaque extrait est autonome : remplacez les clés, les IP et le chemin du `.conf` par les vôtres, puis exécutez-le après `npm i wireshade`.

### 1. Appeler une API HTTPS interne à travers le tunnel

Atteignez une API privée qui n'existe qu'à l'intérieur du VPN, via l'assistant intégré ou un agent axios/got/fetch.

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

### 2. Se connecter depuis un `.conf` WireGuard existant

Pointez WireShade vers un fichier de configuration standard, sans gérer de clés dans le code.

```javascript
const { WireShade } = require('wireshade');

// A standard [Interface] / [Peer] file is parsed for you.
const client = new WireShade('/etc/wireguard/wg0.conf');
await client.start();

console.log('tunnel up as', client.config.wireguard.sourceIp);
await client.close();
```

### 3. Ouvrir une connexion TCP brute

Dialoguez avec n'importe quel service TCP (Redis, SMTP, un serveur de jeu…) via un flux compatible `net.Socket`.

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

### 4. Exposer un service TCP à l'intérieur du VPN

Lancez un listener sur votre IP VPN, accessible aux autres pairs.

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

### 5. Redirection de port locale (comme `ssh -L`)

Atteignez un service VPN distant sur un port local — par ex. une base de données privée sur `localhost`.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// localhost:5432 → 10.0.0.5:5432 inside the VPN.
await client.forwardLocal(5432, '10.0.0.5', 5432);
console.log('psql -h localhost -p 5432 now reaches the VPN database');
```

### 6. Redirection de port distante (comme `ssh -R`)

Publiez un service local dans le VPN pour que n'importe quel pair l'atteigne, même derrière un NAT.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// Publish your local :3000 to VPN peers at <your VPN IP>:8080.
await client.forwardRemote(8080, 'localhost', 3000);
console.log('local :3000 is now reachable across the VPN on :8080');
```

### 7. Servir une application Express/HTTP à travers le tunnel

Injectez les connexions du tunnel directement dans un serveur HTTP Node, sans jamais ouvrir de port public.

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

### 8. Associer des noms d'hôte à des IP VPN (DNS personnalisé)

Utilisez des noms lisibles pour les hôtes VPN sans toucher à `/etc/hosts`.

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

### 9. Surveiller un pair avec un ping ICMP

Mesurez le temps d'aller-retour vers un pair et détectez quand il tombe.

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

### 10. Franchir un pare-feu avec WebSocket/WSS

Faites passer tout le tunnel par un seul port `wss://` (443) pour traverser les proxys HTTP-only et les pare-feu stricts.

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

### 🍳 Autres recettes

Quelques schémas de plus, numérotés à la suite des précédents — même style autonome.

### 11. Réutiliser un client BD / Redis existant, sans modification

Transférez le port distant vers `localhost`, puis pointez votre pilote existant dessus — la bibliothèque elle-même ne nécessite aucune modification.

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

### 12. Se connecter en SSH à un hôte du VPN via un port transféré

Exposez le port SSH d'un pair sur `localhost` et connectez-vous avec un client `ssh` standard.

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

### 13. VPN pair-à-pair entre deux pairs — sans serveur central

Deux pairs WireShade forment un tunnel direct : l'un écoute, l'autre se connecte.

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

### 14. Survivre aux coupures avec reconnexion automatique, événements et contrôles de santé

Activez la reconnexion avec backoff et suivez le cycle de vie du tunnel via les événements.

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

### 15. Exécuter en CI / serverless / conteneurs — sans root

Aucun périphérique TUN ni privilège requis, le tunnel fonctionne donc là où un VPN noyau ne le peut pas.

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

### 16. `ws://` en clair derrière un proxy inverse qui termine TLS

Laissez nginx/Caddy gérer le TLS et gardez le côté WireShade en clair.

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

### 17. Exposer tout le VPN comme un proxy SOCKS5

Lance un proxy SOCKS5 local qui achemine chaque connexion à travers le tunnel — n'importe quelle application compatible SOCKS5 peut alors atteindre n'importe quel hôte à l'intérieur du VPN, sans redirection par service.

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

La CLI fait exactement cela sans écrire la moindre ligne de code : `wireshade socks -c wg0.conf`.

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
| `14_socks_proxy.js` | Proxy SOCKS5 sur le tunnel. |
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
