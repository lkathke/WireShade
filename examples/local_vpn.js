const net = require('net');
const { WireShadeClient, generateKeyPair } = require('../index.js');

const keyA = generateKeyPair();
const keyB = generateKeyPair();

console.log("=== Generated Keys ===");
console.log("Peer A PubKey:", keyA.publicKey);
console.log("Peer B PubKey:", keyB.publicKey);
console.log("======================\n");

// Configuration for Peer A
const clientA = new WireShadeClient({
    logging: true,
    wireguard: {
        privateKey: keyA.privateKey,
        peerPublicKey: keyB.publicKey,
        endpoint: '127.0.0.1:51821', // Point to B's listen port
        sourceIp: '10.0.0.1',
        listenPort: 51820
    }
});

// Configuration for Peer B
const clientB = new WireShadeClient({
    logging: true,
    wireguard: {
        privateKey: keyB.privateKey,
        peerPublicKey: keyA.publicKey,
        endpoint: '127.0.0.1:51820', // Point to A's listen port
        sourceIp: '10.0.0.2',
        listenPort: 51821
    }
});

async function runTest() {
    try {
        console.log("Starting Client A...");
        await clientA.start();
        console.log("✅ Client A started.\n");

        console.log("Starting Client B...");
        await clientB.start();
        console.log("✅ Client B started.\n");

        // Wait a moment for handshake
        await new Promise(r => setTimeout(r, 2000));

        // Let's create a server on Client B that listens inside the VPN tunnel
        console.log("Setting up VPN Server on Client B port 8080...");
        await clientB.listen(8080, (socket) => {
            console.log("✅ [Client B] Received connection!");

            socket.on('data', (data) => {
                console.log(`✅ [Client B] Received data: ${data.toString()}`);
                socket.end("Hello from B!");
            });

            socket.on('close', () => {
                console.log("[Client B] Connection closed.");
            });
        });

        // Have Client A connect to B's VPN IP and port
        console.log("Client A pinging Client B (10.0.0.2)...");
        try {
            const time = await clientA.ping('10.0.0.2');
            console.log(`✅ [Client A] Ping successful: ${time}ms`);
        } catch (e) {
            console.error(`❌ [Client A] Ping failed: ${e.message}`);
        }

        console.log("Client A connecting to B (10.0.0.2:8080)...");
        const conn = clientA.connect({ host: '10.0.0.2', port: 8080 });

        conn.on('connect', () => {
            console.log("✅ [Client A] Connected! Sending data...");
            conn.write("Hello from A!");
        });

        conn.on('data', (data) => {
            console.log(`✅ [Client A] Received response: ${data.toString()}`);
            setTimeout(() => {
                console.log("\nTest complete! Shutting down.");
                clientA.close();
                clientB.close();
                process.exit(0);
            }, 500);
        });

        conn.on('error', (err) => {
            console.error("❌ [Client A] Connection error:", err);
            process.exit(1);
        });

    } catch (err) {
        console.error("❌ Test failed:", err);
        process.exit(1);
    }
}

runTest();
