#!/usr/bin/env node
'use strict';

const {
    WireShadeClient,
    readWireGuardConfig,
    generateKeyPair
} = require('../index.js');
const fs = require('fs');

// --- tiny arg parser (no external deps) -------------------------------------
function parseArgs(argv) {
    const opts = {};
    const alias = {
        c: 'config', t: 'transport', l: 'listen', v: 'verbose', h: 'help'
    };
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        if (!a.startsWith('-')) { (opts._ = opts._ || []).push(a); continue; }
        a = a.replace(/^--?/, '');
        if (alias[a]) a = alias[a];
        if (a === 'verbose' || a === 'help' || a === 'insecure') { opts[a] = true; continue; }
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

const USAGE = `wireshade - userspace WireGuard tunnel & SOCKS5 proxy

Usage:
  wireshade socks   [options]     Connect and expose a local SOCKS5 proxy
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

  -t, --transport <udp|ws|wss>   carrier transport (default: udp)
      --url <ws[s]://host:port>  WS server URL (required for ws/wss)
      --path-prefix <p>          WS upgrade path prefix
      --ca <file>                pin a PEM certificate (wss, self-signed)
      --insecure                 skip TLS verification (test only)

  -l, --listen <[host:]port>     local SOCKS5 bind (default: 127.0.0.1:1080)
      --auth <user:pass>         require SOCKS5 username/password
  -v, --verbose                  log each proxied connection

Examples:
  wireshade socks -c wg0.conf
  wireshade socks -c wg0.conf -l 0.0.0.0:1080 --auth alice:secret
  wireshade socks -c wg0.conf -t wss --url wss://vpn.example.com:443 --ca server.pem
`;

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
            tls: Object.keys(tls).length ? tls : undefined
        };
    } else if (transport !== 'udp') {
        die(`unknown transport "${transport}" (use udp, ws or wss)`);
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

    const srv = await client.socks(port, host, { auth, logging: !!o.verbose });
    process.stderr.write(`wireshade: SOCKS5 proxy listening on ${host}:${port}`
        + (auth ? ' (auth required)' : '') + '\n');
    process.stderr.write(`wireshade: e.g. curl --socks5-hostname ${host}:${port} http://<vpn-host>/\n`);

    let closing = false;
    const shutdown = () => {
        if (closing) return;
        closing = true;
        process.stderr.write('\nwireshade: shutting down ...\n');
        try { srv.close(); } catch { /* ignore */ }
        Promise.resolve(client.close()).finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

async function main() {
    const [, , cmd, ...rest] = process.argv;
    const o = parseArgs(rest);

    if (!cmd || cmd === 'help' || o.help) { process.stdout.write(USAGE); return; }

    switch (cmd) {
        case 'socks':
            await cmdSocks(o);
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
