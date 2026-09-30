'use strict';

/*
 * Best-effort system SOCKS proxy configuration for the `wireshade` CLI.
 *
 * setSystemProxy() saves the previous settings (to a state file for crash
 * recovery) and applies the SOCKS proxy; unsetSystemProxy() restores them.
 * Platform-specific and inherently limited — see notes per platform.
 *
 * Windows : PAC file + AutoConfigURL (real SOCKS5), or ProxyServer="socks=.."
 *           (method 'registry', treated as SOCKS4 by browsers). HKCU only,
 *           no admin needed; WinINET is refreshed via InternetSetOption.
 * macOS   : networksetup -setsocksfirewallproxy on every enabled service.
 * Linux   : GNOME via gsettings (GNOME apps only); otherwise just prints an
 *           ALL_PROXY hint (no reliable system-wide switch exists).
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const STATE_FILE = path.join(os.homedir() || os.tmpdir(), '.wireshade-proxy-state.json');
const WIN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function makeRun(dryRun, log) {
    return function run(cmd, args) {
        if (dryRun) {
            log(`[dry-run] ${cmd} ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
            return { status: 0, stdout: '', stderr: '' };
        }
        const r = spawnSync(cmd, args, { encoding: 'utf8' });
        return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
    };
}

function saveState(state, dryRun) {
    if (dryRun) return;
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* ignore */ }
}
function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function clearState() {
    try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
}

// --- Windows ---------------------------------------------------------------
function winRefresh(run) {
    // Notify WinINET so the change takes effect without a reboot.
    const ps = [
        '$s=\'[DllImport("wininet.dll",SetLastError=true)]public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);\';',
        '$t=Add-Type -MemberDefinition $s -Name WSInet -Namespace WS -PassThru;',
        '[void]$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0);', // SETTINGS_CHANGED
        '[void]$t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0);'  // REFRESH
    ].join('');
    run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
}

function winQuery(run, name) {
    const r = run('reg', ['query', WIN_KEY, '/v', name]);
    if (r.status !== 0) return null;
    // line: "    <name>    REG_SZ    <value>"  or REG_DWORD 0x1
    const m = r.stdout.split(/\r?\n/).map(l => l.trim())
        .find(l => l.toLowerCase().startsWith(name.toLowerCase()));
    if (!m) return null;
    const parts = m.split(/\s{2,}|\t+/);
    return { type: parts[1], value: parts.slice(2).join(' ') };
}

function winSet(run, name, type, value) {
    run('reg', ['add', WIN_KEY, '/v', name, '/t', type, '/d', value, '/f']);
}
function winDelete(run, name) {
    run('reg', ['delete', WIN_KEY, '/v', name, '/f']);
}

function setWindows(run, { host, port, method, dryRun, log }) {
    const prior = {
        ProxyEnable: winQuery(run, 'ProxyEnable'),
        ProxyServer: winQuery(run, 'ProxyServer'),
        AutoConfigURL: winQuery(run, 'AutoConfigURL')
    };
    const state = { platform: 'win32', method, prior };

    if (method === 'registry') {
        winSet(run, 'ProxyEnable', 'REG_DWORD', '1');
        winSet(run, 'ProxyServer', 'REG_SZ', `socks=${host}:${port}`);
        log(`system proxy set (registry): socks=${host}:${port}`);
        log('note: Windows Internet Options SOCKS is SOCKS4-oriented; some apps may not do SOCKS5.');
    } else {
        // PAC (default) — real SOCKS5 for PAC-aware browsers.
        const pacFile = path.join(os.tmpdir(), 'wireshade-proxy.pac');
        const pacContent = `function FindProxyForURL(url, host) { return "SOCKS5 ${host}:${port}; SOCKS ${host}:${port}; DIRECT"; }`;
        if (!dryRun) { try { fs.writeFileSync(pacFile, pacContent); } catch (e) { /* fall through */ } }
        else log(`[dry-run] write PAC ${pacFile}: ${pacContent}`);
        const url = 'file:///' + pacFile.replace(/\\/g, '/');
        winSet(run, 'AutoConfigURL', 'REG_SZ', url);
        state.pacFile = pacFile;
        log(`system proxy set (PAC): ${url}`);
    }
    winRefresh(run);
    return state;
}

function restoreWindows(run, state, log) {
    const prior = state.prior || {};
    const restore = (name, saved) => {
        if (saved && saved.value != null) winSet(run, name, saved.type, saved.value);
        else winDelete(run, name);
    };
    if (state.method === 'registry') {
        restore('ProxyEnable', prior.ProxyEnable);
        restore('ProxyServer', prior.ProxyServer);
    } else {
        restore('AutoConfigURL', prior.AutoConfigURL);
        if (state.pacFile) { try { fs.unlinkSync(state.pacFile); } catch { /* ignore */ } }
    }
    winRefresh(run);
    log('system proxy restored (windows)');
}

// --- macOS -----------------------------------------------------------------
function macServices(run) {
    const r = run('networksetup', ['-listallnetworkservices']);
    if (r.status !== 0) return [];
    return r.stdout.split(/\r?\n/).slice(1)                 // drop header line
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('*'));              // '*' = disabled
}
function macGetSocks(run, svc) {
    const r = run('networksetup', ['-getsocksfirewallproxy', svc]);
    const out = r.stdout || '';
    const get = (k) => (out.match(new RegExp(k + ':\\s*(.+)')) || [])[1]?.trim();
    return { enabled: (get('Enabled') || '').toLowerCase() === 'yes', server: get('Server'), port: get('Port') };
}
function setMac(run, { host, port, dryRun, log }) {
    const services = dryRun ? ['Wi-Fi'] : macServices(run);
    const touched = [];
    for (const svc of services) {
        const prior = dryRun ? { enabled: false } : macGetSocks(run, svc);
        run('networksetup', ['-setsocksfirewallproxy', svc, host, String(port)]);
        run('networksetup', ['-setsocksfirewallproxystate', svc, 'on']);
        touched.push({ name: svc, prior });
        log(`system proxy set on "${svc}": ${host}:${port}`);
    }
    return { platform: 'darwin', services: touched };
}
function restoreMac(run, state, log) {
    for (const s of state.services || []) {
        if (s.prior && s.prior.enabled && s.prior.server) {
            run('networksetup', ['-setsocksfirewallproxy', s.name, s.prior.server, String(s.prior.port || 0)]);
            run('networksetup', ['-setsocksfirewallproxystate', s.name, 'on']);
        } else {
            run('networksetup', ['-setsocksfirewallproxystate', s.name, 'off']);
        }
        log(`system proxy restored on "${s.name}"`);
    }
}

// --- Linux (GNOME) ---------------------------------------------------------
function hasGsettings(run) {
    const r = run('gsettings', ['--version']);
    return r.status === 0;
}
function gGet(run, schema, key) {
    const r = run('gsettings', ['get', schema, key]);
    return r.status === 0 ? (r.stdout || '').trim() : null;
}
function setLinux(run, { host, port, dryRun, log }) {
    if (!dryRun && !hasGsettings(run)) {
        log('no gsettings (non-GNOME): set it yourself, e.g.');
        log(`  export ALL_PROXY=socks5h://${host}:${port}`);
        return { platform: 'linux', gnome: false };
    }
    const prior = {
        mode: gGet(run, 'org.gnome.system.proxy', 'mode'),
        host: gGet(run, 'org.gnome.system.proxy.socks', 'host'),
        port: gGet(run, 'org.gnome.system.proxy.socks', 'port')
    };
    run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'host', host]);
    run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'port', String(port)]);
    run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'manual']);
    log(`system proxy set (GNOME): socks ${host}:${port}`);
    log(`tip for terminals: export ALL_PROXY=socks5h://${host}:${port}`);
    return { platform: 'linux', gnome: true, prior };
}
function restoreLinux(run, state, log) {
    if (!state.gnome) return;
    const p = state.prior || {};
    if (p.host != null) run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'host', stripQuotes(p.host)]);
    if (p.port != null) run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'port', stripQuotes(p.port)]);
    if (p.mode != null) run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', stripQuotes(p.mode)]);
    log('system proxy restored (GNOME)');
}
function stripQuotes(s) { return String(s).replace(/^'(.*)'$/, '$1'); }

// --- public API ------------------------------------------------------------
function setSystemProxy({ host = '127.0.0.1', port, method = 'pac', dryRun = false, log = () => {} }) {
    const run = makeRun(dryRun, log);
    // If a stale state exists (previous run didn't clean up), restore it first
    // so we never save an already-proxied config as the "original".
    const stale = loadState();
    if (stale && !dryRun) {
        log('found leftover proxy state from a previous run — restoring it first');
        try { restoreBy(run, stale, log); } catch { /* ignore */ }
        clearState();
    }

    let state;
    if (process.platform === 'win32') state = setWindows(run, { host, port, method, dryRun, log });
    else if (process.platform === 'darwin') state = setMac(run, { host, port, dryRun, log });
    else state = setLinux(run, { host, port, dryRun, log });

    saveState(state, dryRun);
    return state;
}

function restoreBy(run, state, log) {
    if (!state) return;
    if (state.platform === 'win32') restoreWindows(run, state, log);
    else if (state.platform === 'darwin') restoreMac(run, state, log);
    else restoreLinux(run, state, log);
}

function unsetSystemProxy({ dryRun = false, log = () => {}, state } = {}) {
    const run = makeRun(dryRun, log);
    const st = state || loadState();
    if (!st) { log('no saved system-proxy state to restore'); return false; }
    restoreBy(run, st, log);
    if (!dryRun) clearState();
    return true;
}

module.exports = { setSystemProxy, unsetSystemProxy, STATE_FILE };
