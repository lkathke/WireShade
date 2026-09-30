'use strict';

/*
 * Launch a Chromium-based browser pointed at a SOCKS5 proxy, using a throwaway
 * profile so the proxy flag actually takes effect and the user's main profile
 * is untouched. No system-wide proxy change needed.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function existing(paths) {
    for (const p of paths) { try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ } }
    return null;
}

/** Best-effort discovery of a Chromium-based browser. Honors $CHROME_PATH. */
function findBrowser() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

    if (process.platform === 'win32') {
        const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
        const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
        const local = process.env['LOCALAPPDATA'] || '';
        return existing([
            path.join(pf, 'Google/Chrome/Application/chrome.exe'),
            path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
            local && path.join(local, 'Google/Chrome/Application/chrome.exe'),
            path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
            path.join(pf86, 'Microsoft/Edge/Application/msedge.exe')
        ]);
    }
    if (process.platform === 'darwin') {
        return existing([
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
        ]);
    }
    // Linux: look up common names in PATH.
    const { spawnSync } = require('child_process');
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge']) {
        const r = spawnSync('which', [bin], { encoding: 'utf8' });
        if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    }
    return null;
}

/**
 * Launch the browser with a SOCKS5 proxy and an isolated profile.
 * @returns {{ child: import('child_process').ChildProcess, browserPath: string, profileDir: string, args: string[] }}
 */
function launchBrowser({ host = '127.0.0.1', port, url, browserPath, dryRun = false, log = () => {} }) {
    const bin = browserPath || findBrowser();
    if (!bin) {
        throw new Error('no Chromium-based browser found (set CHROME_PATH to the executable)');
    }
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wireshade-chrome-'));
    const args = [
        `--proxy-server=socks5://${host}:${port}`,
        // keep localhost direct so the proxy's own admin/loopback isn't tunneled
        `--proxy-bypass-list=<-loopback>`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check'
    ];
    if (url) args.push(url);

    if (dryRun) {
        log(`[dry-run] "${bin}" ${args.join(' ')}`);
        return { child: null, browserPath: bin, profileDir, args };
    }

    log(`launching browser via SOCKS5 ${host}:${port}`);
    const child = spawn(bin, args, { stdio: 'ignore', detached: false });
    return { child, browserPath: bin, profileDir, args };
}

module.exports = { findBrowser, launchBrowser };
