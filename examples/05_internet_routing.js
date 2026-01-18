const { WireShade } = require('../index');
const path = require('path');

/**
 * Example: Internet Access
 * Demonstrates routing traffic to the public internet through the WireGuard tunnel.
 */

async function exampleInternet() {
    const log = (msg) => console.log(`[WireShade Internet] ${msg}`);

    const gw = new WireShade(path.join(__dirname, 'wireguard.conf'));

    gw.on('connect', async () => {
        log("VPN Connected. Checking public IP...");

        // Using gw.https.get for native-like control
        gw.https.get('https://ifconfig.me/ip', (res) => {
            let ip = '';
            res.on('data', c => ip += c);
            res.on('end', () => {
                log(`\nResult IP: ${ip.trim()}`);
                log("(This should match your WireGuard Exit-IP)");
                process.exit(0);
            });
        }).on('error', (err) => {
            console.error("Failed:", err.message);
            process.exit(1);
        });
    });
}

exampleInternet();
