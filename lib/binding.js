'use strict';

/**
 * Loads the native WireShade binding for the current platform.
 *
 * Binary names follow the napi-rs convention produced by the publish workflow:
 *   wireshade.<platform>-<arch>[-<abi>].node
 * for the targets configured in package.json (napi.targets). A plain
 * `wireshade.node` (e.g. a local debug build) is used as fallback.
 *
 * `WIRESHADE_NATIVE_PATH` may point to a specific binding file and takes
 * precedence over everything else (useful for custom builds and testing).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function isMusl() {
    if (process.platform !== 'linux') return false;
    try {
        const report = typeof process.report?.getReport === 'function' ? process.report.getReport() : null;
        const header = report && (typeof report === 'string' ? JSON.parse(report).header : report.header);
        if (header) return !header.glibcVersionRuntime;
    } catch (_) { /* fall through */ }
    try {
        return fs.readFileSync('/usr/bin/ldd', 'utf8').includes('musl');
    } catch (_) {
        return false;
    }
}

/**
 * Platform triples (napi-rs naming) to try for the current process, most specific first.
 * @returns {string[]}
 */
function platformTriples(platform = process.platform, arch = process.arch) {
    switch (`${platform}-${arch}`) {
        case 'win32-x64': return ['win32-x64-msvc'];
        case 'darwin-x64': return ['darwin-x64', 'darwin-universal'];
        case 'darwin-arm64': return ['darwin-arm64', 'darwin-universal'];
        case 'linux-x64': return isMusl() ? ['linux-x64-musl', 'linux-x64-gnu'] : ['linux-x64-gnu', 'linux-x64-musl'];
        case 'linux-arm64': return isMusl() ? ['linux-arm64-musl', 'linux-arm64-gnu'] : ['linux-arm64-gnu', 'linux-arm64-musl'];
        case 'linux-arm': return ['linux-arm-gnueabihf'];
        default: return [];
    }
}

function candidateFiles() {
    const files = [];
    if (process.env.WIRESHADE_NATIVE_PATH) {
        files.push(path.resolve(process.env.WIRESHADE_NATIVE_PATH));
    }
    for (const triple of platformTriples()) {
        files.push(path.join(ROOT, `wireshade.${triple}.node`));
    }
    files.push(path.join(ROOT, 'wireshade.node'));
    return files;
}

function loadBinding() {
    const tried = [];
    for (const file of candidateFiles()) {
        if (!fs.existsSync(file)) {
            tried.push(`  - ${file} (not found)`);
            continue;
        }
        try {
            return require(file);
        } catch (err) {
            tried.push(`  - ${file} (failed to load: ${err.message})`);
        }
    }

    const triples = platformTriples();
    const supported = triples.length > 0
        ? `Expected a prebuilt binary for ${triples.join(' / ')}.`
        : `No prebuilt binary is published for ${process.platform}-${process.arch}.`;

    throw new Error(
        `WireShade: could not load the native binding for ${process.platform}-${process.arch} ` +
        `(node ${process.version}). ${supported}\n` +
        `Tried:\n${tried.join('\n')}\n` +
        `Build it locally with "npm run build" (requires a Rust toolchain) ` +
        `or set WIRESHADE_NATIVE_PATH to a compiled wireshade .node file.`
    );
}

let cached = null;

/** @returns {{ WireShade: Function }} the native module (loaded once, cached). */
function getBinding() {
    if (!cached) cached = loadBinding();
    return cached;
}

/**
 * Generate a self-signed certificate (+ key), PEM-encoded, for the given
 * subject alternative names. Thin re-export of the native helper so callers can
 * do `require('wireshade').generateSelfSignedCert([...])` for `wss` dev/test
 * setups without OpenSSL.
 * @param {string[]} subjectAltNames
 * @returns {{ certPem: string, keyPem: string }}
 */
function generateSelfSignedCert(subjectAltNames) {
    const binding = getBinding();
    if (typeof binding.generateSelfSignedCert !== 'function') {
        throw new Error('generateSelfSignedCert is not available in this native binding');
    }
    return binding.generateSelfSignedCert(subjectAltNames);
}

module.exports = { getBinding, platformTriples, generateSelfSignedCert };
