const { WireShade } = require('wireshade');
const path = require('path');

async function main() {
    console.log("--- Zero-Config WireShade Demo ---");

    // 1. Initialize
    const gw = new WireShade(path.join(__dirname, 'wireguard.conf'));

    // 2. Connect
    console.log("Connecting...");
    await gw.start();
    console.log("✅ VPN Connected!");

    // 3. Simple HTTP Request (like fetch)
    try {
        console.log("Fetching IP...");
        const body = await gw.get('http://10.0.0.5/');
        console.log(`🌍 External IP: ${body.trim()}`);
    } catch (e) {
        console.error("Request failed:", e.message);
    }

    // 4. Simple Server
    console.log("Starting server on port 8080...");
    await gw.listen(8080, (socket) => {
        console.log("incoming connection!");
        socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nHello from minimal WireShade!');
    });

    console.log("Server running. Waiting for connections...");

    gw.on('error', console.error);
}

main();
