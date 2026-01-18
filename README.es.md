# 👻 WireShade usando Node.js

**La implementación definitiva de WireGuard® en espacio de usuario para Node.js**

[![npm version](https://img.shields.io/npm/v/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**WireShade** permite que tu aplicación Node.js se conecte directamente a una VPN WireGuard **sin privilegios de root**, módulos del kernel ni modificaciones en la configuración de red del sistema. Se ejecuta completamente en espacio de usuario utilizando una pila TCP/IP basada en Rust (`smoltcp`) integrada directamente en Node.js.

<div align="center">

[🇺🇸 English](README.md) | [🇩🇪 Deutsch](README.de.md) | [🇪🇸 Español](README.es.md) | [🇫🇷 Français](README.fr.md) | [🇨🇳 中文](README.zh.md)

</div>

---

## 🚀 ¿Por qué WireShade?

WireShade resuelve desafíos complejos de implementación de redes con una solución limpia y nativa en espacio de usuario:

*   **🛡️ Sigilo y Seguridad:** Enruta tráfico específico de Node.js a través de una VPN WireGuard segura mientras mantienes el resto del tráfico de tu sistema normal. Perfecto para **web scraping**, **bots** o **comunicación segura**.
*   **🌍 Túnel Inverso:** Expone un servidor Express local, un servidor WebSocket o una aplicación Next.js a la red VPN privada, incluso si estás detrás de un NAT o firewall.
*   **🔌 Cliente Cero Configuración:** No es necesario instalar WireGuard en la máquina host. Simplemente `npm install` y listo.
*   **🔄 Reconexión Automática:** Lógica integrada para manejar caídas de conexión y cambios de red sin problemas.
*   **⚡ Alto Rendimiento:** Impulsado por Rust y NAPI-RS para un rendimiento casi nativo.

## ✅ Plataformas Soportadas

| Plataforma | Arquitectura | Estado |
| :--- | :--- | :--- |
| **Windows** | x64 | ✅ |
| **macOS** | Intel & Apple Silicon | ✅ |
| **Linux** | x64, ARM64 | ✅ |
| **Raspberry Pi** | ARMv7 | ✅ |
| **Docker** | Alpine, Debian | ✅ |

## 📦 Instalación

```bash
npm install wireshade
```

---

## 🛠️ Ejemplos de Uso

Todos los ejemplos asumen que has inicializado el cliente:
```javascript
const { WireShade, readConfig } = require('wireshade');
const client = new WireShade(readConfig('./wg0.conf'));
await client.start();
```

### 1. Solicitudes HTTP/HTTPS (Cliente)
Usa WireShade como un agente transparente para tus solicitudes.

> **Nota sobre DNS:** Puedes mapear nombres de host personalizados como `internal.service` directamente a direcciones IP en la configuración de `hosts`. WireShade resolverá automáticamente estos nombres durante la solicitud.

**Módulo nativo `http`/`https`:**
```javascript
const https = require('https');

https.get('https://api.internal/data', { agent: client.getHttpsAgent() }, (res) => {
    res.pipe(process.stdout);
});
```

**Axios:**
```javascript
const axios = require('axios');

const response = await axios.get('https://internal.service/api', {
    httpAgent: client.getHttpAgent(),
    httpsAgent: client.getHttpsAgent()
});
```

### 2. TCP y WebSockets a VPN (Cliente)
Conéctate a servicios TCP sin procesar o WebSockets que se ejecutan dentro de la VPN.

**WebSockets:**
```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://10.0.0.5:8080/stream', {
    agent: client.getHttpAgent() 
});

ws.on('open', () => console.log('¡Conectado al WebSocket VPN!'));
```

### 3. Exponer Servidores Locales (Túnel Inverso)
Haz que tu servidor local sea accesible **solo** a través de la VPN.

**Express / Next.js:**
```javascript
const express = require('express');
const http = require('http');
const { WireShadeServer } = require('wireshade');

const app = express();
app.get('/', (req, res) => res.send('🎉 ¡Oculto dentro de la VPN!'));

const httpServer = http.createServer(app);
const vpnServer = new WireShadeServer(client);

// Alimentar el socket VPN al servidor HTTP
vpnServer.on('connection', (socket) => httpServer.emit('connection', socket));

await vpnServer.listen(80);
console.log('Servidor en línea en http://<VPN-IP>/');
```

---

## 📜 Licencia

Licencia MIT.

*WireGuard es una marca registrada de Jason A. Donenfeld.*
