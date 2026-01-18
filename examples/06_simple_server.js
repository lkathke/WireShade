const { WireShade } = require('../index');
const path = require('path');

/**
 * Server über WireGuard veröffentlichen (Reverse Tunnel)
 */

const VPN_PORT = 8080;

async function main() {
    console.log("=== WireShade Reverse Tunnel Demo ===");

    const gw = new WireShade(path.join(__dirname, 'wireguard.conf'));

    gw.on('connect', async () => {
        console.log("Listen on http://10.0.0.2:8080/");

        try {
            await gw.listen(VPN_PORT, (socket) => {
                console.log(`[Server] New connection!`);

                socket.end([
                    'HTTP/1.1 200 OK',
                    'Content-Type: text/html',
                    'Connection: close',
                    '',
                    '<h1>Hello from WireShade Server!</h1>'
                ].join('\r\n'));
            });

            console.log(`✅ Server listening on VPN port ${VPN_PORT}`);
        } catch (err) {
            console.error("Server start failed:", err);
        }
    });

    gw.on('error', console.error);
}

main();
