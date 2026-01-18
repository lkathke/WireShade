const { WireShade } = require('wireshade');
const path = require('path');

/**
 * Example: Raw TCP Socket
 * Demonstrates low-level access to the TCP connection using the simplified API.
 */

async function exampleTcp() {
    const log = (msg) => console.log(`[WireShade TCP] ${msg}`);

    // Initialize with config file
    const gw = new WireShade(path.join(__dirname, 'wireguard.conf'));

    gw.on('connect', () => {
        log("VPN Connected. Establishing TCP connection...");

        const targetIp = '10.0.0.5';
        const targetPort = 80;

        const socket = gw.connect({
            host: targetIp,
            port: targetPort
        });

        socket.on('connect', () => {
            log(`Socket connected to ${targetIp}:${targetPort}`);

            const request = "GET / HTTP/1.1\r\nHost: 10.0.0.5\r\nConnection: close\r\n\r\n";
            socket.write(request);
            log("HTTP GET sent.");
        });

        socket.on('data', (data) => {
            log(`Received ${data.length} bytes:`);
            console.log(data.toString().split('\n')[0] + '...'); // Print first line
        });

        socket.on('close', () => {
            log("Connection closed.");
            process.exit(0);
        });

        socket.on('error', (err) => {
            console.error("Socket error:", err.message);
        });
    });

    gw.start().catch(console.error);
}

exampleTcp();
