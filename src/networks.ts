import { Hono } from "hono";
import type { AppBindings } from "./types";
import { issueToken, requireAuth, requireNetwork, requireRole } from "./auth";
import { provisionNetwork } from "./provision";

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

networks.get("/:networkId", requireNetwork, requireRole("owner", "admin"), async (c) => {
  // Cross-network access is a 403, not a 404, per the roadmap.
  if (c.req.param("networkId") !== c.get("user").networkId) return c.json({ error: "forbidden" }, 403);
  const r = await c.env.DB.prepare(
    `SELECT id, slug, display_name, status, stripe_account_id, platform_fee_percent,
            public_api_key_hint, private_api_key_hint, created_at FROM networks WHERE id = ?`,
  )
    .bind(c.get("user").networkId)
    .first<Record<string, any>>();
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json({
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    status: r.status,
    stripe: { status: r.stripe_account_id ? "connected" : "not_connected" },
    platformFeePercent: r.platform_fee_percent,
    apiKeys: { public: `pk_…${r.public_api_key_hint}`, private: `sk_…${r.private_api_key_hint}` },
    createdAt: r.created_at,
  });
});
