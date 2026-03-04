const crypto = require('crypto');

/**
 * Generates a valid x25519 keypair for WireGuard
 * @returns {{ privateKey: string, publicKey: string }}
 */
function generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' }
    });

    return {
        // WireGuard uses 32-byte raw keys encoded in base64
        privateKey: privateKey.subarray(privateKey.length - 32).toString('base64'),
        publicKey: publicKey.subarray(publicKey.length - 32).toString('base64'),
    };
}

module.exports = {
    generateKeyPair
};
