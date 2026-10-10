import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings, Role } from "./types";
import { issueToken, requireAuth, requireNetwork, requireRole } from "./auth";
import { provisionNetwork, randomHex, sha256Hex } from "./provision";

type Ctx = Context<AppBindings>;

const INVITE_TTL_HOURS = 24;
const INVITABLE_ROLES: readonly string[] = ["admin", "creator", "guest"];
const WEBHOOK_EVENTS = ["episode.created", "episode.published", "stream.started", "stream.ended"] as const;
const MAX_WEBHOOKS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const networks = new Hono<AppBindings>();
networks.use("*", requireAuth);

// Manual creation for an account that has no network yet (e.g. a viewer upgrading to a creator).
networks.post("/create", async (c) => {
  const u = c.get("user");
  if (u.networkId) return c.json({ error: "account already belongs to a network" }, 409);
  const body = (await c.req.json().catch(() => ({}))) as { displayName?: unknown };
  if (typeof body.displayName !== "string" || !body.displayName.trim() || body.displayName.length > 80)
    return c.json({ error: "displayName must be 1-80 characters" }, 400);
  const net = await provisionNetwork(c.env, u.sub, body.displayName.trim());
  await c.env.DB.prepare("UPDATE users SET is_creator = 1 WHERE id = ?").bind(u.sub).run();
  // Claims changed, so hand back a fresh token.
  const token = await issueToken(c.env, { id: u.sub, isCreator: true, networkId: net.id, role: "owner" });
  return c.json({ ...net, token }, 201);
});

// Everything below acts on the caller's own network only. A different {networkId} is a 403.
const ownNetwork = async (c: Ctx, next: () => Promise<void>) => {
  if (c.req.param("networkId") !== c.get("user").networkId) return c.json({ error: "forbidden" }, 403);
  await next();
};
const adminUp = [requireNetwork, ownNetwork, requireRole("owner", "admin")] as const;
const ownerOnly = [requireNetwork, ownNetwork, requireRole("owner")] as const;

// ---- network ---------------------------------------------------------------

async function networkView(c: Ctx) {
  const r = await c.env.DB.prepare(
    `SELECT id, slug, display_name, description, branding, status, stripe_account_id, platform_fee_percent,
            public_api_key_hint, private_api_key_hint, created_at FROM networks WHERE id = ?`,
  )
    .bind(c.get("user").networkId)
    .first<Record<string, any>>();
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    description: r.description,
    branding: r.branding ? JSON.parse(r.branding) : null,
    status: r.status,
    stripe: { status: r.stripe_account_id ? "connected" : "not_connected" },
    platformFeePercent: r.platform_fee_percent,
    apiKeys: { public: `pk_…${r.public_api_key_hint}`, private: `sk_…${r.private_api_key_hint}` },
    createdAt: r.created_at,
  };
}

networks.get("/:networkId", ...adminUp, async (c) => {
  const v = await networkView(c);
  return v ? c.json(v) : c.json({ error: "not found" }, 404);
});

networks.put("/:networkId/settings", ...adminUp, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { displayName?: unknown; description?: unknown; branding?: unknown };
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string" || !body.displayName.trim() || body.displayName.length > 80)
      return c.json({ error: "displayName must be 1-80 characters" }, 400);
    sets.push("display_name = ?");
    vals.push(body.displayName.trim());
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.length > 1000)
      return c.json({ error: "description must be at most 1000 characters" }, 400);
    sets.push("description = ?");
    vals.push(body.description);
  }
  if (body.branding !== undefined) {
    const json = JSON.stringify(body.branding);
    if (body.branding === null || typeof body.branding !== "object" || Array.isArray(body.branding) || json.length > 2000)
      return c.json({ error: "branding must be a JSON object of at most 2000 characters" }, 400);
    sets.push("branding = ?");
    vals.push(json);
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  await c.env.DB.prepare(`UPDATE networks SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...vals, c.get("user").networkId)
    .run();
  return c.json(await networkView(c));
});

// ---- users & invites ---------------------------------------------------------

networks.get("/:networkId/users", ...adminUp, async (c) => {
  const nid = c.get("user").networkId;
  const users = await c.env.DB.prepare(
    "SELECT id, email, creator_name, role, created_at FROM users WHERE network_id = ? AND deleted_at IS NULL ORDER BY created_at, id",
  )
    .bind(nid)
    .all<{ id: string; email: string; creator_name: string; role: Role; created_at: string }>();
  const pending = await c.env.DB.prepare(
    "SELECT id, email, role, expires_at FROM invites WHERE network_id = ? AND accepted_at IS NULL AND expires_at > datetime('now') ORDER BY created_at",
  )
    .bind(nid)
    .all<{ id: string; email: string; role: Role; expires_at: string }>();
  return c.json({
    users: users.results.map((u) => ({ id: u.id, email: u.email, name: u.creator_name, role: u.role, joinedAt: u.created_at })),
    pendingInvites: pending.results.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at })),
  });
});

networks.post("/:networkId/users", ...ownerOnly, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; role?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return c.json({ error: "valid email required" }, 400);
  if (typeof body.role !== "string" || !INVITABLE_ROLES.includes(body.role))
    return c.json({ error: "role must be admin, creator or guest" }, 400);

  // Phase 2 constraint: emails are globally unique and a user belongs to one network.
  const exists = await c.env.DB.prepare("SELECT 1 AS x FROM users WHERE email = ?").bind(email).first();
  if (exists) return c.json({ error: "email already registered" }, 409);

  const nid = c.get("user").networkId!;
  const token = randomHex(32);
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600_000).toISOString().slice(0, 19).replace("T", " "); // matches datetime('now')
  await c.env.DB.batch([
    // A re-invite replaces any earlier unaccepted link for the same address.
    c.env.DB.prepare("DELETE FROM invites WHERE network_id = ? AND email = ? AND accepted_at IS NULL").bind(nid, email),
    c.env.DB.prepare(
      "INSERT INTO invites (id, network_id, email, role, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), nid, email, body.role, await sha256Hex(token), expiresAt, c.get("user").sub),
  ]);
  const base = (c.env.DASHBOARD_URL ?? (c.env.CORS_ORIGINS ?? "http://localhost:3000").split(",")[0] ?? "http://localhost:3000").trim().replace(/\/$/, "");
  return c.json({ inviteUrl: `${base}/accept-invite?token=${token}`, email, role: body.role, expiresAt }, 201);
});

networks.put("/:networkId/users/:userId", ...ownerOnly, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { role?: unknown; deleted?: unknown };
  const nid = c.get("user").networkId!;
  const target = await c.env.DB.prepare("SELECT id, role FROM users WHERE id = ? AND network_id = ? AND deleted_at IS NULL")
    .bind(c.req.param("userId"), nid)
    .first<{ id: string; role: Role }>();
  if (!target) return c.json({ error: "not found" }, 404);
  if (target.role === "owner") return c.json({ error: "the network owner cannot be changed" }, 409);

  if (body.deleted === true) {
    await c.env.DB.prepare("UPDATE users SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND network_id = ?")
      .bind(target.id, nid)
      .run();
    return c.json({ id: target.id, deleted: true });
  }
  if (typeof body.role !== "string" || !INVITABLE_ROLES.includes(body.role))
    return c.json({ error: "provide role (admin, creator or guest) or deleted: true" }, 400);
  await c.env.DB.prepare(
    "UPDATE users SET role = ?, is_creator = ?, updated_at = datetime('now') WHERE id = ? AND network_id = ?",
  )
    .bind(body.role, body.role === "guest" ? 0 : 1, target.id, nid)
    .run();
  return c.json({ id: target.id, role: body.role });
});

// ---- webhooks (registration only; delivery + HMAC signing are Phase 3+) -------------

function validWebhookUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 500) return null;
  try {
    const u = new URL(v);
    const h = u.hostname;
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^[\d.]+$/.test(h) || h.includes(":")) return null; // no IP literals / local names
    return u.toString();
  } catch {
    return null;
  }
}

networks.post("/:networkId/webhooks", ...adminUp, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: unknown; events?: unknown };
  const url = validWebhookUrl(body.url);
  if (!url) return c.json({ error: "url must be a public https URL" }, 400);
  if (
    !Array.isArray(body.events) || !body.events.length ||
    !body.events.every((e) => typeof e === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(e))
  )
    return c.json({ error: "events must be a non-empty list of supported events", supported: WEBHOOK_EVENTS }, 400);

  const nid = c.get("user").networkId!;
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE network_id = ?").bind(nid).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_WEBHOOKS) return c.json({ error: `at most ${MAX_WEBHOOKS} webhooks per network` }, 409);

  const id = crypto.randomUUID();
  const secret = `whsec_${randomHex(24)}`;
  const events = [...new Set(body.events as string[])];
  await c.env.DB.prepare("INSERT INTO webhooks (id, network_id, url, events, secret, created_by) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, nid, url, JSON.stringify(events), secret, c.get("user").sub)
    .run();
  return c.json({ id, url, events, secret }, 201); // the secret is only ever returned here
});

networks.get("/:networkId/webhooks", ...adminUp, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, url, events, created_at FROM webhooks WHERE network_id = ? ORDER BY created_at, id")
    .bind(c.get("user").networkId)
    .all<{ id: string; url: string; events: string; created_at: string }>();
  return c.json({ webhooks: results.map((w) => ({ id: w.id, url: w.url, events: JSON.parse(w.events), createdAt: w.created_at })) });
});

networks.delete("/:networkId/webhooks/:webhookId", ...adminUp, async (c) => {
  const row = await c.env.DB.prepare("SELECT id FROM webhooks WHERE id = ? AND network_id = ?")
    .bind(c.req.param("webhookId"), c.get("user").networkId)
    .first();
  if (!row) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM webhooks WHERE id = ? AND network_id = ?").bind(c.req.param("webhookId"), c.get("user").networkId).run();
  return c.json({ ok: true });
});
