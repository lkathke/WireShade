/**
 * WireShadeClient Reconnection Demo
 * 
 * Zeigt die automatische Reconnection-Logik mit Events und Konfiguration.
 */

const { WireShade, ConnectionState } = require('../index');
const https = require('https');

const { readWireGuardConfig } = require('../lib/config_parser');
const path = require('path');

const wireguardConfig = readWireGuardConfig(path.join(__dirname, 'wireguard.conf'));

const config = {
    wireguard: wireguardConfig,

    logging: true,

    // Reconnection configuration
    reconnect: {
        enabled: true,           // Auto-reconnect on disconnect
        maxAttempts: 5,          // Max attempts (0 = infinite)
        delay: 1000,             // Initial delay: 1 second
        maxDelay: 30000,         // Max delay: 30 seconds
        backoffMultiplier: 2,    // Double delay each attempt
        healthCheckInterval: 60000 // Check every 60 seconds
    },

    hosts: {
        'internal.service.lan': '10.0.0.5'
    }
};

async function main() {
    console.log('=== WireShadeClient Reconnection Demo ===\n');

    const client = new WireShade(config);

    // Event: State changes
    client.on('stateChange', (state) => {
        const stateEmoji = {
            [ConnectionState.DISCONNECTED]: '🔴',
            [ConnectionState.CONNECTING]: '🟡',
            [ConnectionState.CONNECTED]: '🟢',
            [ConnectionState.RECONNECTING]: '🟠'
        };
        console.log(`[State] ${stateEmoji[state] || '⚪'} ${state}`);
    });

    // Event: Connected
    client.on('connect', () => {
        console.log('[Event] ✅ Verbunden!');
    });

    // Event: Disconnected
    client.on('disconnect', (err) => {
        console.log('[Event] ❌ Verbindung getrennt:', err?.message || 'Unknown');
    });

    // Event: Reconnecting
    client.on('reconnecting', (attempt) => {
        console.log(`[Event] 🔄 Reconnect Versuch ${attempt}...`);
    });

    // Event: Reconnected
    client.on('reconnect', () => {
        console.log('[Event] ✅ Wiederverbunden!');
    });

    // Event: Reconnect failed
    client.on('reconnectFailed', () => {
        console.log('[Event] ❌ Reconnection fehlgeschlagen nach max Versuchen');
    });

    // Event: Health check
    client.on('healthCheck', () => {
        console.log('[Health] 💓 Health check...');
    });

    // Wait for initial connection
    await new Promise(resolve => setTimeout(resolve, 4000));

    // Test: Make a request
    console.log('\n--- Test Request ---');
    try {
        const response = await makeRequest(client, 'https://ifconfig.me/ip');
        console.log('Externe IP:', response.trim());
    } catch (err) {
        console.log('Request fehlgeschlagen:', err.message);
    }

    // Demo: Manual reconnect
    console.log('\n--- Manual Reconnect Test ---');
    console.log('Drücke Ctrl+C um zu beenden.\n');

    // Keep running
    setInterval(async () => {
        if (client.connected) {
            console.log(`[${new Date().toLocaleTimeString()}] Status: Verbunden`);
        } else {
            console.log(`[${new Date().toLocaleTimeString()}] Status: ${client.state}`);
        }
    }, 10000);

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\nShutting down...');
        client.close();
        process.exit(0);
    });
}

function makeRequest(client, url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { agent: client.getHttpsAgent() }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy(new Error('Timeout'));
        });
    });
}

main().catch(console.error);
