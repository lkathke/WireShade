'use strict';

/*
 * Minimal DNS-over-TCP resolver that runs THROUGH the WireShade tunnel.
 *
 * WireShade tunnels TCP (and ICMP) but not UDP, so DNS is queried over TCP
 * (RFC 1035 §4.2.2: 2-byte length prefix) to a resolver reachable inside the
 * VPN. This keeps name resolution inside the tunnel (no DNS leak, internal
 * names resolve) when the SOCKS proxy is asked for a hostname.
 */

function encodeName(name) {
    const parts = name.replace(/\.$/, '').split('.');
    const bufs = [];
    for (const p of parts) {
        const b = Buffer.from(p, 'ascii');
        if (b.length === 0 || b.length > 63) throw new Error('invalid DNS label');
        bufs.push(Buffer.from([b.length]), b);
    }
    bufs.push(Buffer.from([0]));
    return Buffer.concat(bufs);
}

function buildQuery(name, id) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x0100, 2); // RD (recursion desired)
    header.writeUInt16BE(1, 4);      // QDCOUNT
    const q = Buffer.concat([encodeName(name), Buffer.from([0x00, 0x01, 0x00, 0x01])]); // A / IN
    return Buffer.concat([header, q]);
}

// Skip a (possibly compressed) name starting at offset; return new offset.
function skipName(buf, off) {
    while (off < buf.length) {
        const len = buf[off];
        if (len === 0) return off + 1;
        if ((len & 0xc0) === 0xc0) return off + 2; // compression pointer ends the name
        off += 1 + len;
    }
    return off;
}

function parseAnswers(buf) {
    if (buf.length < 12) return [];
    const qd = buf.readUInt16BE(4);
    const an = buf.readUInt16BE(6);
    let off = 12;
    for (let i = 0; i < qd; i++) { off = skipName(buf, off); off += 4; } // QNAME + QTYPE + QCLASS
    const ips = [];
    for (let i = 0; i < an && off + 10 <= buf.length; i++) {
        off = skipName(buf, off);
        const type = buf.readUInt16BE(off);
        const rdlen = buf.readUInt16BE(off + 8);
        const rdata = off + 10;
        if (type === 1 && rdlen === 4 && rdata + 4 <= buf.length) {
            ips.push(`${buf[rdata]}.${buf[rdata + 1]}.${buf[rdata + 2]}.${buf[rdata + 3]}`);
        }
        off = rdata + rdlen;
    }
    return ips;
}

/**
 * Resolve a hostname's A record through the tunnel.
 * @param {WireShadeClient} client
 * @param {string} dnsServerIp - a resolver reachable inside the VPN
 * @param {string} hostname
 * @param {Object} [opts] - { port=53, timeout=5000 }
 * @returns {Promise<string>} the first IPv4 address
 */
function resolveA(client, dnsServerIp, hostname, opts = {}) {
    const port = opts.port || 53;
    const timeout = opts.timeout || 5000;
    const id = Math.floor(Math.random() * 0xffff);
    const query = buildQuery(hostname, id);
    const framed = Buffer.concat([Buffer.from([(query.length >> 8) & 0xff, query.length & 0xff]), query]);

    return new Promise((resolve, reject) => {
        let sock;
        let done = false;
        let acc = Buffer.alloc(0);
        let expected = null;

        const finish = (err, ip) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { if (sock) sock.destroy(); } catch { /* ignore */ }
            if (err) reject(err); else resolve(ip);
        };

        const timer = setTimeout(() => finish(new Error(`DNS timeout resolving ${hostname}`)), timeout);

        try {
            sock = client.connect({ host: dnsServerIp, port });
        } catch (e) { return finish(e); }

        sock.on('connect', () => sock.write(framed));
        sock.on('error', (e) => finish(e));
        sock.on('close', () => { if (!done) finish(new Error(`DNS connection closed resolving ${hostname}`)); });
        sock.on('data', (chunk) => {
            acc = Buffer.concat([acc, chunk]);
            if (expected === null && acc.length >= 2) { expected = acc.readUInt16BE(0); acc = acc.subarray(2); }
            if (expected !== null && acc.length >= expected) {
                const ips = parseAnswers(acc.subarray(0, expected));
                if (ips.length) finish(null, ips[0]);
                else finish(new Error(`no A record for ${hostname}`));
            }
        });
    });
}

module.exports = { resolveA, buildQuery, parseAnswers };
