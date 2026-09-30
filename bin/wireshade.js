#!/usr/bin/env node
'use strict';

const {
    WireShadeClient,
    readWireGuardConfig,
    generateKeyPair
} = require('../index.js');
const fs = require('fs');
const { spawn } = require('child_process');

// --- tiny arg parser (no external deps) -------------------------------------
function parseArgs(argv) {
    const opts = {};
    const alias = {
        c: 'config', t: 'transport', l: 'listen', v: 'verbose', h: 'help'
    };
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        if (a === '--') { opts['--'] = argv.slice(i + 1); break; } // verbatim passthrough
        if (!a.startsWith('-')) { (opts._ = opts._ || []).push(a); continue; }
        a = a.replace(/^--?/, '');
        if (alias[a]) a = alias[a];
        if (a === 'L' || a === 'R') { // repeatable port-forward specs
            const nv = argv[i + 1];
            if (nv !== undefined && !nv.startsWith('-')) { (opts[a] = opts[a] || []).push(nv); i++; }
            continue;
        }
        if (a === 'verbose' || a === 'help' || a === 'insecure'
            || a === 'set-system-proxy' || a === 'dry-run-proxy') { opts[a] = true; continue; }
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) { opts[a] = true; }
        else { opts[a] = next; i++; }
    }
    return opts;
}

function die(msg, code = 1) {
    console.error('error: ' + msg);
    process.exit(code);
}

const USAGE = `wireshade - userspace WireGuard for Node.js: SSH-style CLI + library
             (SOCKS5, port-forward, ssh) over UDP or WebSocket, no root needed

Usage:
  wireshade ssh     [options] [user@]host [-- cmd]   SSH to a host through the tunnel
  wireshade socks   [options]     Connect and expose a local SOCKS5 proxy
  wireshade forward [options]     Connect and forward ports (-L / -R, like ssh)
  wireshade bridge  [options]     WS(S) -> UDP relay to a real WireGuard server
  wireshade unset-proxy           Restore system proxy settings (crash recovery)
  wireshade genkey                Print a new WireGuard key pair
  wireshade version               Print version
  wireshade help                  Show this help

socks options:
  -c, --config <file>        WireGuard .conf file (Interface + Peer)
      --private-key <b64>    (if no --config) interface private key
      --peer-key <b64>       (if no --config) peer public key
      --psk <b64>            (optional) pre-shared key
      --endpoint <host:port> (if no --config) WireGuard UDP endpoint
      --source-ip <ip>       (if no --config) tunnel source IP, e.g. 10.0.0.2
      --keepalive <sec>      persistent keepalive (default 25)
      --tcp-buffer <size>    TCP window per connection (e.g. 4m); larger = better on high-latency links, more RAM

  -t, --transport <udp|ws|wss>   carrier transport (default: udp)
      --url <ws[s]://host:port>  WS server URL (required for ws/wss)
      --mode <native|wstunnel>   WS handshake; wstunnel = connect through a
                                 wireshade bridge / stock wstunnel server to
                                 the real WG server given by --endpoint
      --path-prefix <p>          WS upgrade path prefix (wstunnel: /<p>/events)
      --ca <file>                pin a PEM certificate (wss, self-signed)
      --insecure                 skip TLS verification (test only)

  -l, --listen <[host:]port>     local SOCKS5 bind (default: 127.0.0.1:1080)
      --auth <user:pass>         require SOCKS5 username/password
      --dns <ip>                 resolve hostnames via this DNS server through
                                 the tunnel (DNS-over-TCP; default: .conf DNS)
      --set-system-proxy         point the OS at this proxy (restored on exit)
      --proxy-method <pac|registry>  Windows method (default: pac = real SOCKS5)
      --chrome [url]             launch Chrome/Edge/Chromium via this proxy
                                 (isolated profile; closing it stops wireshade)
      --chrome-path <file>       browser executable (else auto-detected)
  -v, --verbose                  log each proxied connection

forward options (same connection flags as socks: -c/-t/--url/--ca/...):
  -L <localPort:remoteHost:remotePort>   forward a local port into the VPN (ssh -L)
  -R <vpnPort:targetHost:targetPort>     publish a local service into the VPN (ssh -R)
  (both flags are repeatable)

bridge options (a WS/WSS -> UDP relay; runs ON the VPS, next to a kernel WG server):
      --target <host:port>       the real UDP WireGuard server (e.g. 127.0.0.1:51820)  [required]
      --listen <[host:]port>     bind address (default 0.0.0.0:443 with --tls, else :8080)
      --tls <cert.pem:key.pem>   serve wss (omit for plaintext ws behind a reverse proxy)
      --path-prefix <p>          require the wstunnel upgrade path /<p>/events
      --timeout <sec>            idle relay timeout (default 120)

Notes:
  Reaching the public internet (not just the VPN range) requires the WireGuard
  server to be an exit node (IP forwarding + NAT). WireShade forwards any host;
  the exit IP is the server's.

Examples:
  wireshade socks -c wg0.conf
  wireshade socks -c wg0.conf -l 0.0.0.0:1080 --auth alice:secret
  wireshade socks -c wg0.conf -t wss --url wss://vpn.example.com:443 --ca server.pem
  wireshade socks -c wg0.conf --chrome https://example.internal
  wireshade socks -c wg0.conf --set-system-proxy
  wireshade forward -c wg0.conf -L 8080:10.0.0.5:80
  wireshade forward -c wg0.conf -R 2222:127.0.0.1:22 -L 5432:10.0.0.9:5432
  wireshade ssh -c wg0.conf admin@10.0.0.9
  wireshade ssh -c wg0.conf -t wss --url wss://vpn.example.com:443 admin@10.0.0.9 -- uptime
  wireshade bridge --target 127.0.0.1:51820 --tls fullchain.pem:privkey.pem --path-prefix v1
`;

// Parse a byte size: a plain integer (bytes) or a k/m suffix (e.g. 4m, 512k,
// 1048576). Returns a positive integer number of bytes, or dies on garbage.
function parseSize(v) {
    const s = String(v).trim().toLowerCase();
    const m = s.match(/^(\d+)([km]?)$/);
    if (!m) die(`invalid --tcp-buffer "${v}" (use bytes, or a k/m suffix, e.g. 4m)`);
    let n = parseInt(m[1], 10);
    if (m[2] === 'k') n *= 1024;
    else if (m[2] === 'm') n *= 1024 * 1024;
    if (!Number.isInteger(n) || n <= 0) die(`invalid --tcp-buffer "${v}"`);
    return n;
}

function parseListen(v) {
    if (!v) return { host: '127.0.0.1', port: 1080 };
    const s = String(v);
    const idx = s.lastIndexOf(':');
    if (idx === -1) return { host: '127.0.0.1', port: parseInt(s, 10) };
    return { host: s.slice(0, idx) || '127.0.0.1', port: parseInt(s.slice(idx + 1), 10) };
}

function buildConfig(o) {
    let wireguard;
    if (o.config) {
        wireguard = readWireGuardConfig(o.config);
    } else {
        for (const req of ['private-key', 'peer-key', 'source-ip']) {
            if (!o[req]) die(`--${req} is required when no --config is given`);
        }
        if ((o.transport || 'udp') === 'udp' && !o.endpoint) {
            die('--endpoint is required for the udp transport when no --config is given');
        }
        wireguard = {
            privateKey: o['private-key'],
            peerPublicKey: o['peer-key'],
            presharedKey: o.psk,
            endpoint: o.endpoint,
            sourceIp: o['source-ip']
        };
    }
    if (o.keepalive != null && o.keepalive !== true) {
        wireguard.persistentKeepalive = parseInt(o.keepalive, 10);
    }

    const config = { wireguard, logging: !!o.verbose };

    // Optional per-connection TCP window (bytes). Goes on the transport for
    // ws/wss and directly on the config for udp (see WireShadeClient._buildGw).
    const tcpBufferSize = (o['tcp-buffer'] != null && o['tcp-buffer'] !== true)
        ? parseSize(o['tcp-buffer']) : undefined;

    const transport = (o.transport || 'udp').toLowerCase();
    if (transport === 'ws' || transport === 'wss') {
        if (!o.url) die(`--url is required for the ${transport} transport`);
        const tls = {};
        if (o.ca) tls.ca = fs.readFileSync(o.ca, 'utf8');
        if (o.insecure) tls.insecureSkipVerify = true;
        config.transport = {
            type: 'websocket',
            url: o.url,
            pathPrefix: o['path-prefix'],
            mode: (o.mode && o.mode !== true) ? String(o.mode).toLowerCase() : undefined,
            tls: Object.keys(tls).length ? tls : undefined,
            tcpBufferSize
        };
    } else if (transport !== 'udp') {
        die(`unknown transport "${transport}" (use udp, ws or wss)`);
    } else if (tcpBufferSize !== undefined) {
        config.tcpBufferSize = tcpBufferSize;
    }
    return config;
}

async function cmdSocks(o) {
    const config = buildConfig(o);
    const { host, port } = parseListen(o.listen);
    if (!Number.isInteger(port) || port <= 0) die(`invalid --listen port`);

    let auth = null;
    if (o.auth && o.auth !== true) {
        const i = String(o.auth).indexOf(':');
        if (i === -1) die('--auth must be user:pass');
        auth = { username: o.auth.slice(0, i), password: o.auth.slice(i + 1) };
    }

    const client = new WireShadeClient(config);
    const label = config.transport ? `${config.transport.type} (${config.transport.url})`
                                   : `udp (${config.wireguard.endpoint})`;
    process.stderr.write(`wireshade: connecting via ${label} ...\n`);
    await client.start();
    process.stderr.write(`wireshade: tunnel up (source ${config.wireguard.sourceIp})\n`);

    // DNS through the tunnel: --dns <ip>, else the .conf's DNS = ... (if any).
    const dns = (o.dns && o.dns !== true) ? o.dns
        : (config.wireguard && config.wireguard.dns) || null;

    const srv = await client.socks(port, host, { auth, dns, logging: !!o.verbose });
    process.stderr.write(`wireshade: SOCKS5 proxy listening on ${host}:${port}`
        + (auth ? ' (auth required)' : '') + (dns ? ` (DNS via ${dns} in-tunnel)` : '') + '\n');
    process.stderr.write(`wireshade: e.g. curl --socks5-hostname ${host}:${port} http://<vpn-host>/\n`);

    // The address a system proxy / browser should point at (loopback if bound to any).
    const advHost = (host === '0.0.0.0' || host === '::') ? '127.0.0.1' : host;
    const plog = (m) => process.stderr.write('wireshade: ' + m + '\n');

    let restoreProxy = null;
    if (o['set-system-proxy']) {
        const { setSystemProxy, unsetSystemProxy } = require('../lib/system_proxy');
        const method = (o['proxy-method'] || 'pac').toLowerCase();
        const dryRun = !!o['dry-run-proxy'];
        setSystemProxy({ host: advHost, port, method, dryRun, log: plog });
        restoreProxy = () => { try { unsetSystemProxy({ dryRun, log: plog }); } catch { /* ignore */ } };
        plog('system proxy set (will be restored on exit)');
    }

    let closing = false;
    const shutdown = () => {
        if (closing) return;
        closing = true;
        process.stderr.write('\nwireshade: shutting down ...\n');
        if (restoreProxy) restoreProxy();          // synchronous (spawnSync) — runs before exit
        try { srv.close(); } catch { /* ignore */ }
        Promise.resolve(client.close()).finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    if (o.chrome) {
        const { launchBrowser } = require('../lib/launch_browser');
        const startUrl = (typeof o.chrome === 'string') ? o.chrome : undefined;
        try {
            const { child } = launchBrowser({
                host: advHost, port, url: startUrl, browserPath: o['chrome-path'], log: plog
            });
            if (child) child.on('exit', () => { plog('browser closed'); shutdown(); });
        } catch (e) {
            plog('could not launch browser: ' + e.message);
        }
    }
}

async function cmdSsh(o) {
    const target = (o._ || [])[0];
    if (!target) die('usage: wireshade ssh [connection flags] [user@]host [-- remote command]');
    const at = target.indexOf('@');
    const user = at >= 0 ? target.slice(0, at) : null;
    const host = at >= 0 ? target.slice(at + 1) : target;
    const remotePort = (o.port && o.port !== true) ? parseInt(o.port, 10) : 22;

    const config = buildConfig(o);
    config.logging = false;
    const client = new WireShadeClient(config);
    process.stderr.write(`wireshade: connecting ...\n`);
    await client.start();

    // Forward an ephemeral local port to host:22 through the tunnel, then run ssh to it.
    const server = await client.forwardLocal(0, host, remotePort);
    const lp = server.address().port;
    process.stderr.write(`wireshade: ssh -> ${host}:${remotePort} through the tunnel (localhost:${lp})\n`);

    const sshBin = process.env.WIRESHADE_SSH_BIN || 'ssh';
    const sshTarget = user ? `${user}@127.0.0.1` : '127.0.0.1';
    const args = [
        '-p', String(lp),
        // Purpose-built option for localhost port-forwards: don't manage/pollute
        // known_hosts for the loopback address. The tunnel provides the crypto.
        '-o', 'NoHostAuthenticationForLocalhost=yes',
        sshTarget,
        ...(o['--'] || [])
    ];

    const child = spawn(sshBin, args, { stdio: 'inherit' });
    const finish = (code) => { Promise.resolve(client.close()).finally(() => process.exit(code || 0)); };
    child.on('exit', (code) => finish(code));
    child.on('error', (e) => { process.stderr.write('wireshade: could not launch ssh: ' + e.message + '\n'); finish(1); });
}

function parseForward(spec) {
    const parts = String(spec).split(':');
    if (parts.length !== 3) die(`invalid forward spec "${spec}" (expected port:host:port)`);
    return [parseInt(parts[0], 10), parts[1], parseInt(parts[2], 10)];
}

async function cmdForward(o) {
    const Ls = [].concat(o.L || []);
    const Rs = [].concat(o.R || []);
    if (!Ls.length && !Rs.length) die('forward needs at least one -L or -R spec');

    const config = buildConfig(o);
    const client = new WireShadeClient(config);
    const label = config.transport ? `${config.transport.type} (${config.transport.url})`
                                    : `udp (${config.wireguard.endpoint})`;
    process.stderr.write(`wireshade: connecting via ${label} ...\n`);
    await client.start();
    process.stderr.write(`wireshade: tunnel up (source ${config.wireguard.sourceIp})\n`);

    for (const spec of Ls) {
        const [lp, rh, rp] = parseForward(spec);          // localPort:remoteHost:remotePort
        await client.forwardLocal(lp, rh, rp);
        process.stderr.write(`wireshade: -L localhost:${lp} -> ${rh}:${rp} (through tunnel)\n`);
    }
    for (const spec of Rs) {
        const [vp, th, tp] = parseForward(spec);          // vpnPort:targetHost:targetPort
        await client.forwardRemote(vp, th, tp);
        process.stderr.write(`wireshade: -R vpn:${vp} -> ${th}:${tp} (local)\n`);
    }

    let closing = false;
    const shutdown = () => {
        if (closing) return;
        closing = true;
        process.stderr.write('\nwireshade: shutting down ...\n');
        Promise.resolve(client.close()).finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

async function cmdBridge(o) {
    if (!o.target || o.target === true) die('bridge needs --target <host:port> (e.g. the kernel WireGuard server)');
    const listen = (o.listen && o.listen !== true) ? o.listen : (o.tls ? '0.0.0.0:443' : '0.0.0.0:8080');

    let tls = null;
    if (o.tls && o.tls !== true) {
        const i = String(o.tls).indexOf(':');
        if (i === -1) die('--tls must be cert.pem:key.pem');
        tls = { cert: fs.readFileSync(o.tls.slice(0, i), 'utf8'), key: fs.readFileSync(o.tls.slice(i + 1), 'utf8') };
    }

    const { WireShadeBridge } = require('../lib/bridge');
    const bridge = new WireShadeBridge({
        target: o.target,
        pathPrefix: (o['path-prefix'] && o['path-prefix'] !== true) ? o['path-prefix'] : undefined,
        tls,
        idleTimeoutSec: (o.timeout && o.timeout !== true) ? parseInt(o.timeout, 10) : undefined,
        logging: !!o.verbose
    });

    await bridge.listen(listen);
    process.stderr.write(`wireshade: bridge on ${tls ? 'wss' : 'ws'} ${listen} -> udp ${o.target}\n`);
    process.stderr.write(`wireshade: point a wstunnel client / WireShade WS client at it; datagrams go to ${o.target}\n`);

    let closing = false;
    const shutdown = () => {
        if (closing) return;
        closing = true;
        process.stderr.write('\nwireshade: shutting down bridge ...\n');
        bridge.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

async function cmdUnsetProxy(o) {
    const { unsetSystemProxy } = require('../lib/system_proxy');
    const ok = unsetSystemProxy({ dryRun: !!o['dry-run-proxy'], log: (m) => process.stderr.write('wireshade: ' + m + '\n') });
    if (!ok) process.stderr.write('wireshade: nothing to restore\n');
}

async function main() {
    const [, , cmd, ...rest] = process.argv;
    const o = parseArgs(rest);

    if (!cmd || cmd === 'help' || o.help) { process.stdout.write(USAGE); return; }

    switch (cmd) {
        case 'socks':
            await cmdSocks(o);
            break;
        case 'forward':
            await cmdForward(o);
            break;
        case 'ssh':
            await cmdSsh(o);
            break;
        case 'bridge':
            await cmdBridge(o);
            break;
        case 'unset-proxy':
            await cmdUnsetProxy(o);
            break;
        case 'genkey': {
            const k = generateKeyPair();
            process.stdout.write(`PrivateKey = ${k.privateKey}\nPublicKey  = ${k.publicKey}\n`);
            break;
        }
        case 'version': {
            const pkg = require('../package.json');
            process.stdout.write(`${pkg.name} ${pkg.version}\n`);
            break;
        }
        default:
            die(`unknown command "${cmd}" (try: wireshade help)`);
    }
}

main().catch((err) => die(err && err.message ? err.message : String(err)));
