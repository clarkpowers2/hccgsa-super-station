import { Hono } from "hono";
import type { Context } from "hono";
import Stripe from "stripe";
import type { AppBindings, Env } from "./types";
import { requireAuth, requireNetwork, requireRole } from "./auth";

type Ctx = Context<AppBindings>;

/** Built per call so the fetch client binds to the current global fetch (and tests can stub it). */
function stripeClient(env: Env) {
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
}

export type ConnectStatus = "not_connected" | "pending" | "active";

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
    if (!c.env.STRIPE_CONNECT_RETURN_URL || !c.env.STRIPE_CONNECT_REFRESH_URL) {
      console.error("stripe connect urls not configured");
      return c.json({ error: "stripe onboarding is not configured" }, 503);
    }
    const stripe = stripeClient(c.env);

    const net = await c.env.DB.prepare("SELECT stripe_account_id FROM networks WHERE id = ?")
      .bind(networkId)
      .first<{ stripe_account_id: string | null }>();
    if (!net) return c.json({ error: "not found" }, 404);

    let accountId = net.stripe_account_id;
    if (!accountId) {
      // Idempotency key: two concurrent first calls get the same Stripe account back.
      const account = await stripe.accounts.create(
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

    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      return_url: c.env.STRIPE_CONNECT_RETURN_URL,
      refresh_url: c.env.STRIPE_CONNECT_REFRESH_URL,
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
    const charges = r.stripe_charges_enabled === 1;
    const payouts = r.stripe_payouts_enabled === 1;
    const status: ConnectStatus = !r.stripe_account_id ? "not_connected" : charges && payouts ? "active" : "pending";
    return c.json({
      status,
      charges_enabled: charges,
      payouts_enabled: payouts,
      details_submitted: r.stripe_details_submitted === 1,
    });
  },
);

// Public: authenticated by Stripe-Signature only. Bad signature -> 400; unknown events -> 200, ignored.
stripeExpress.post("/stripe/webhook", async (c) => {
  const signature = c.req.header("Stripe-Signature");
  if (!signature || !c.env.STRIPE_WEBHOOK_SECRET) return c.json({ error: "invalid signature" }, 400);
  const payload = await c.req.text(); // raw body: the signature covers the exact bytes

  let event: Stripe.Event;
  try {
    event = await stripeClient(c.env).webhooks.constructEventAsync(
      payload,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return c.json({ error: "invalid signature" }, 400);
  }

  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    // Matched on stripe_account_id only, so an event can never touch another network's row.
    await c.env.DB.prepare(
      `UPDATE networks SET stripe_charges_enabled = ?, stripe_payouts_enabled = ?, stripe_details_submitted = ?,
              updated_at = datetime('now') WHERE stripe_account_id = ?`,
    )
      .bind(account.charges_enabled ? 1 : 0, account.payouts_enabled ? 1 : 0, account.details_submitted ? 1 : 0, account.id)
      .run();
  }
  return c.json({ received: true });
});
