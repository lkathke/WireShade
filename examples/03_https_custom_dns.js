const { WireShade } = require('../index');
const path = require('path');

/**
 * Example: HTTPS Request with Custom DNS
 * Demonstrates simplified configuration for hosts.
 */

async function exampleHttps() {
    const log = (msg) => console.log(`[WireShade HTTPS] ${msg}`);

    // Config + Options (Hosts)
    const gw = new WireShade(path.join(__dirname, 'wireguard.conf'), {
        hosts: {
            'internal.service.lan': '10.0.0.5'
        }
    });

    gw.on('connect', async () => {
        const target = 'https://internal.service.lan/';
        log(`VPN Connected. Fetching ${target}...`);

        // Method 1: Simplified API (gw.get)
        // const body = await gw.get(target);

        // Method 2: Native-like API (gw.https.get) using host mapping
        log("Using gw.https.get() with Host Mapping...");

        const req = gw.https.get(target, (res) => {
            log(`Status: ${res.statusCode}`);
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                log(`Response received!`);
                console.log(data.substring(0, 100));
                process.exit(0);
            });
        });

        req.on('error', (err) => {
            console.error("HTTPS Request Failed:", err);
            process.exit(1);
        });

    });

    gw.start().catch(console.error);
}

exampleHttps();
