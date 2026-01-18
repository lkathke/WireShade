const { WireShade } = require('../index');
const path = require('path');

/**
 * Example: Simple HTTP Request
 * Demonstrates the simplified get() API.
 */

async function exampleHttp() {
    const log = (msg) => console.log(`[WireShade HTTP] ${msg}`);

    const gw = new WireShade(path.join(__dirname, 'wireguard.conf'));

    gw.on('connect', async () => {
        const target = 'http://10.0.0.5/';
        log(`VPN Connected. Fetching ${target}...`);

        console.log("\n--- Method 1: Simplified API (gw.get) ---");
        try {
            console.time("Request");
            const body = await gw.get(target);
            console.timeEnd("Request");

            log(`Response length: ${body.length} bytes`);
        } catch (err) {
            console.error("Method 1 failed:", err.message);
        }

        console.log("\n--- Method 2: Native-like API (gw.http.get) ---");
        gw.http.get(target, (res) => {
            log(`Status: ${res.statusCode}`);
            res.on('data', d => process.stdout.write(`Chunk: ${d.length} bytes\n`));
            res.on('end', () => {
                log("Done.");
                process.exit(0);
            });
        }).on('error', (err) => {
            console.error("Method 2 failed:", err);
            process.exit(1);
        });
    });
    gw.start().catch(console.error);
}

exampleHttp();
