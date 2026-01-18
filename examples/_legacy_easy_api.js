const { WireShadeClient } = require('../index');
const https = require('https');

async function testEasyApi() {
    console.log("--- WireShade Easy API Test (Quiet Mode) ---");

    const client = new WireShadeClient({
        wireguard: {
            privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            peerPublicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
            presharedKey: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=",
            endpoint: "203.0.113.1:51820",
            sourceIp: "10.0.0.2"
        },
        logging: false, // DISABLES INTERNAL LOGS
        onConnect: () => {
            console.log("\n>>> EVENT: WireGuard Connection Ready! <<<");
        },
        onDisconnect: () => {
            console.log(">>> EVENT: WireGuard Connection Closed! <<<");
        },
        hosts: {
            'internal.service.lan': '10.0.0.5'
        }
    });

    // Wait a bit to ensure onConnect fired (just for demo flow)
    await new Promise(r => setTimeout(r, 200));

    const target = 'https://internal.service.lan';
    console.log(`\n[HTTPS] Fetching ${target}...`);

    https.get(target, { agent: client.getHttpsAgent() }, (res) => {
        console.log(`[Response] Status: ${res.statusCode}`);
        // res.on('data', d => process.stdout.write(d)); // Suppress body for cleaner output
        console.log(`[Response] Headers received.`);

        // Start Port Forwarding after request
        startForwarding(client);
    }).on('error', console.error);

    async function startForwarding(client) {
        try {
            await client.forwardLocal(9090, '10.0.0.5', 80);
            console.log("\n[Forward] Listening on localhost:9090 -> 10.0.0.5:80");
            console.log("[Forward] Speed test: Open http://localhost:9090 (Should be fast now!)");
        } catch (e) {
            console.error(e);
        }
    }
}

testEasyApi();
