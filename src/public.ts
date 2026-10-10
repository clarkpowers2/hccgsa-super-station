import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, AppBindings } from "./types";
import { sha256Hex } from "./provision";
import { hit } from "./ratelimit";
import { signedViewUrl } from "./media";

export const LIMITS = { public: 1000, private: 10_000 } as const; // requests per hour

export async function publishedEpisodeView(env: Env, id: string) {
  const r = await env.DB.prepare(
    `SELECT e.id, e.title, e.description, e.thumbnail_key, e.metadata_tags, e.publish_date, e.one_time_price_cents,
            e.view_count, u.creator_name
     FROM episodes e JOIN users u ON u.id = e.creator_id
     WHERE e.id = ? AND e.is_published = 1`,
  )
    .bind(id)
    .first<Record<string, any>>();
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    tags: r.metadata_tags ? JSON.parse(r.metadata_tags) : [],
    publishDate: r.publish_date,
    oneTimePriceCents: r.one_time_price_cents,
    viewCount: r.view_count,
    creatorName: r.creator_name,
    thumbnailUrl: r.thumbnail_key ? await signedViewUrl(env, r.thumbnail_key) : null,
  };
}

export const publicApi = new Hono<AppBindings & { Variables: { keyType: "public" | "private"; keyNetworkId: string } }>();

// Browser embeds on any site call this with a bearer key (no cookies), so open CORS is safe here.
publicApi.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "OPTIONS"], exposeHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"] }));

publicApi.use("*", async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!key) return c.json({ error: "unauthorized" }, 401);

  const h = await sha256Hex(key);
  const net = await c.env.DB.prepare(
    `SELECT id, public_api_key_hash FROM networks
     WHERE status = 'active' AND (public_api_key_hash = ? OR private_api_key_hash = ?)`,
  )
    .bind(h, h)
    .first<{ id: string; public_api_key_hash: string }>();
  if (!net) return c.json({ error: "unauthorized" }, 401);
  const keyType = net.public_api_key_hash === h ? "public" : "private";

  const rl = await hit(c.env.DB, `${net.id}:${keyType}`, LIMITS[keyType]);
  c.header("X-RateLimit-Limit", String(rl.limit));
  c.header("X-RateLimit-Remaining", String(rl.remaining));
  c.header("X-RateLimit-Reset", String(rl.resetAt));
  if (!rl.allowed) {
    c.header("Retry-After", String(Math.max(1, rl.resetAt - Math.floor(Date.now() / 1000))));
    return c.json({ error: "rate limit exceeded" }, 429);
  }
  c.set("keyType", keyType);
  c.set("keyNetworkId", net.id);
  await next();
});

// Phase 2: global scope (platform-directory mode) — any network's key can read any published episode.
publicApi.get("/episodes/:id", async (c) => {
  const ep = await publishedEpisodeView(c.env, c.req.param("id"));
  return ep ? c.json(ep) : c.json({ error: "not found" }, 404);
});
