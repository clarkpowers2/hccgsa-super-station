import type { Env } from "./types";

export interface ProvisionedNetwork {
  id: string;
  slug: string;
  displayName: string;
  status: "active";
  apiKeys: { public: string; private: string }; // plaintext, returned once; only hashes are stored
  stripe: { status: "not_connected" };
}

const toHex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const randomHex = (bytes: number) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));

export const hashApiKey = async (key: string) =>
  toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));

function slugify(name: string) {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "network";
}

/**
 * Creates a network owned by `userId` and moves the user into it, in one atomic D1 batch.
 * `before` statements (e.g. the user INSERT during registration) run first in the same batch.
 * Stripe is a placeholder until the first creator enables paid listeners.
 */
export async function provisionNetwork(
  env: Env,
  userId: string,
  displayName: string,
  ...before: D1PreparedStatement[]
): Promise<ProvisionedNetwork> {
  const base = slugify(displayName);
  const taken = await env.DB.prepare("SELECT 1 AS t FROM networks WHERE slug = ?").bind(base).first();
  const slug = taken ? `${base}-${randomHex(3)}` : base;

  const id = `net_${randomHex(8)}`;
  const pub = `pk_${randomHex(16)}`;
  const priv = `sk_${randomHex(24)}`;
  await env.DB.batch([
    ...before,
    env.DB.prepare(
      `INSERT INTO networks (id, slug, display_name, owner_id, status,
         public_api_key_hash, public_api_key_hint, private_api_key_hash, private_api_key_hint)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).bind(id, slug, displayName, userId, await hashApiKey(pub), pub.slice(-4), await hashApiKey(priv), priv.slice(-4)),
    env.DB.prepare("UPDATE users SET network_id = ?, role = 'owner', updated_at = datetime('now') WHERE id = ?").bind(id, userId),
  ]);
  return { id, slug, displayName, status: "active", apiKeys: { public: pub, private: priv }, stripe: { status: "not_connected" } };
}
