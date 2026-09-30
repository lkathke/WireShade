# 👻 WireShade con Node.js

**La implementación definitiva de WireGuard® en espacio de usuario para Node.js**

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
