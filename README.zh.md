# 👻 WireShade Node.js 版

**Node.js 用户态 WireGuard® —— 一个库*以及*一个 SSH 风格的命令行工具（SOCKS5、端口转发、`ssh`），运行在 UDP 或 WebSocket 之上，无需 root 或 TUN 设备。**

[![npm version](https://img.shields.io/npm/v/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![npm downloads](https://img.shields.io/npm/dm/wireshade.svg)](https://www.npmjs.com/package/wireshade)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**WireShade** 让你的 Node.js 应用无需 **root 权限**、内核模块或修改系统网络设置，即可直接连接 WireGuard VPN。它完全运行在用户态，使用直接集成进 Node.js 的自定义 Rust TCP/IP 协议栈（`smoltcp`）——从不创建任何 TUN/TAP 接口。

<div align="center">

[🇺🇸 English](README.md) | [🇩🇪 Deutsch](README.de.md) | [🇪🇸 Español](README.es.md) | [🇫🇷 Français](README.fr.md) | [🇨🇳 中文](README.zh.md)

</div>

---

## 🚀 为什么选择 WireShade？

*   **🛡️ 隐蔽与安全：** 将特定的 Node.js 流量路由经 WireGuard VPN，同时系统其余流量保持正常。非常适合网页抓取、机器人或安全的服务间通信。
*   **🌍 反向隧道：** 即使身处 NAT 或防火墙之后，也能把本地 Express/Fastify/Next.js 服务器或原始 TCP 服务暴露到私有 VPN 网络。
*   **🔌 零配置客户端：** 无需在主机上安装 WireGuard，只需 `npm install` 即可使用。
*   **🧱 WebSocket / WSS 传输：** 通过单条 `ws://` 或 `wss://` 连接承载整个 WireGuard 隧道，穿透严格的防火墙和仅允许 HTTP 的代理。
*   **🔄 自动重连：** 内置退避、健康检查和事件，从容应对连接中断与网络切换。
*   **⚡ 高性能：** 由 Rust 与 NAPI-RS 驱动，性能接近原生。

## 🧠 工作原理

WireShade 通过在你的 Node.js 进程内运行一个**用户态 TCP/IP 协议栈**（[smoltcp](https://github.com/smoltcp-rs/smoltcp)）来绕过宿主操作系统的网络栈：

1.  **握手：** WireShade 与对端完成真正的 WireGuard 握手（经 UDP 或经 WebSocket）。
2.  **封装：** IP 数据包被加密并封装进传输帧中。
3.  **用户态路由：** 解密后的数据包由 Rust 中的 `smoltcp` 处理，负责 TCP 状态、重传与缓冲。
4.  **Node.js 集成：** 数据通过高性能 NAPI 绑定在 Rust 与 Node.js 的 `net.Socket` / `http.Agent` 实例之间流转。

这意味着：**没有虚拟网络接口**、**无需 root**、与现有 VPN **无冲突**，并且**跨平台**支持而无需内核模块。

## ✅ 支持的平台

原生二进制文件已**为以下六个目标预编译，并在 `require()` 时自动加载**——安装时无需编译器或构建步骤。

| 目标三元组 | 平台 | 架构 |
| :--- | :--- | :--- |
| `x86_64-pc-windows-msvc` | Windows | x64 |
| `x86_64-apple-darwin` | macOS | Intel |
| `aarch64-apple-darwin` | macOS | Apple Silicon |
| `x86_64-unknown-linux-gnu` | Linux | x64 |
| `aarch64-unknown-linux-gnu` | Linux | ARM64 |
| `armv7-unknown-linux-gnueabihf` | Linux / Raspberry Pi | ARMv7 |

## 📦 安装

```bash
npm i wireshade
```

---

## ⚡ 快速开始

### 使用配置对象

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

### 使用 WireGuard `.conf` 文件

传入路径字符串而非配置对象——标准的 `[Interface]` / `[Peer]` 文件会被自动解析（包括 `PersistentKeepalive`）：

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

const body = await client.get('http://10.0.0.1/');
console.log(body);

await client.close();
```

若要通过 `axios`、`node-fetch`、`ws` 等发起真实请求，请传入隧道 agent：

```javascript
const axios = require('axios');
const res = await axios.get('https://internal.service/api', {
    httpAgent: client.getHttpAgent(),
    httpsAgent: client.getHttpsAgent()
});
```

---

## 🧱 WebSocket / WSS 传输

WireShade 可以不走 UDP，而是通过**单条 WebSocket 连接**承载整个 WireGuard 隧道。这是穿透仅允许 HTTP(S) 的严格防火墙和代理、可靠地「直接连通」的方式。两端都是 WireShade 实例：一端作为 WS **服务端**（终止 TLS + 隧道），另一端作为 WS **客户端**。

### 服务端对等体

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

### 客户端对等体

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

其余一切——`connect`、`listen`、`forwardLocal`、`forwardRemote`、`ping`、`http`/`https` 包装器以及自动重连逻辑——在 WebSocket 上的表现完全一致。参见 [`examples/13_websocket_highlevel.js`](examples/13_websocket_highlevel.js)（高层）与 [`examples/11_websocket_wss.js`](examples/11_websocket_wss.js)（原生绑定）。

**`ws://` 与 `wss://` 对比：** 当 TLS 已由 WireShade 前面的反向代理（如 nginx 或 Caddy）终止时，使用明文 `ws://`（省略服务端 `tls` 块）；若要让 WireShade 自己终止 TLS，则使用原生 `wss://`（配合 `tls: { cert, key }`）。在客户端，`tls.ca` 固定（pin）某个特定证书，`tls.servername` 覆盖 SNI，`tls.insecureSkipVerify` 则完全关闭验证——**仅供测试，切勿用于生产**。

> **权衡——TCP over TCP：** WebSocket 传输把 WireGuard（进而把你的内层 TCP）隧道封装在外层 TCP/TLS 流之中。它非常适合穿透防火墙/代理以及可靠、有序的链路，但在丢包或高抖动的路径上，两层叠加的拥塞控制回路可能相互冲突（即「TCP meltdown」）。当网络不可靠时，纯 UDP 传输通常表现更好；当你只需「连通」时，WebSocket 胜出。

---

## 📖 核心 API

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
从配置对象，或从 `.conf` 文件路径（`new WireShade('wg.conf')`）创建客户端。`config.wireguard` 接受常见的 WireGuard 字段：`privateKey`、`peerPublicKey`、`presharedKey`、`endpoint`、`sourceIp`、`listenPort`、`persistentKeepalive`。`persistentKeepalive` 以秒为单位（`.conf` 文件中的 `PersistentKeepalive`），默认为 `25`，设为 `0` 则禁用。其他选项：`logging`（默认 `true`）、`handshakeTimeout`（毫秒，默认 `10000`）、`hosts`、`reconnect`、`transport` 以及 `onConnect`/`onDisconnect`/`onReconnect`。

**`client.start()`** → `Promise<void>`
建立连接，并在**与对端完成真正的 WireGuard 握手后**兑现（在超时、DNS/绑定错误，或先调用了 `close()` 时被拒绝）。当两端都是 WireShade 实例时，请并发启动它们：`Promise.all([a.start(), b.start()])`。

**`client.close()`** → `Promise<void>`
停止重连与健康检查，关闭所有服务器/连接并关停原生隧道。在原生任务停止后兑现。（`close()` 是原生 `shutdown()` 的高层等价物。）

**重连** —— 通过 `reconnect` 块配置；状态变化以事件形式呈现：

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

已注册的监听器（`listen`/`forwardRemote`）会在重连后于新隧道上自动重建。

**`client.ping(ip)`** → `Promise<number>` —— ICMP 回显；兑现为往返时间（毫秒）。

**`client.connect({ host, port })`** → `Duplex` —— 经隧道的、与 `net.Socket` 兼容的流。触发 `'connect'`、`'data'`、`'end'`、`'error'`。

**`client.listen(port, [onConnection])`** → `Promise<Server>` —— 在 **VPN IP** 上的 TCP 服务器；`onConnection` 每个连接收到一个 socket。

**`client.forwardLocal(localPort, remoteHost, remotePort)`** → `Promise` —— 把 VPN 侧服务暴露到你的本地机器（`localhost:localPort` → VPN 内的 `remoteHost:remotePort`）。

**`client.forwardRemote(vpnPort, targetHost, targetPort)`** → `Promise` —— 把本地服务暴露给 VPN 对等体（VPN IP `:vpnPort` → 你机器上的 `targetHost:targetPort`）。

```javascript
await client.forwardLocal(3333, '10.0.0.5', 5432);   // reach VPN Postgres via localhost:3333
await client.forwardRemote(8080, 'localhost', 3000); // publish local :3000 on the VPN at :8080
```

**`client.get(url, [opts])` / `client.request(url, [opts])`** → `Promise<string | object>` —— 经隧道的 HTTP(S)。兑现为响应体字符串（`opts.encoding`，默认 `utf8`）；当 `opts.fullResponse: true` 时兑现为 `{ statusCode, statusMessage, headers, body, rawBody }`。`opts.body` 设置请求体。

**`client.getHttpAgent()` / `client.getHttpsAgent()`** —— 经隧道路由的 `http.Agent` / `https.Agent`（用于 `axios`、`node-fetch`、`ws` 等）。

**`client.addHost(hostname, ip)`** —— 无需改动 `/etc/hosts` 即可把主机名映射到 VPN IP；该映射用于客户端自身的请求与转发。

**`generateKeyPair()`** → `{ privateKey, publicKey }` —— 一对全新的 WireGuard 密钥。

**`parseConfig(text)` / `readConfig(path)`** —— 将字符串或文件中的 WireGuard 配置解析为配置对象。

**`generateSelfSignedCert(sans)`** → `{ certPem, keyPem }` —— 为给定的 subject alternative names 生成自签名证书及密钥（PEM），便于在开发/测试中无需 OpenSSL 即可使用 `wss://`。

**`new WireShadeWsServer({ listen, pathPrefix, tls, wireguard, ... })`** —— WebSocket 服务端对等体。`listen` 为 `"host:port"`；提供 `tls: { cert, key }` 以启用 `wss://`，省略则为 `ws://`。其 `start()` 在 socket **完成绑定并开始监听**时即兑现（早于任何对端握手），因此可以立刻注册 `listen`/`forwardRemote`。`WireShadeClient` 的其余所有方法与事件同样适用。

---

## 📊 基准测试

WireShade 附带两个基准脚本。数值因机器而异，请自行运行。

```bash
# Raw tunnel goodput + CPU-per-core on loopback (crypto/CPU cost, not RTT/loss):
BENCH_TRANSPORT=udp BENCH_SECONDS=5 BENCH_CHUNK=262144 node bench/throughput.js
#   BENCH_TRANSPORT = udp | ws | wss

# Real iperf3 driven through the tunnel (needs iperf3 in PATH; skips cleanly if absent):
BENCH_TRANSPORT=udp node bench/iperf3.js
```

`bench/throughput.js` 在环回上测量整条路径（WireGuard 加密 + `smoltcp` + NAPI 边界）的有效吞吐（goodput）与每核 CPU 开销——它隔离出加密/CPU 吞吐能力，而非网络延迟或丢包。`bench/iperf3.js` 让一对真实的 `iperf3` 客户端/服务端通过隧道运行，得到业界标准数值；若未安装 `iperf3`，则自动跳过（退出码 0）。

---

## 🖥️ 命令行界面（CLI）

WireShade 附带一个 `wireshade` 命令，可建立隧道并暴露一个本地 **SOCKS5 代理**——无需编写代码。既可全局安装，也可用 `npx` 按需运行。借助 npm 的 bin shim，它在 **Windows、macOS 和 Linux** 上表现一致。

```bash
npm i -g wireshade        # installs the `wireshade` command globally
# …or run it without installing:
npx wireshade socks -c wg0.conf
```

### 命令

| 命令 | 说明 |
| :--- | :--- |
| `wireshade ssh [options] [user@]host [-- cmd]` | 通过隧道 SSH 连接到主机 |
| `wireshade socks [options]` | 连接并暴露一个本地 SOCKS5 代理 |
| `wireshade forward [options]` | 连接并转发端口（`-L` / `-R`，类似 `ssh`） |
| `wireshade unset-proxy` | 恢复系统代理设置（崩溃恢复） |
| `wireshade genkey` | 打印一个新的 WireGuard 密钥对 |
| `wireshade version` | 打印版本号 |
| `wireshade help` | 显示用法 |

### 常用示例

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

`wireshade ssh` 会通过隧道将一个临时本地端口转发到主机的 `:22`，然后对其运行你系统的 `ssh`。使用 `--port` 指定非标准 SSH 端口，使用 `-- <args>` 传递远程命令或额外的 `ssh` 参数。它依赖系统已安装 `ssh` 客户端。

### `socks` 选项

| 选项 | 说明 |
| :--- | :--- |
| `-c, --config <file>` | WireGuard `.conf` 文件（`[Interface]` + `[Peer]`） |
| `--private-key <b64>` | 接口私钥（未提供 `--config` 时） |
| `--peer-key <b64>` | 对端公钥（未提供 `--config` 时） |
| `--psk <b64>` | 预共享密钥（可选） |
| `--endpoint <host:port>` | WireGuard UDP 端点（未提供 `--config` 时） |
| `--source-ip <ip>` | 隧道源 IP，例如 `10.0.0.2`（未提供 `--config` 时） |
| `--keepalive <sec>` | 持久保活（默认 `25`） |
| `-t, --transport <udp\|ws\|wss>` | 承载传输（默认 `udp`） |
| `--url <ws[s]://host:port>` | WS 服务器 URL（`ws`/`wss` 必需） |
| `--path-prefix <p>` | WS 升级路径前缀 |
| `--ca <file>` | 固定一个 PEM 证书（`wss`，自签名） |
| `--insecure` | 跳过 TLS 验证（仅用于测试） |
| `-l, --listen <[host:]port>` | 本地 SOCKS5 绑定（默认 `127.0.0.1:1080`） |
| `--auth <user:pass>` | 要求 SOCKS5 用户名/密码 |
| `--dns <ip>` | 通过隧道用此 DNS 服务器解析主机名（DNS-over-TCP）；默认使用 `.conf` 的 `DNS =` 值 |
| `--set-system-proxy` | 将操作系统指向此代理；退出时自动恢复 |
| `--proxy-method <pac\|registry>` | 仅限 Windows；`pac`（默认）= 通过 PAC 文件的真正 SOCKS5，`registry` = `socks=` 条目（浏览器将其视为 SOCKS4） |
| `--chrome [url]` | 通过此代理在隔离的配置文件中启动 Chrome/Edge/Chromium；关闭浏览器会停止 wireshade |
| `--chrome-path <file>` | 浏览器可执行文件（否则自动检测；也遵循 `$CHROME_PATH`） |
| `-v, --verbose` | 记录每个被代理的连接 |

### `forward` 选项

使用与 `socks` **相同的连接标志**（`-c` / `-t` / `--url` / `--ca` / …）。两个端口转发标志均可重复使用。

| 选项 | 说明 |
| :--- | :--- |
| `-L <localPort:remoteHost:remotePort>` | 将本地端口转发进 VPN（类似 `ssh -L`） |
| `-R <vpnPort:targetHost:targetPort>` | 将本地服务发布到 VPN 中（类似 `ssh -R`） |

### 示例

```bash
wireshade socks -c wg0.conf
wireshade socks -c wg0.conf -l 0.0.0.0:1080 --auth alice:secret
wireshade socks -c wg0.conf -t wss --url wss://vpn.example.com:443 --ca server.pem
wireshade socks -c wg0.conf --chrome https://example.internal
wireshade socks -c wg0.conf --set-system-proxy
```

一旦它报告代理正在监听，就把任意支持 SOCKS5 的应用指向它：

```bash
curl --socks5-hostname 127.0.0.1:1080 http://<vpn-host>/
```

*   **proxychains：** 在 `proxychains.conf` 中加入 `socks5 127.0.0.1 1080`，然后运行 `proxychains <your-app>`。
*   **浏览器：** 将 SOCKS5 主机设为 `127.0.0.1`、端口设为 `1080`（选择带远程 DNS 的 SOCKS v5，让主机名在 VPN 内部解析）。

**通过 VPN 访问完整互联网。** WireShade 会将**任意**目标通过隧道转发，而不仅仅是 VPN 自身的子网——因此，**只要 WireGuard 服务器是出口节点**（IP 转发 + NAT），完整的互联网隧道就能工作。此时公网出口 IP 是服务器的，而不是 WireShade 设定的。传入 `--dns <ip>` 可让 DNS 解析同样保持在隧道内（无泄漏），这对全隧道使用很重要。

---

## 🎯 十大使用场景

面向最常见需求的即用型代码示例。每段代码都可独立运行——替换成你自己的密钥、IP 和 `.conf` 路径，在 `npm i wireshade` 之后即可运行。

### 1. 通过隧道调用内部 HTTPS API

访问仅存在于 VPN 内部的私有 API：使用内置辅助方法，或通过 axios/got/fetch 代理。

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

### 2. 使用现有的 WireGuard `.conf` 连接

让 WireShade 指向标准配置文件，无需在代码中处理密钥。

```javascript
const { WireShade } = require('wireshade');

// A standard [Interface] / [Peer] file is parsed for you.
const client = new WireShade('/etc/wireguard/wg0.conf');
await client.start();

console.log('tunnel up as', client.config.wireguard.sourceIp);
await client.close();
```

### 3. 打开原始 TCP 连接

通过与 `net.Socket` 兼容的流与任意 TCP 服务（Redis、SMTP、游戏服务器……）通信。

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

### 4. 在 VPN 内部暴露 TCP 服务

在你的 VPN IP 上运行一个监听器，供其他对等端连接。

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

### 5. 本地端口转发（类似 `ssh -L`）

在本地端口访问远程 VPN 服务——例如 `localhost` 上的私有数据库。

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// localhost:5432 → 10.0.0.5:5432 inside the VPN.
await client.forwardLocal(5432, '10.0.0.5', 5432);
console.log('psql -h localhost -p 5432 now reaches the VPN database');
```

### 6. 远程端口转发（类似 `ssh -R`）

将本地服务发布到 VPN，让任何对等端都能访问，即使在 NAT 之后。

```javascript
const { WireShade } = require('wireshade');

const client = new WireShade('wg.conf');
await client.start();

// Publish your local :3000 to VPN peers at <your VPN IP>:8080.
await client.forwardRemote(8080, 'localhost', 3000);
console.log('local :3000 is now reachable across the VPN on :8080');
```

### 7. 通过隧道提供 Express/HTTP 应用

将隧道连接直接送入 Node HTTP 服务器——从不绑定公网端口。

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

### 8. 将主机名映射到 VPN IP（自定义 DNS）

为 VPN 主机使用易记的名称，无需改动 `/etc/hosts`。

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

### 9. 用 ICMP ping 对对等端做健康检查

测量到对等端的往返时间，并检测其何时失联。

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

### 10. 用 WebSocket/WSS 穿透防火墙

将整个隧道经由单个 `wss://` 端口（443）传输，以穿透仅允许 HTTP 的代理和严格的防火墙。

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

### 🍳 更多用法

另外七个经过实战检验的模式——延续上面十个的独立风格，编号顺延。

### 11. 无需改动，复用现有的数据库 / Redis 客户端

把远程端口转发到 `localhost`，再让现有驱动指向它——库本身无需任何改动。

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

### 12. 通过转发端口 SSH 登录 VPN 主机

把某个对端的 SSH 端口暴露到 `localhost`，用标准 `ssh` 客户端连接即可。

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

### 13. 两个对端之间的点对点 VPN——无需中心服务器

两个 WireShade 对端组成直连隧道：一个监听，另一个拨入。

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

### 14. 借助自动重连、事件和健康检查扛住断线

启用带退避的重连，并通过事件观察隧道的生命周期。

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

### 15. 在 CI / Serverless / 容器中运行——无需 root

无需 TUN 设备、无需权限，因此隧道能在内核级 VPN 无法运行的地方工作。

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

### 16. 明文 `ws://` 置于终止 TLS 的反向代理之后

让 nginx/Caddy 处理 TLS，WireShade 一侧保持明文。

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

### 17. 将整个 VPN 暴露为 SOCKS5 代理

运行一个本地 SOCKS5 代理，把每个连接都经由隧道转发——任何支持 SOCKS5 的应用随后都能访问 VPN 内部的任意主机，无需为每个服务单独做转发。

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

CLI 无需编写任何代码即可做到同样的事：`wireshade socks -c wg0.conf`。

---

## 📚 示例

可运行脚本位于 [`examples/`](examples/)：

| 文件 | 演示 |
| :--- | :--- |
| `01_quickstart.js` | 连接、请求与监听——「hello world」。 |
| `02_http_request.js` | 使用 `client.get()` 的简单 HTTP GET。 |
| `03_https_custom_dns.js` | 将自定义主机名映射到 VPN IP 的 HTTPS。 |
| `04_tcp_socket.js` | 经隧道的原始 TCP 收发。 |
| `05_internet_routing.js` | 经 VPN 网关路由公网流量。 |
| `06_simple_server.js` | 在隧道内托管 TCP/HTTP 服务器。 |
| `07_express_app.js` | 通过 VPN 暴露 Express 应用（反向隧道）。 |
| `08_local_forwarding.js` | `forwardLocal`——在 `localhost` 上访问 VPN 服务。 |
| `09_reconnect_config.js` | 重连、健康检查与事件监控。 |
| `10_remote_forwarding.js` | `forwardRemote`——把本地服务发布到 VPN。 |
| `11_websocket_wss.js` | 使用**原生**绑定的 WireGuard over WSS。 |
| `13_websocket_highlevel.js` | 使用**高层** API 的 WireGuard over WSS。 |
| `14_socks_proxy.js` | 经由隧道的 SOCKS5 代理。 |
| `local_vpn.js` | 两个本地对等体构成 P2P 隧道用于测试。 |

---

## 🎯 使用场景

*   **微服务：** 跨云连接服务，无需暴露公网端口。
*   **网页抓取：** 在不同 endpoint 上运行多个实例以轮换出口 IP。
*   **开发者访问：** 从笔记本安全地访问私有内部数据库。
*   **物联网与边缘：** 让位于严格 NAT 之后的设备回连到中央服务器。

---

## 📜 许可证

MIT 许可证。

*WireGuard 是 Jason A. Donenfeld 的注册商标。*
</content>
