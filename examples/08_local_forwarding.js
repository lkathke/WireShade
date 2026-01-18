const { WireShade } = require('../index');
const path = require('path');

/**
 * Example: TCP Port Forwarding
 * Forwards localhost:8080 -> 10.0.0.5:80 via VPN
 */

async function examplePortForward() {
    const gw = new WireShade(path.join(__dirname, 'wireguard.conf'));

    gw.on('connect', async () => {
        console.log("VPN Connected.");

        try {
            const server = await gw.forwardLocal(8080, '10.0.0.5', 80);

            console.log(`Forwarding localhost:8080 -> 10.0.0.5:80`);
            console.log("Press Ctrl+C to stop.");

            // server is a net.Server
            server.on('error', (e) => console.error("Server error:", e.message));

        } catch (err) {
            console.error("Failed to start forwarding:", err.message);
        }
    });

    gw.start().catch(console.error);
}

examplePortForward();
