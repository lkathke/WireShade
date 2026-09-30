'use strict';

const { getBinding, generateSelfSignedCert } = require('./lib/binding');

const binding = getBinding();

const { WireShadeAgent } = require('./lib/agent');
const { WireShadeClient, ConnectionState } = require('./lib/client');
const { WireShadeServer } = require('./lib/server');
const { WireShadeWsServer } = require('./lib/ws_server');
const { WireShadeSocksServer } = require('./lib/socks_server');
const { WireShadeBridge } = require('./lib/bridge');
const { parseWireGuardConfig, readWireGuardConfig } = require('./lib/config_parser');
const { generateKeyPair } = require('./lib/crypto_utils');

module.exports = {
    WireShade: WireShadeClient, // The high-level client is the main export
    NativeWireShade: binding.WireShade,
    WireShadeClient,
    WireShadeAgent,
    WireShadeServer,
    WireShadeWsServer,
    WireShadeSocksServer,
    WireShadeBridge,
    ConnectionState,
    parseConfig: parseWireGuardConfig,
    readConfig: readWireGuardConfig,
    readWireGuardConfig,
    parseWireGuardConfig,
    generateKeyPair,
    generateSelfSignedCert
};
