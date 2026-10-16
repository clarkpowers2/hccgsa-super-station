import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings } from "./types";
import { requireAuth, requireNetwork, requireRole } from "./auth";
import { stripePost } from "./stripe";

type Ctx = Context<AppBindings>;

export type ConnectStatus = "not_connected" | "pending" | "active";

/** One rule for every place that reports a network's Stripe state. `active` = charges and payouts both enabled. */
export function connectStatus(r: {
  stripe_account_id: string | null;
  stripe_charges_enabled: number;
  stripe_payouts_enabled: number;
}): ConnectStatus {
  if (!r.stripe_account_id) return "not_connected";
  return r.stripe_charges_enabled === 1 && r.stripe_payouts_enabled === 1 ? "active" : "pending";
}

export const stripeExpress = new Hono<AppBindings>();

const ownNetwork = async (c: Ctx, next: () => Promise<void>) => {
  if (c.req.param("networkId") !== c.get("user").networkId) return c.json({ error: "forbidden" }, 403);
  await next();
};

// Owner only: create the network's Express account on first call, then always hand back a fresh onboarding link.
stripeExpress.post(
  "/networks/:networkId/stripe/onboard",
  requireAuth,
  requireNetwork,
  ownNetwork,
  requireRole("owner"),
  async (c) => {
    const networkId = c.get("user").networkId!;
    const net = await c.env.DB.prepare("SELECT stripe_account_id FROM networks WHERE id = ?")
      .bind(networkId)
      .first<{ stripe_account_id: string | null }>();
    if (!net) return c.json({ error: "not found" }, 404);

    let accountId = net.stripe_account_id;
    if (!accountId) {
      // Idempotency key: two concurrent first calls get the same Stripe account back.
      const account = await stripePost(
        c.env,
        "/accounts",
        {
          type: "express",
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          metadata: { network_id: networkId },
        },
        { idempotencyKey: `network-express-account-${networkId}` },
      );
      // First writer wins; re-read so a racing call that lost still returns the stored id.
      await c.env.DB.prepare(
        "UPDATE networks SET stripe_account_id = ?, updated_at = datetime('now') WHERE id = ? AND stripe_account_id IS NULL",
      )
        .bind(account.id, networkId)
        .run();
      const saved = await c.env.DB.prepare("SELECT stripe_account_id FROM networks WHERE id = ?")
        .bind(networkId)
        .first<{ stripe_account_id: string }>();
      accountId = saved!.stripe_account_id;
    }

    const link = await stripePost(c.env, "/account_links", {
      account: accountId,
      type: "account_onboarding",
      refresh_url: `${c.env.APP_URL}/settings/payments?refresh=1`,
      return_url: `${c.env.APP_URL}/settings/payments?connected=1`,
    });
    return c.json({ url: link.url, stripe_account_id: accountId });
  },
);

// Admin+: reads the locally stored flags only (kept fresh by account.updated); never calls Stripe.
stripeExpress.get(
  "/networks/:networkId/stripe/status",
  requireAuth,
  requireNetwork,
  ownNetwork,
  requireRole("owner", "admin"),
  async (c) => {
    const r = await c.env.DB.prepare(
      "SELECT stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted FROM networks WHERE id = ?",
    )
      .bind(c.get("user").networkId)
      .first<{
        stripe_account_id: string | null;
        stripe_charges_enabled: number;
        stripe_payouts_enabled: number;
        stripe_details_submitted: number;
      }>();
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({
      status: connectStatus(r),
      charges_enabled: r.stripe_charges_enabled === 1,
      payouts_enabled: r.stripe_payouts_enabled === 1,
      details_submitted: r.stripe_details_submitted === 1,
    });
  },
);
