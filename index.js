const fs = require('fs');
const path = require('path');

let binding;
try {
    binding = require('./wireshade.node');
} catch (e) {
    try {
        binding = require('./wireshade.win32-x64-msvc.node');
    } catch (e2) {
        throw new Error('Could not load native binding');
    }
}

const { WireShadeAgent } = require('./lib/agent');
const { WireShadeClient, ConnectionState } = require('./lib/client');
const { WireShadeServer } = require('./lib/server');
const { parseWireGuardConfig, readWireGuardConfig } = require('./lib/config_parser');

module.exports = {
    WireShade: WireShadeClient, // The high-level client is the main export
    NativeWireShade: binding.WireShade,
    WireShadeClient,
    WireShadeAgent,
    WireShadeServer,
    ConnectionState,
    parseConfig: parseWireGuardConfig,
    readConfig: readWireGuardConfig
};
