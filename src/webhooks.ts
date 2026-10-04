import { Hono } from "hono";
import type { AppBindings, Env } from "./types";
import { verifyStripeSignature } from "./stripe";
import { splitAmount, sqlTime } from "./fees";

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  account?: string; // set on events from connected accounts
  data: { object: any };
}

type Handler = (env: Env, event: StripeEvent) => Promise<void>;

const mapStatus = (s: string) =>
  s === "active" || s === "trialing" ? "active" : s === "past_due" ? "past_due" : s === "canceled" || s === "incomplete_expired" ? "canceled" : "unpaid";

/**
 * Insert or update a local subscription. `canceled` is terminal: Stripe does not
 * guarantee event order, so a late 'updated' must never revive a deleted subscription.
 */
async function upsertSubscription(
  env: Env,
  s: { viewerId: string; creatorId: string; stripeSubId: string; status: string; priceCents: number; startedAt: number; nextBilling?: number },
  opts: { overwrite: boolean },
) {
  const conflict = opts.overwrite
    ? `DO UPDATE SET status = excluded.status,
         next_billing_date = COALESCE(excluded.next_billing_date, subscriptions.next_billing_date),
         canceled_at = CASE WHEN excluded.status = 'canceled' THEN datetime('now') ELSE subscriptions.canceled_at END,
         updated_at = datetime('now')
       WHERE subscriptions.status != 'canceled'`
    : "DO NOTHING";
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, viewer_id, creator_id, stripe_subscription_id, status, price_per_month_cents, started_at, next_billing_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stripe_subscription_id) ${conflict}`,
  )
    .bind(
      crypto.randomUUID(),
      s.viewerId,
      s.creatorId,
      s.stripeSubId,
      s.status,
      s.priceCents,
      sqlTime(s.startedAt),
      s.nextBilling ? sqlTime(s.nextBilling) : null,
    )
    .run();
}

async function recordRevenue(
  env: Env,
  r: { creatorId: string; viewerId: string | null; source: "subscription" | "purchase"; objectId: string; gross: number; fee: number; at: number },
) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO revenue (id, creator_id, viewer_id, source, stripe_object_id, gross_cents, platform_fee_cents, creator_cents, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), r.creatorId, r.viewerId, r.source, r.objectId, r.gross, r.fee, r.gross - r.fee, sqlTime(r.at))
    .run();
}

async function userExists(env: Env, id: string | undefined) {
  if (!id) return false;
  return (await env.DB.prepare("SELECT 1 AS x FROM users WHERE id = ?").bind(id).first()) !== null;
}

async function onCheckoutCompleted(env: Env, event: StripeEvent) {
  const s = event.data.object;
  const meta = s.metadata ?? {};

  if (meta.type === "episode") {
    if (s.payment_status !== "paid" || !s.payment_intent) return;
    const episode = await env.DB.prepare("SELECT id, creator_id FROM episodes WHERE id = ?")
      .bind(meta.episode_id)
      .first<{ id: string; creator_id: string }>();
    if (!episode || !(await userExists(env, meta.viewer_id))) {
      console.error("checkout for unknown episode/viewer", event.id);
      return; // nothing we can attach it to; don't make Stripe retry forever
    }
    const gross = s.amount_total as number;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO purchases (id, viewer_id, episode_id, stripe_payment_intent_id, amount_cents, status, purchased_at)
       VALUES (?, ?, ?, ?, ?, 'completed', datetime('now'))`,
    )
      .bind(crypto.randomUUID(), meta.viewer_id, episode.id, s.payment_intent, gross)
      .run();
    await recordRevenue(env, {
      creatorId: episode.creator_id,
      viewerId: meta.viewer_id,
      source: "purchase",
      objectId: s.payment_intent,
      gross,
      fee: splitAmount(gross).platformFeeCents,
      at: event.created,
    });
    return;
  }

  if (meta.type === "subscription" && s.subscription) {
    if (!(await userExists(env, meta.viewer_id)) || !(await userExists(env, meta.creator_id))) {
      console.error("checkout for unknown viewer/creator", event.id);
      return;
    }
    await upsertSubscription(
      env,
      {
        viewerId: meta.viewer_id,
        creatorId: meta.creator_id,
        stripeSubId: s.subscription,
        status: "active",
        priceCents: s.amount_total,
        startedAt: event.created,
      },
      { overwrite: false },
    );
    if (s.customer) {
      await env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").bind(s.customer, meta.viewer_id).run();
    }
  }
}

async function onInvoicePaid(env: Env, event: StripeEvent) {
  const inv = event.data.object;
  const meta = inv.subscription_details?.metadata ?? {};
  if (!inv.subscription || meta.type !== "subscription" || !(inv.amount_paid > 0)) return;
  if (!(await userExists(env, meta.creator_id))) {
    console.error("invoice for unknown creator", event.id);
    return;
  }
  const gross = inv.amount_paid as number;
  // Prefer the fee Stripe actually applied; fall back to our own calculation.
  const fee = typeof inv.application_fee_amount === "number" ? inv.application_fee_amount : splitAmount(gross).platformFeeCents;
  await recordRevenue(env, {
    creatorId: meta.creator_id,
    viewerId: (await userExists(env, meta.viewer_id)) ? meta.viewer_id : null,
    source: "subscription",
    objectId: inv.id,
    gross,
    fee,
    at: inv.status_transitions?.paid_at ?? event.created,
  });
}

async function onSubscriptionChanged(env: Env, event: StripeEvent) {
  const sub = event.data.object;
  const meta = sub.metadata ?? {};
  if (meta.type !== "subscription") return;
  if (!(await userExists(env, meta.viewer_id)) || !(await userExists(env, meta.creator_id))) return;
  const status = event.type === "customer.subscription.deleted" ? "canceled" : mapStatus(sub.status);
  await upsertSubscription(
    env,
    {
      viewerId: meta.viewer_id,
      creatorId: meta.creator_id,
      stripeSubId: sub.id,
      status,
      priceCents: sub.items?.data?.[0]?.price?.unit_amount ?? 0,
      startedAt: sub.start_date ?? event.created,
      nextBilling: status === "canceled" ? undefined : sub.current_period_end,
    },
    { overwrite: true },
  );
}

const platformHandlers: Record<string, Handler> = {
  "checkout.session.completed": onCheckoutCompleted,
  "checkout.session.async_payment_succeeded": onCheckoutCompleted,
  "invoice.paid": onInvoicePaid,
  "customer.subscription.updated": onSubscriptionChanged,
  "customer.subscription.deleted": onSubscriptionChanged,
};

async function onAccountUpdated(env: Env, event: StripeEvent) {
  const a = event.data.object;
  const ready = a.capabilities?.transfers === "active" && a.payouts_enabled === true && a.details_submitted === true;
  await env.DB.prepare("UPDATE users SET stripe_details_submitted = ?, stripe_ready = ? WHERE stripe_account_id = ?")
    .bind(a.details_submitted ? 1 : 0, ready ? 1 : 0, a.id)
    .run();
}

async function onPayout(env: Env, event: StripeEvent) {
  const p = event.data.object;
  const owner = event.account
    ? await env.DB.prepare("SELECT id FROM users WHERE stripe_account_id = ?").bind(event.account).first<{ id: string }>()
    : null;
  if (!owner) return; // not one of our creators
  const status = event.type === "payout.paid" ? "paid" : "failed";
  await env.DB.prepare(
    `INSERT INTO payouts (id, creator_id, stripe_payout_id, amount_cents, currency, status, arrival_date, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stripe_payout_id) DO UPDATE SET status = excluded.status, paid_at = excluded.paid_at`,
  )
    .bind(
      crypto.randomUUID(),
      owner.id,
      p.id,
      p.amount,
      p.currency ?? "usd",
      status,
      p.arrival_date ? sqlTime(p.arrival_date) : null,
      status === "paid" ? sqlTime(event.created) : null,
    )
    .run();
}

const connectHandlers: Record<string, Handler> = {
  "account.updated": onAccountUpdated,
  "payout.paid": onPayout,
  "payout.failed": onPayout,
};

function receiver(secretOf: (env: Env) => string, handlers: Record<string, Handler>) {
  return async (c: any) => {
    const payload = await c.req.text(); // raw body: signature covers exact bytes
    if (!(await verifyStripeSignature(payload, c.req.header("Stripe-Signature"), secretOf(c.env)))) {
      return c.json({ error: "invalid signature" }, 400);
    }
    let event: StripeEvent;
    try {
      event = JSON.parse(payload);
    } catch {
      return c.json({ error: "invalid payload" }, 400);
    }
    if (!event?.id || !event?.type) return c.json({ error: "invalid event" }, 400);

    const seen = await c.env.DB.prepare("SELECT 1 AS x FROM stripe_events WHERE id = ?").bind(event.id).first();
    if (seen) return c.json({ received: true, duplicate: true });

    const handler = handlers[event.type];
    if (handler) await handler(c.env, event); // throws -> 500 -> Stripe retries; handlers are idempotent
    await c.env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, type) VALUES (?, ?)").bind(event.id, event.type).run();
    return c.json({ received: true });
  };
}

export const webhooks = new Hono<AppBindings>();
webhooks.post("/stripe", receiver((e) => e.STRIPE_WEBHOOK_SECRET, platformHandlers));
webhooks.post("/stripe-connect", receiver((e) => e.STRIPE_CONNECT_WEBHOOK_SECRET, connectHandlers));
