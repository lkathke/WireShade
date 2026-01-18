# 👻 WireShade avec Node.js

**L'implémentation ultime de WireGuard® en espace utilisateur pour Node.js**

[![npm version](https://img.shields.io/npm/v/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![npm downloads](https://img.shields.io/npm/dm/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**WireShade** permet à votre application Node.js de se connecter directement à un VPN WireGuard **sans privilèges root**, sans modules noyau, et sans modifier les paramètres réseau du système. Il s'exécute entièrement dans l'espace utilisateur en utilisant une pile TCP/IP personnalisée basée sur Rust (`smoltcp`) intégrée directement dans Node.js.

<div align="center">

[🇺🇸 English](README.md) | [🇩🇪 Deutsch](README.de.md) | [🇪🇸 Español](README.es.md) | [🇫🇷 Français](README.fr.md) | [🇨🇳 中文](README.zh.md)

</div>

---

## 🚀 Pourquoi WireShade ?

WireShade résout les défis complexes d'implémentation réseau avec une solution propre et native :

*   **🛡️ Discrétion & Sécurité :** Acheminez le trafic spécifique de Node.js via un VPN WireGuard sécurisé tout en gardant le reste du trafic de votre système normal. Parfait pour le **web scraping**, les **bots**, ou la **communication sécurisée**.
*   **🌍 Tunnel Inverse (Reverse Tunneling) :** Exposez un serveur Express local, un serveur WebSocket ou une application Next.js au réseau VPN privé, même si vous êtes derrière un NAT ou un pare-feu.
*   **🔌 Client Zéro Configuration :** Pas besoin d'installer WireGuard sur la machine hôte. Juste `npm install` et c'est parti.
*   **🔄 Reconnexion Automatique :** Logique intégrée pour gérer les pertes de connexion et les changements de réseau de manière transparente.
*   **⚡ Haute Performance :** Propulsé par Rust et NAPI-RS pour des performances quasi-natives.

## ✅ Plates-formes supportées

| Plate-forme | Architecture | Statut |
| :--- | :--- | :--- |
| **Windows** | x64 | ✅ |
| **macOS** | Intel & Apple Silicon | ✅ |
| **Linux** | x64, ARM64 | ✅ |
| **Raspberry Pi** | ARMv7 | ✅ |
| **Docker** | Alpine, Debian | ✅ |

## 📦 Installation

```bash
npm install wireshade
```

---

## 🛠️ Exemples d'Utilisation

Tous les exemples supposent que vous avez initialisé le client :
```javascript
const { WireShade, readConfig } = require('wireshade');
const client = new WireShade(readConfig('./wg0.conf'));
await client.start();
```

### 1. Requêtes HTTP/HTTPS (Client)
Utilisez WireShade comme un agent transparent pour vos requêtes.

> **Note sur le DNS :** Vous pouvez mapper des noms d'hôtes personnalisés comme `internal.service` directement à des adresses IP dans la configuration `hosts`. WireShade résoudra automatiquement ces noms lors de la requête.

**Module natif `http`/`https` :**
```javascript
const https = require('https');

https.get('https://api.internal/data', { agent: client.getHttpsAgent() }, (res) => {
    res.pipe(process.stdout);
});
```

**Axios :**
```javascript
const axios = require('axios');

const response = await axios.get('https://internal.service/api', {
    httpAgent: client.getHttpAgent(),
    httpsAgent: client.getHttpsAgent()
});
```

### 2. TCP & WebSockets vers VPN (Client)
Connectez-vous à des services TCP bruts ou WebSockets s'exécutant à l'intérieur du VPN.

**WebSockets :**
```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://10.0.0.5:8080/stream', {
    agent: client.getHttpAgent() 
});

ws.on('open', () => console.log('Connecté au WebSocket VPN !'));
```

### 3. Exposer des Serveurs Locaux (Tunnel Inverse)
Rendez votre serveur local accessible **uniquement** via le VPN.

**Express / Next.js :**
```javascript
const express = require('express');
const http = require('http');
const { WireShadeServer } = require('wireshade');

const app = express();
app.get('/', (req, res) => res.send('🎉 Caché dans le VPN !'));

const httpServer = http.createServer(app);
const vpnServer = new WireShadeServer(client);

// Transmettre le socket VPN au serveur HTTP
vpnServer.on('connection', (socket) => httpServer.emit('connection', socket));

await vpnServer.listen(80);
console.log('Serveur en ligne sur http://<VPN-IP>/');
```

---

## 📜 Licence

Licence MIT.

*WireGuard est une marque déposée de Jason A. Donenfeld.*
