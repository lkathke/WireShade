const express = require('express');
const { WireShade } = require('../index');
const http = require('http');
const path = require('path');

/**
 * Express über WireGuard veröffentlichen (Reverse Tunnel)
 */

async function main() {
    console.log("=== WireShade + Express Demo ===");

    // 1. Setup Express
    const app = express();
    app.get('/', (req, res) => res.send('<h1>🎉 Express via WireShade!</h1>'));
    app.get('/api/status', (req, res) => res.json({ status: 'online', vpn: true }));

    // Create standard HTTP server (but don't listen on TCP port)
    const httpServer = http.createServer(app);

    // 2. Setup GhostWire
    const gw = new WireShade(path.join(__dirname, 'wireguard.conf'));

    gw.on('connect', async () => {
        console.log(`VPN Connected as ${gw.config.wireguard.sourceIp}`);

        // 3. Bridge VPN connections to Express
        await gw.listen(8080, (socket) => {
            // Inject the VPN socket into the HTTP server
            httpServer.emit('connection', socket);
        });

        console.log("✅ Express Server accessible at http://10.0.0.2:8080");
    });
}

main();
