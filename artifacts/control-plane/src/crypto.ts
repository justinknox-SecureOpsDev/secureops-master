/**
 * At-rest encryption for per-customer management secrets.
 *
 * Each customer's CONTROL_PLANE_SHARED_SECRET (the HMAC key the control plane
 * uses to sign remote-settings requests to that backend) is stored ENCRYPTED in
 * the registry, never in plaintext and never returned to the browser. We use
 * AES-256-GCM with a key derived from CONTROL_PLANE_ENCRYPTION_KEY.
 *
 * Format: "v1:" + base64( iv(12) | authTag(16) | ciphertext ).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ENCRYPTION_KEY } from "./config";

const VERSION = "v1";
const IV_LEN = 12;
const TAG_LEN = 16;

function derivedKey(): Buffer {
  // SHA-256 yields a stable 32-byte key from whatever passphrase/key was given.
  return createHash("sha256").update(ENCRYPTION_KEY, "utf8").digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, enc]).toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  const [version, payload] = stored.split(":", 2);
  if (version !== VERSION || !payload) {
    throw new Error("[control-plane] unrecognised encrypted secret format");
  }
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", derivedKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
