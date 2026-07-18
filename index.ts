import { WireShadeAgent } from './lib/agent'
import { WireShadeClient, ConnectionStateValue } from './lib/client'
import { WireShadeServer } from './lib/server'
import { parseWireGuardConfig, readWireGuardConfig } from './lib/config_parser'
import { generateKeyPair } from './lib/crypto_utils'
import type { NativeWireShade as NativeWireShadeType } from './lib/types'

let binding: { WireShade: new (...args: any[]) => NativeWireShadeType }
try {
    binding = require('./wireshade.node')
} catch (e) {
    try {
        binding = require('./wireshade.win32-x64-msvc.node')
    } catch (e2) {
        throw new Error('Could not load native binding')
    }
}

const NativeWireShade = binding.WireShade

export {
    WireShadeClient as WireShade,
    NativeWireShade,
    WireShadeClient,
    WireShadeAgent,
    WireShadeServer,
    ConnectionStateValue as ConnectionState,
    parseWireGuardConfig as parseConfig,
    readWireGuardConfig as readConfig,
    generateKeyPair,
}

export type {
    ClientConfig,
    WireGuardConfig,
    ReconnectConfig,
    KeyPair,
    NativeConnection,
    WireShadeDuplex,
} from './lib/types'

export type ConnectionState = typeof ConnectionStateValue[keyof typeof ConnectionStateValue]