# 👻 WireShade con Node.js

**WireGuard® en espacio de usuario para Node.js: una biblioteca *y* una CLI al estilo SSH (SOCKS5, reenvío de puertos, `ssh`) que se ejecuta sobre UDP o WebSocket, sin root ni dispositivo TUN.**

[![npm version](https://img.shields.io/npm/v/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![npm downloads](https://img.shields.io/npm/dm/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**WireShade** permite que tu aplicación Node.js se conecte directamente a una VPN WireGuard **sin privilegios de root**, módulos del kernel ni cambios en la configuración de red del sistema. Se ejecuta por completo en espacio de usuario mediante una pila TCP/IP basada en Rust (`smoltcp`) integrada directamente en Node.js: nunca se crea una interfaz TUN/TAP.

<div align="center">

[🇺🇸 English](README.md) | [🇩🇪 Deutsch](README.de.md) | [🇪🇸 Español](README.es.md) | [🇫🇷 Français](README.fr.md) | [🇨🇳 中文](README.zh.md)

</div>

---

## 🚀 ¿Por qué WireShade?

*   **🛡️ Sigilo y seguridad:** Enruta tráfico específico de Node.js a través de una VPN WireGuard mientras el resto del tráfico del sistema sigue normal. Perfecto para web scraping, bots o comunicación segura entre servicios.
*   **🌍 Túnel inverso:** Expón un servidor local Express/Fastify/Next.js o un servicio TCP en crudo a la red VPN privada, incluso detrás de un NAT o firewall.
*   **🔌 Cliente sin configuración:** No hace falta instalar WireGuard en el host. Solo `npm install` y listo.
*   **🧱 Transporte WebSocket / WSS:** Transporta todo el túnel WireGuard sobre una única conexión `ws://` o `wss://` para atravesar firewalls restrictivos y proxies que solo permiten HTTP.
*   **🔄 Reconexión automática:** Backoff, comprobaciones de salud y eventos integrados para sobrevivir a cortes de conexión y cambios de red.
*   **⚡ Alto rendimiento:** Impulsado por Rust y NAPI-RS para un rendimiento casi nativo.

## 🧠 Cómo funciona

WireShade evita la pila de red del sistema operativo anfitrión ejecutando una **pila TCP/IP en espacio de usuario** ([smoltcp](https://github.com/smoltcp-rs/smoltcp)) dentro de tu proceso Node.js:

1.  **Handshake:** WireShade realiza un handshake WireGuard real con el par (por UDP o por un WebSocket).
2.  **Encapsulado:** Los paquetes IP se cifran y se encapsulan en las tramas de transporte.
3.  **Enrutamiento en espacio de usuario:** Los paquetes descifrados los gestiona `smoltcp` en Rust, que administra el estado TCP, la retransmisión y el búfer.
4.  **Integración con Node.js:** Los datos se mueven entre Rust y las instancias `net.Socket` / `http.Agent` de Node.js a través de bindings NAPI de alto rendimiento.

Esto significa: **sin interfaz de red virtual**, **sin root**, **sin conflicto** con VPNs existentes y soporte **multiplataforma** sin módulos del kernel.

## ✅ Plataformas soportadas

Los binarios nativos están **precompilados para los seis objetivos siguientes y se cargan automáticamente** al hacer `require()`, sin compilador ni paso de compilación en la instalación.

| Target triple | Plataforma | Arquitectura |
| :--- | :--- | :--- |
| `x86_64-pc-windows-msvc` | Windows | x64 |
| `x86_64-apple-darwin` | macOS | Intel |
| `aarch64-apple-darwin` | macOS | Apple Silicon |
| `x86_64-unknown-linux-gnu` | Linux | x64 |
| `aarch64-unknown-linux-gnu` | Linux | ARM64 |
| `armv7-unknown-linux-gnueabihf` | Linux / Raspberry Pi | ARMv7 |

## 📦 Instalación

```bash
npm i wireshade
```

---

## ⚡ Inicio rápido

### Desde un objeto de configuración

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

### Desde un archivo `.conf` de WireGuard

Pasa una ruta como cadena en lugar de un objeto de configuración: se analiza por ti un archivo estándar con `[Interface]` / `[Peer]` (incluido `PersistentKeepalive`):

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

const body = await client.get('http://10.0.0.1/');
console.log(body);

await client.close();
```

Para peticiones reales con `axios`, `node-fetch`, `ws`, etc., pasa los agentes del túnel:

```javascript
const axios = require('axios');
const res = await axios.get('https://internal.service/api', {
    httpAgent: client.getHttpAgent(),
    httpsAgent: client.getHttpsAgent()
});
```

---

## 🧱 Transporte WebSocket / WSS

En lugar de UDP, WireShade puede transportar todo el túnel WireGuard sobre una **única conexión WebSocket**. Es la forma fiable de «simplemente pasar» a través de firewalls y proxies restrictivos que solo permiten HTTP(S). Ambos pares son instancias de WireShade: uno actúa como **servidor** WS (termina TLS + el túnel) y el otro como **cliente** WS.

### Par servidor

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

### Par cliente

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

Todo lo demás —`connect`, `listen`, `forwardLocal`, `forwardRemote`, `ping`, los envoltorios `http`/`https` y la reconexión automática— funciona de forma idéntica sobre WebSocket. Consulta [`examples/13_websocket_highlevel.js`](examples/13_websocket_highlevel.js) (alto nivel) y [`examples/11_websocket_wss.js`](examples/11_websocket_wss.js) (binding nativo).

**`ws://` frente a `wss://`:** usa `ws://` en texto plano (omite el bloque `tls` del servidor) cuando TLS ya lo termina delante de WireShade un proxy inverso como nginx o Caddy; usa `wss://` nativo (con `tls: { cert, key }`) para que WireShade termine TLS por sí mismo. En el cliente, `tls.ca` fija (pinning) un certificado concreto, `tls.servername` sobreescribe el SNI y `tls.insecureSkipVerify` desactiva la verificación por completo: **solo para pruebas, nunca en producción**.

> **Compromiso — TCP sobre TCP:** el transporte WebSocket tuneliza WireGuard (y por tanto tu TCP interno) dentro de un flujo TCP/TLS externo. Es excelente para atravesar firewalls/proxies y para enlaces fiables y ordenados, pero en rutas con pérdidas o mucho jitter los dos bucles de control de congestión apilados pueden interferir entre sí («TCP meltdown»). Cuando la red no es fiable, el transporte UDP puro suele comportarse mejor; cuando solo necesitas pasar, gana WebSocket.

---

## 📖 API principal

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
Crea un cliente a partir de un objeto de configuración o de una ruta a un archivo `.conf` (`new WireShade('wg.conf')`). `config.wireguard` acepta los campos habituales de WireGuard: `privateKey`, `peerPublicKey`, `presharedKey`, `endpoint`, `sourceIp`, `listenPort`, `persistentKeepalive`. `persistentKeepalive` va en segundos (`PersistentKeepalive` en los archivos `.conf`), su valor por defecto es `25` y `0` lo desactiva. Otras opciones: `logging` (por defecto `true`), `handshakeTimeout` (ms, por defecto `10000`), `hosts`, `reconnect`, `transport` y `onConnect`/`onDisconnect`/`onReconnect`.

**`client.start()`** → `Promise<void>`
Conecta y se resuelve **una vez completado el handshake WireGuard real con el par** (se rechaza por timeout, error de DNS/bind o si se llama antes a `close()`). Cuando ambos pares son instancias de WireShade, arráncalos de forma concurrente: `Promise.all([a.start(), b.start()])`.

**`client.close()`** → `Promise<void>`
Detiene reconexiones y comprobaciones de salud, cierra todos los servidores/conexiones y apaga el túnel nativo. Se resuelve cuando la tarea nativa se ha detenido. (`close()` es el equivalente de alto nivel del `shutdown()` nativo.)

**Reconexión** — configúrala mediante el bloque `reconnect`; los cambios de estado se emiten como eventos:

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

Los listeners registrados (`listen`/`forwardRemote`) se recrean automáticamente en el nuevo túnel tras una reconexión.

**`client.ping(ip)`** → `Promise<number>` — eco ICMP; se resuelve con el tiempo de ida y vuelta en ms.

**`client.connect({ host, port })`** → `Duplex` — un stream compatible con `net.Socket` a través del túnel. Emite `'connect'`, `'data'`, `'end'`, `'error'`.

**`client.listen(port, [onConnection])`** → `Promise<Server>` — un servidor TCP en la **IP de la VPN**; `onConnection` recibe un socket por conexión.

**`client.forwardLocal(localPort, remoteHost, remotePort)`** → `Promise` — expone un servicio del lado VPN en tu máquina local (`localhost:localPort` → `remoteHost:remotePort` dentro de la VPN).

**`client.forwardRemote(vpnPort, targetHost, targetPort)`** → `Promise` — expone un servicio local a los pares de la VPN (IP VPN `:vpnPort` → `targetHost:targetPort` en tu máquina).

```javascript
await client.forwardLocal(3333, '10.0.0.5', 5432);   // reach VPN Postgres via localhost:3333
await client.forwardRemote(8080, 'localhost', 3000); // publish local :3000 on the VPN at :8080
```

**`client.get(url, [opts])` / `client.request(url, [opts])`** → `Promise<string | object>` — HTTP(S) a través del túnel. Se resuelve con la cadena del cuerpo (`opts.encoding`, por defecto `utf8`); con `opts.fullResponse: true` con `{ statusCode, statusMessage, headers, body, rawBody }`. `opts.body` establece un cuerpo de la petición.

**`client.getHttpAgent()` / `client.getHttpsAgent()`** — `http.Agent` / `https.Agent` que enrutan a través del túnel (para `axios`, `node-fetch`, `ws`, …).

**`client.addHost(hostname, ip)`** — asigna un nombre de host a una IP de la VPN sin tocar `/etc/hosts`; la asignación se usa para las propias peticiones y reenvíos del cliente.

**`generateKeyPair()`** → `{ privateKey, publicKey }` — un par de claves WireGuard nuevo.

**`parseConfig(text)` / `readConfig(path)`** — analiza una configuración WireGuard desde una cadena o un archivo hacia un objeto de configuración.

**`generateSelfSignedCert(sans)`** → `{ certPem, keyPem }` — un certificado autofirmado + clave (PEM) para los subject alternative names indicados, útil para `wss://` en desarrollo/pruebas sin OpenSSL.

**`new WireShadeWsServer({ listen, pathPrefix, tls, wireguard, ... })`** — el par servidor WebSocket. `listen` es `"host:port"`; proporciona `tls: { cert, key }` para `wss://` u omítelo para `ws://`. Su `start()` se resuelve en cuanto el socket está **enlazado y escuchando** (antes de que ningún par haga el handshake), de modo que puedes registrar `listen`/`forwardRemote` de inmediato. El resto de métodos y eventos de `WireShadeClient` se aplican igual.

---

## 📊 Benchmarks

WireShade incluye dos scripts de benchmark. Los números dependen de la máquina, así que ejecútalos tú mismo.

```bash
# Raw tunnel goodput + CPU-per-core on loopback (crypto/CPU cost, not RTT/loss):
BENCH_TRANSPORT=udp BENCH_SECONDS=5 BENCH_CHUNK=262144 node bench/throughput.js
#   BENCH_TRANSPORT = udp | ws | wss

# Real iperf3 driven through the tunnel (needs iperf3 in PATH; skips cleanly if absent):
BENCH_TRANSPORT=udp node bench/iperf3.js
```

`bench/throughput.js` mide el goodput y el coste de CPU por núcleo de todo el camino (cripto de WireGuard + `smoltcp` + la frontera NAPI) sobre loopback: aísla el rendimiento cripto/CPU, no la latencia ni la pérdida de red. `bench/iperf3.js` conduce un par real cliente/servidor de `iperf3` a través del túnel para obtener una cifra estándar del sector, y se salta automáticamente (salida 0) si `iperf3` no está instalado.

---

## 🖥️ Interfaz de línea de comandos (CLI)

WireShade incluye un comando `wireshade` que conecta un túnel y expone un **proxy SOCKS5** local — sin escribir código. Instálalo de forma global o ejecútalo cuando lo necesites con `npx`. Funciona igual en **Windows, macOS y Linux** gracias al bin shim de npm.

```bash
npm i -g wireshade        # installs the `wireshade` command globally
# …or run it without installing:
npx wireshade socks -c wg0.conf
```

### Comandos

| Comando | Descripción |
| :--- | :--- |
| `wireshade ssh [options] [user@]host [-- cmd]` | Conectar por SSH a un host a través del túnel |
| `wireshade socks [options]` | Conectar y exponer un proxy SOCKS5 local |
| `wireshade forward [options]` | Conectar y reenviar puertos (`-L` / `-R`, como `ssh`) |
| `wireshade unset-proxy` | Restaurar la configuración del proxy del sistema (recuperación tras un fallo) |
| `wireshade genkey` | Imprimir un nuevo par de claves de WireGuard |
| `wireshade version` | Imprimir la versión |
| `wireshade help` | Mostrar la ayuda |

### Ejemplos habituales

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

`wireshade ssh` reenvía un puerto local efímero al `:22` del host a través del túnel y ejecuta el `ssh` de tu sistema contra él. Usa `--port` para un puerto SSH no estándar y `-- <args>` para pasar un comando remoto o argumentos adicionales de `ssh`. Requiere que el cliente `ssh` del sistema esté instalado.

### Opciones de `socks`

| Opción | Descripción |
| :--- | :--- |
| `-c, --config <file>` | Archivo `.conf` de WireGuard (`[Interface]` + `[Peer]`) |
| `--private-key <b64>` | Clave privada de la interfaz (si no hay `--config`) |
| `--peer-key <b64>` | Clave pública del par (si no hay `--config`) |
| `--psk <b64>` | Clave precompartida (opcional) |
| `--endpoint <host:port>` | Endpoint UDP de WireGuard (si no hay `--config`) |
| `--source-ip <ip>` | IP de origen del túnel, p. ej. `10.0.0.2` (si no hay `--config`) |
| `--keepalive <sec>` | Keepalive persistente (por defecto `25`) |
| `-t, --transport <udp\|ws\|wss>` | Transporte portador (por defecto `udp`) |
| `--url <ws[s]://host:port>` | URL del servidor WS (obligatoria para `ws`/`wss`) |
| `--path-prefix <p>` | Prefijo de ruta del upgrade WS |
| `--ca <file>` | Fijar un certificado PEM (`wss`, autofirmado) |
| `--insecure` | Omitir la verificación TLS (solo pruebas) |
| `-l, --listen <[host:]port>` | Enlace SOCKS5 local (por defecto `127.0.0.1:1080`) |
| `--auth <user:pass>` | Exigir usuario/contraseña SOCKS5 |
| `--dns <ip>` | Resolver nombres de host mediante este servidor DNS a través del túnel (DNS-over-TCP); por defecto el valor `DNS =` del `.conf` |
| `--set-system-proxy` | Apuntar el sistema operativo a este proxy; se restaura automáticamente al salir |
| `--proxy-method <pac\|registry>` | Solo Windows; `pac` (por defecto) = SOCKS5 real mediante un archivo PAC, `registry` = entrada `socks=` (los navegadores lo tratan como SOCKS4) |
| `--chrome [url]` | Lanzar Chrome/Edge/Chromium a través de este proxy en un perfil aislado; cerrar el navegador detiene wireshade |
| `--chrome-path <file>` | Ejecutable del navegador (si no, se detecta automáticamente; también respeta `$CHROME_PATH`) |
| `-v, --verbose` | Registrar cada conexión proxied |

### Opciones de `forward`

Usa los **mismos flags de conexión que `socks`** (`-c` / `-t` / `--url` / `--ca` / …). Ambos flags de reenvío de puertos se pueden repetir.

| Opción | Descripción |
| :--- | :--- |
| `-L <localPort:remoteHost:remotePort>` | Reenviar un puerto local hacia la VPN (como `ssh -L`) |
| `-R <vpnPort:targetHost:targetPort>` | Publicar un servicio local en la VPN (como `ssh -R`) |

### Ejemplos

```bash
wireshade socks -c wg0.conf
wireshade socks -c wg0.conf -l 0.0.0.0:1080 --auth alice:secret
wireshade socks -c wg0.conf -t wss --url wss://vpn.example.com:443 --ca server.pem
wireshade socks -c wg0.conf --chrome https://example.internal
wireshade socks -c wg0.conf --set-system-proxy
```

En cuanto indique que el proxy está escuchando, apunta cualquier aplicación compatible con SOCKS5 hacia él:

```bash
curl --socks5-hostname 127.0.0.1:1080 http://<vpn-host>/
```

*   **proxychains:** añade `socks5 127.0.0.1 1080` a `proxychains.conf` y luego ejecuta `proxychains <your-app>`.
*   **Navegador:** configura el host SOCKS5 en `127.0.0.1` y el puerto en `1080` (elige SOCKS v5 con DNS remoto para que los nombres de host se resuelvan dentro de la VPN).

**Todo el internet a través de la VPN.** WireShade reenvía **cualquier** destino a través del túnel, no solo la subred propia de la VPN — así que el túnel de internet completo funciona **si el servidor WireGuard es un nodo de salida** (reenvío de IP + NAT). La IP pública de salida es entonces la del servidor; WireShade no la establece. Pasa `--dns <ip>` para mantener también la resolución DNS dentro del túnel (sin fugas), lo cual importa en el uso de túnel completo.

---

## 🧭 Tutorial: un servidor VPN por WebSocket + un cliente con Chrome

De principio a fin: ejecuta un **servidor WS** de WireShade en una VM pública, pon **nginx / Nginx Proxy Manager** delante con un dominio real (TLS) y luego, desde tu portátil, **conéctate con la CLI y abre Chrome** enrutado a través del túnel — sin root ni dispositivo TUN en ninguno de los dos lados.

### 1. Generar claves

Ejecútalo dos veces — una para el servidor y otra para el cliente — y anota cada par:

```bash
wireshade genkey
```

El servidor necesita su **propia clave privada** + la **clave pública del cliente**; el cliente necesita su **propia clave privada** + la **clave pública del servidor**.

### 2. El peer servidor

La CLI es el lado cliente; el **servidor** WS es un breve script que usa `WireShadeWsServer`. Elige una de dos estrategias de TLS.

**Variante A — WireShade termina el TLS por sí mismo (`wss://`)**

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

Mantenlo en ejecución con `pm2` o una unidad de `systemd`.

**Variante B — nginx / Nginx Proxy Manager termina el TLS en tu dominio (recomendado)**

Deja que el proxy gestione el dominio + el certificado y mantén WireShade en texto plano sobre loopback:

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

Bloque `server` de nginx para `vpn.example.com` (certificado con `certbot`):

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

**Nginx Proxy Manager (GUI):** añade un *Proxy Host* → Dominio `vpn.example.com`, Forward Hostname/Port `127.0.0.1` / `8000` (esquema `http`), activa **Websockets Support**, solicita un certificado de Let's Encrypt en la pestaña *SSL* y, en la pestaña *Advanced*, añade un bloque `location /wg/ { … }` con las mismas cabeceras `Upgrade`/`Connection` para que coincida el prefijo de ruta.

### 3. Conectar desde el cliente y lanzar Chrome

Un solo comando de la CLI abre el túnel sobre WSS y lanza un **Chrome aislado** que se enruta a través de él:

```bash
wireshade socks \
  -t wss --url wss://vpn.example.com:443 --path-prefix wg \
  --private-key '<client private key>' \
  --peer-key    '<server public key>' \
  --source-ip   10.0.0.2 \
  --dns 10.0.0.1 \
  --chrome http://10.0.0.1:8080/
```

Cerrar esa ventana de Chrome detiene `wireshade` y desmonta el túnel. ¿Prefieres un archivo? Un `.conf` de cliente también sirve — ten en cuenta que el parser de WireShade sigue requiriendo una línea `Endpoint`, que el transporte WS ignora:

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

> **Alcance del servidor WS.** Un peer WS de WireShade en espacio de usuario responde en su **propia** IP de túnel (`10.0.0.1`) y en lo que publiques con `forwardRemote()` — ideal para llegar a paneles internos, bases de datos y aplicaciones web. **La salida completa a Internet público** (sitios arbitrarios a través de la VPN) requiere que el **servidor WireGuard sea un nodo de salida** (reenvío de IP + NAT) — una máquina WireGuard del kernel sobre el transporte `udp`, no un peer WS en espacio de usuario.

---

## 🎯 Los 10 principales casos de uso

Recetas listas para copiar y pegar para lo que más se usa. Cada fragmento es autónomo: sustituye tus propias claves, IPs y la ruta del `.conf`, y ejecútalo tras `npm i wireshade`.

### 1. Llamar a una API HTTPS interna a través del túnel

Accede a una API privada que solo existe dentro de la VPN, con el ayudante integrado o mediante un agente de axios/got/fetch.

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

### 2. Conectar desde un `.conf` de WireGuard existente

Apunta WireShade a un archivo de configuración estándar, sin gestionar claves en el código.

```javascript
const { WireShade } = require('wireshade');

// A standard [Interface] / [Peer] file is parsed for you.
const client = new WireShade('/etc/wireguard/wg0.conf');
await client.start();

console.log('tunnel up as', client.config.wireguard.sourceIp);
await client.close();
```

### 3. Abrir una conexión TCP en bruto

Habla con cualquier servicio TCP (Redis, SMTP, un servidor de juegos…) mediante un stream compatible con `net.Socket`.

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

### 4. Exponer un servicio TCP dentro de la VPN

Ejecuta un listener en tu IP de VPN al que otros peers puedan conectarse.

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

### 5. Reenvío de puerto local (como `ssh -L`)

Alcanza un servicio remoto de la VPN en un puerto local, p. ej. una base de datos privada en `localhost`.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// localhost:5432 → 10.0.0.5:5432 inside the VPN.
await client.forwardLocal(5432, '10.0.0.5', 5432);
console.log('psql -h localhost -p 5432 now reaches the VPN database');
```

### 6. Reenvío de puerto remoto (como `ssh -R`)

Publica un servicio local en la VPN para que cualquier peer lo alcance, incluso tras NAT.

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// Publish your local :3000 to VPN peers at <your VPN IP>:8080.
await client.forwardRemote(8080, 'localhost', 3000);
console.log('local :3000 is now reachable across the VPN on :8080');
```

### 7. Servir una app Express/HTTP a través del túnel

Canaliza las conexiones del túnel directamente hacia un servidor HTTP de Node, sin abrir nunca un puerto público.

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

### 8. Asignar nombres de host a IPs de VPN (DNS personalizado)

Usa nombres amigables para los hosts de la VPN sin tocar `/etc/hosts`.

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

### 9. Comprobar el estado de un peer con ping ICMP

Mide el tiempo de ida y vuelta a un peer y detecta cuándo deja de responder.

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

### 10. Atravesar un firewall con WebSocket/WSS

Transporta todo el túnel por un único puerto `wss://` (443) para atravesar proxys solo-HTTP y firewalls estrictos.

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

### 🍳 Más recetas

Siete patrones más probados en producción — con el mismo estilo autónomo, numerados a continuación de los diez anteriores.

### 11. Reutilizar un cliente de BD / Redis existente, sin cambios

Reenvía el puerto remoto a `localhost` y apunta tu controlador existente ahí — la propia biblioteca no necesita cambios.

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

### 12. Conectar por SSH a un host de la VPN mediante un puerto reenviado

Expón el puerto SSH de un peer en `localhost` y conéctate con un cliente `ssh` estándar.

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

### 13. VPN entre dos peers — sin servidor central

Dos peers de WireShade forman un túnel directo: uno escucha y el otro se conecta.

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

### 14. Sobrevivir a caídas con auto-reconexión, eventos y comprobaciones de salud

Activa la reconexión con backoff y observa el ciclo de vida del túnel mediante eventos.

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

### 15. Ejecutar en CI / serverless / contenedores — sin root

No requiere dispositivo TUN ni privilegios, así que el túnel funciona donde una VPN de kernel no puede.

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

### 16. `ws://` en texto plano detrás de un proxy inverso que termina TLS

Deja que nginx/Caddy gestione TLS y mantén el lado de WireShade en texto plano.

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

### 17. Exponer toda la VPN como un proxy SOCKS5

Ejecuta un proxy SOCKS5 local que enruta cada conexión a través del túnel — cualquier aplicación compatible con SOCKS5 podrá entonces alcanzar cualquier host dentro de la VPN, sin un reenvío por servicio.

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

La CLI hace exactamente esto sin escribir ni una línea de código: `wireshade socks -c wg0.conf`.

---

## 📚 Ejemplos

Los scripts ejecutables están en [`examples/`](examples/):

| Archivo | Muestra |
| :--- | :--- |
| `01_quickstart.js` | Conectar, pedir y escuchar: el «hola mundo». |
| `02_http_request.js` | GET HTTP simple con `client.get()`. |
| `03_https_custom_dns.js` | HTTPS con un nombre de host mapeado a una IP de la VPN. |
| `04_tcp_socket.js` | Envío/recepción TCP en crudo a través del túnel. |
| `05_internet_routing.js` | Enrutar tráfico de internet público por la puerta de enlace de la VPN. |
| `06_simple_server.js` | Alojar un servidor TCP/HTTP dentro del túnel. |
| `07_express_app.js` | Exponer una app Express por la VPN (túnel inverso). |
| `08_local_forwarding.js` | `forwardLocal`: alcanzar un servicio de la VPN en `localhost`. |
| `09_reconnect_config.js` | Reconexión, comprobaciones de salud y monitoreo de eventos. |
| `10_remote_forwarding.js` | `forwardRemote`: publicar un servicio local en la VPN. |
| `11_websocket_wss.js` | WireGuard sobre WSS con el binding **nativo**. |
| `13_websocket_highlevel.js` | WireGuard sobre WSS con la API de **alto nivel**. |
| `14_socks_proxy.js` | Proxy SOCKS5 sobre el túnel. |
| `local_vpn.js` | Dos pares locales formando un túnel P2P para pruebas. |

---

## 🎯 Casos de uso

*   **Microservicios:** conectar servicios entre nubes sin exponer puertos públicos.
*   **Web scraping:** ejecutar varias instancias en distintos endpoints para rotar IPs de salida.
*   **Acceso de desarrolladores:** alcanzar bases de datos internas privadas desde un portátil, de forma segura.
*   **IoT y edge:** conectar dispositivos detrás de NATs restrictivos de vuelta a un servidor central.

---

## 📜 Licencia

Licencia MIT.

*WireGuard es una marca registrada de Jason A. Donenfeld.*
</content>
