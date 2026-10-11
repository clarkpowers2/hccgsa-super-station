// Header format: X-Webhook-Signature: sha256=<hex HMAC-SHA256 of the exact body bytes sent>

const enc = new TextEncoder();

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signPayload(secret: string, body: string): Promise<string> {
  return `sha256=${await hmacHex(secret, body)}`;
}

/** Receivers use this. Constant-time comparison so timing does not reveal the expected signature. */
export async function verifyPayload(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const expected = enc.encode(await signPayload(secret, body));
  const given = enc.encode(header);
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= (expected[i] ?? 0) ^ (given[i] ?? 0);
  return diff === 0;
}
