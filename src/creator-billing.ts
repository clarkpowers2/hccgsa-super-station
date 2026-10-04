import { Hono } from "hono";
import type { AppBindings } from "./types";
import { requireAuth, requireCreator } from "./auth";
import { stripePost } from "./stripe";

export const creatorBilling = new Hono<AppBindings>();
creatorBilling.use("*", requireAuth, requireCreator);

// Stripe Connect Express onboarding. Creators enter bank/identity details on Stripe's
// hosted pages; we never see or store them.
creatorBilling.post("/connect/onboarding", async (c) => {
  const userId = c.get("user").sub;
  const body = (await c.req.json().catch(() => ({}))) as { country?: unknown };
  const country = typeof body.country === "string" && /^[A-Za-z]{2}$/.test(body.country) ? body.country.toUpperCase() : "US";

  const user = (await c.env.DB.prepare("SELECT email, stripe_account_id FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email: string; stripe_account_id: string | null }>())!;

  let accountId = user.stripe_account_id;
  if (!accountId) {
    const account = await stripePost(
      c.env,
      "/accounts",
      {
        type: "express",
        country,
        email: user.email,
        capabilities: { transfers: { requested: true } },
        settings: { payouts: { schedule: { interval: "monthly", monthly_anchor: 1 } } },
        metadata: { creator_id: userId },
      },
      { idempotencyKey: `acct_${userId}` }, // a double-click cannot create two accounts
    );
    accountId = account.id as string;
    await c.env.DB.prepare("UPDATE users SET stripe_account_id = ? WHERE id = ?").bind(accountId, userId).run();
  }

  const link = await stripePost(c.env, "/account_links", {
    account: accountId,
    type: "account_onboarding",
    refresh_url: `${c.env.APP_URL}/dashboard/payouts?refresh=1`,
    return_url: `${c.env.APP_URL}/dashboard/payouts?connected=1`,
  });
  return c.json({ url: link.url });
});

creatorBilling.get("/connect/status", async (c) => {
  const r = await c.env.DB.prepare("SELECT stripe_account_id, stripe_details_submitted, stripe_ready FROM users WHERE id = ?")
    .bind(c.get("user").sub)
    .first<{ stripe_account_id: string | null; stripe_details_submitted: number; stripe_ready: number }>();
  return c.json({
    started: !!r?.stripe_account_id,
    detailsSubmitted: r?.stripe_details_submitted === 1,
    readyForPayments: r?.stripe_ready === 1,
  });
});

creatorBilling.get("/earnings", async (c) => {
  const id = c.get("user").sub;
  const { results } = await c.env.DB.prepare(
    `SELECT substr(occurred_at, 1, 7) AS month, COUNT(*) AS charges, SUM(gross_cents) AS gross,
            SUM(platform_fee_cents) AS fee, SUM(creator_cents) AS creator
     FROM revenue WHERE creator_id = ? GROUP BY month ORDER BY month DESC`,
  )
    .bind(id)
    .all<{ month: string; charges: number; gross: number; fee: number; creator: number }>();
  const months = results.map((r) => ({
    month: r.month,
    charges: r.charges,
    grossCents: r.gross,
    platformFeeCents: r.fee,
    creatorCents: r.creator,
  }));
  const sum = (k: "grossCents" | "platformFeeCents" | "creatorCents") => months.reduce((a, m) => a + m[k], 0);
  return c.json({
    lifetime: { grossCents: sum("grossCents"), platformFeeCents: sum("platformFeeCents"), creatorCents: sum("creatorCents") },
    months,
  });
});

creatorBilling.get("/payouts", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT stripe_payout_id, amount_cents, currency, status, arrival_date, paid_at FROM payouts WHERE creator_id = ? ORDER BY created_at DESC",
  )
    .bind(c.get("user").sub)
    .all<Record<string, unknown>>();
  return c.json({
    payouts: results.map((r) => ({
      id: r.stripe_payout_id,
      amountCents: r.amount_cents,
      currency: r.currency,
      status: r.status,
      arrivalDate: r.arrival_date,
      paidAt: r.paid_at,
    })),
  });
});

creatorBilling.get("/subscribers", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, u.creator_name AS viewer_name, s.price_per_month_cents, s.started_at
     FROM subscriptions s JOIN users u ON u.id = s.viewer_id
     WHERE s.creator_id = ? AND s.status = 'active' ORDER BY s.started_at DESC`,
  )
    .bind(c.get("user").sub)
    .all<{ id: string; viewer_name: string; price_per_month_cents: number; started_at: string }>();
  return c.json({
    activeCount: results.length,
    monthlyGrossCents: results.reduce((a, r) => a + r.price_per_month_cents, 0),
    subscribers: results.map((r) => ({ subscriptionId: r.id, name: r.viewer_name, since: r.started_at })),
  });
});
