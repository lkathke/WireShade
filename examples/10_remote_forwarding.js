const { WireShade } = require('wireshade');
const path = require('path');
const http = require('http');

/**
 * Example: Remote Forwarding (Reverse Port Forwarding)
 * 
 * Scenario: 
 * You have a service running on your local LAN (e.g., a local printer web interface, 
 * or a development server on another machine) at '192.168.1.50:80'.
 * 
 * You want to make this service accessible to everyone in the VPN at '10.0.0.2:8080'.
 * 
 * Flow: [VPN User] -> [WireShade VPN IP:8080] -> [WireShade] -> [Local LAN IP:80]
 */

async function main() {
    console.log("=== WireShade Remote Forwarding Demo ===");

    // 1. Initialize
    const gw = new WireShade(path.join(__dirname, 'wireguard.conf'));

    gw.on('connect', async () => {
        console.log(`VPN Connected as ${gw.config.wireguard.sourceIp}`);

        // Mock a "local service" for demonstration purposes
        // In reality, this would be an existing service on your machine or network.
        startMockLocalService(3000);

        try {
            // 2. Start Forwarding
            // Listen on VPN Port 8080 -> Forward to localhost:3000
            const vpnPort = 8080;
            const localTargetHost = 'localhost';
            const localTargetPort = 3000;

            await gw.forwardRemote(vpnPort, localTargetHost, localTargetPort);

            console.log(`\n✅ Forwarding Active!`);
            console.log(`Traffic to VPN ${gw.config.wireguard.sourceIp}:${vpnPort} is now forwarded to ${localTargetHost}:${localTargetPort}`);

        } catch (err) {
            console.error("Forwarding failed:", err);
        }
    });

    gw.on('error', console.error);
    await gw.start();
}

function startMockLocalService(port) {
    const server = http.createServer((req, res) => {
        console.log(`[Local Service] Received request: ${req.method} ${req.url}`);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Hello from the Local Service! You reached me via VPN.`);
    });
    server.listen(port, () => {
        console.log(`[Local Service] Running on port ${port}`);
    });
    return server;
}

main();
