# 👻 WireShade Node.js 版

**Node.js 终极用户态 WireGuard® 实现**

[![npm version](https://img.shields.io/npm/v/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**WireShade** 使您的 Node.js 应用程序能够直接连接到 WireGuard VPN，而**无需 root 权限**、内核模块或修改系统网络设置。它使用直接集成到 Node.js 中的自定义 Rust TCP/IP 栈（`smoltcp`）完全在用户态运行。

<div align="center">

[🇺🇸 English](README.md) | [🇩🇪 Deutsch](README.de.md) | [🇪🇸 Español](README.es.md) | [🇫🇷 Français](README.fr.md) | [🇨🇳 中文](README.zh.md)

</div>

---

## 🚀 为什么选择 WireShade？

WireShade 以干净的原生用户态解决方案解决了复杂的网络实现挑战：

*   **🛡️ 隐蔽与安全：** 通过安全的 WireGuard VPN 路由特定的 Node.js 流量，同时保持其余系统流量正常。非常适合 **Web 爬虫**、**机器人**或**安全通信**。
*   **🌍 反向隧道：** 将本地 Express 服务器、WebSocket 服务器或 Next.js 应用程序暴露给私有 VPN 网络，即使您在 NAT 或防火墙后面。
*   **🔌 零配置客户端：** 无需在主机上安装 WireGuard。只需 `npm install` 即可。
*   **🔄 自动重连：** 内置逻辑，可无缝处理连接断开和网络更改。
*   **⚡ 高性能：** 由 Rust 和 NAPI-RS 提供支持，具有近乎原生的性能。

## 📦 安装

```bash
npm install wireshade
```

---

## 🛠️ 使用示例

所有示例均假设您已初始化客户端：
```javascript
const { WireShade, readConfig } = require('wireshade');
const client = new WireShade(readConfig('./wg0.conf'));
await client.start();
```

### 1. HTTP/HTTPS请求 (客户端)
使用 WireShade 作为请求的透明代理。

**原生 `http`/`https` 模块：**
```javascript
const https = require('https');

https.get('https://api.internal/data', { agent: client.getHttpsAgent() }, (res) => {
    res.pipe(process.stdout);
});
```

**Axios：**
```javascript
const axios = require('axios');

const response = await axios.get('https://internal.service/api', {
    httpAgent: client.getHttpAgent(),
    httpsAgent: client.getHttpsAgent()
});
```

### 2. TCP & WebSockets 到 VPN (客户端)
连接到 VPN 内部运行的原始 TCP 服务或 WebSocket。

**WebSockets：**
```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://10.0.0.5:8080/stream', {
    agent: client.getHttpAgent() 
});

ws.on('open', () => console.log('已连接到 VPN WebSocket！'));
```

### 3. 暴露本地服务器 (反向隧道)
使您的本地服务器**仅**通过 VPN 可访问。

**Express / Next.js：**
```javascript
const express = require('express');
const http = require('http');
const { WireShadeServer } = require('wireshade');

const app = express();
app.get('/', (req, res) => res.send('🎉 隐藏在 VPN 内部！'));

const httpServer = http.createServer(app);
const vpnServer = new WireShadeServer(client);

// 将 VPN 套接字传输到 HTTP 服务器
vpnServer.on('connection', (socket) => httpServer.emit('connection', socket));

await vpnServer.listen(80);
console.log('服务器在线地址 http://<VPN-IP>/');
```

---

## 📜 许可证

MIT 许可证。

*WireGuard 是 Jason A. Donenfeld 的注册商标。*
