const fs = require('fs');

/**
 * Parses a standard WireGuard configuration file content.
 * @param {string} content - The content of the .conf file
 * @returns {Object} Config object suitable for WireShade
 */
function parseWireGuardConfig(content) {
    const lines = content.split('\n');
    const config = {
        privateKey: '',
        sourceIp: '',
        peerPublicKey: '',
        presharedKey: '',
        endpoint: ''
    };

    let currentSection = '';

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;

        if (line.startsWith('[') && line.endsWith(']')) {
            currentSection = line.slice(1, -1).toLowerCase();
            continue;
        }

        const [key, ...valueParts] = line.split('=');
        if (!key || valueParts.length === 0) continue;

        const normalizedKey = key.trim().toLowerCase();
        const value = valueParts.join('=').trim();

        if (currentSection === 'interface') {
            if (normalizedKey === 'privatekey') {
                config.privateKey = value;
            } else if (normalizedKey === 'address') {
                // Remove subnet mask (e.g., /32) if present
                config.sourceIp = value.split('/')[0].trim();
            }
        } else if (currentSection === 'peer') {
            if (normalizedKey === 'publickey') {
                config.peerPublicKey = value;
            } else if (normalizedKey === 'presharedkey') {
                config.presharedKey = value;
            } else if (normalizedKey === 'endpoint') {
                config.endpoint = value;
            }
        }
    }

    if (!config.privateKey || !config.peerPublicKey || !config.endpoint) {
        throw new Error('Invalid WireGuard config: Missing required fields (PrivateKey, PublicKey, or Endpoint)');
    }

    return config;
}

/**
 * Reads and parses a WireGuard config file.
 * @param {string} filePath - Path to the .conf file
 * @returns {Object} Config object
 */
function readWireGuardConfig(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return parseWireGuardConfig(content);
    } catch (err) {
        throw new Error(`Failed to read config file: ${err.message}`);
    }
}

module.exports = {
    parseWireGuardConfig,
    readWireGuardConfig
};
