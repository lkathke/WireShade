import fs from "fs";
import type { WireGuardConfig } from "./types";

export function parseWireGuardConfig(content: string): WireGuardConfig {
  const lines = content.split("\n");
  const config: WireGuardConfig = {
    privateKey: "",
    sourceIp: "",
    peerPublicKey: "",
    presharedKey: "",
    endpoint: "",
    listenPort: null,
  };

  let currentSection = "";

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      currentSection = line.slice(1, -1).toLowerCase();
      continue;
    }

    const [key, ...valueParts] = line.split("=");
    if (!key || valueParts.length === 0) continue;

    const normalizedKey = key.trim().toLowerCase();
    const value = valueParts.join("=").trim();

    if (currentSection === "interface") {
      if (normalizedKey === "privatekey") {
        config.privateKey = value;
      } else if (normalizedKey === "address") {
        config.sourceIp = value.split("/")[0]?.trim() ?? "";
      } else if (normalizedKey === "listenport") {
        config.listenPort = parseInt(value, 10);
      }
    } else if (currentSection === "peer") {
      if (normalizedKey === "publickey") {
        config.peerPublicKey = value;
      } else if (normalizedKey === "presharedkey") {
        config.presharedKey = value;
      } else if (normalizedKey === "endpoint") {
        config.endpoint = value;
      }
    }
  }

  if (!config.privateKey || !config.peerPublicKey || !config.endpoint) {
    throw new Error(
      "Invalid WireGuard config: Missing required fields (PrivateKey, PublicKey, or Endpoint)",
    );
  }

  return config;
}

export function readWireGuardConfig(filePath: string): WireGuardConfig {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return parseWireGuardConfig(content);
  } catch (err) {
    throw new Error(`Failed to read config file: ${(err as Error).message}`);
  }
}
