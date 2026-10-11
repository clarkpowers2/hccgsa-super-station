import type { Env } from "./types";

// Webhook secrets are encrypted at rest with AES-256-GCM. HMAC needs the raw secret at send time,
// so hashing is not an option. The master key lives in the WEBHOOK_ENC_KEY secret (base64, 32 bytes).
const PREFIX = "v1:";

function keyBytes(env: Env): Uint8Array {
  const raw = env.WEBHOOK_ENC_KEY ? Uint8Array.from(atob(env.WEBHOOK_ENC_KEY), (c) => c.charCodeAt(0)) : new Uint8Array();
  if (raw.length !== 32) throw new Error("WEBHOOK_ENC_KEY must be 32 bytes, base64-encoded");
  return raw;
}

function importKey(env: Env, usage: ("encrypt" | "decrypt")[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes(env), { name: "AES-GCM" }, false, usage);
}

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(env, ["encrypt"]), new TextEncoder().encode(plaintext)));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv);
  packed.set(ct, iv.length);
  return PREFIX + toB64(packed);
}

/** Throws if the value is malformed or was encrypted under a different key (GCM authentication fails). */
export async function decryptSecret(env: Env, stored: string): Promise<string> {
  if (!stored.startsWith(PREFIX)) throw new Error("unknown secret format");
  const packed = fromB64(stored.slice(PREFIX.length));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, await importKey(env, ["decrypt"]), packed.slice(12));
  return new TextDecoder().decode(pt);
}
