import crypto from "crypto";
import type { KeyPair } from "./types";

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  return {
    privateKey: privateKey.subarray(privateKey.length - 32).toString("base64"),
    publicKey: publicKey.subarray(publicKey.length - 32).toString("base64"),
  };
}
