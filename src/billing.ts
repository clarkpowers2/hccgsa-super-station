import { Hono } from "hono";
import type { AppBindings, Env } from "./types";
import { requireAuth } from "./auth";
import { stripePost } from "./stripe";
import { PLATFORM_FEE_PERCENT, splitAmount } from "./fees";
import { MEDIA_POLICY, isMediaKind, signedViewUrl } from "./media";

export const billing = new Hono<AppBindings>();

interface CreatorRow {
  id: string;
  creator_name: string;
  stripe_account_id: string | null;
  stripe_ready: number;
  subscription_price_cents: number | null;
}

async function loadCreator(env: Env, id: string) {
  return env.DB.prepare(
    "SELECT id, creator_name, stripe_account_id, stripe_ready, subscription_price_cents FROM users WHERE id = ? AND is_creator = 1",
  )
    .bind(id)
    .first<CreatorRow>();
}

const canTakePayments = (c: CreatorRow) => c.stripe_ready === 1 && !!c.stripe_account_id;

async function viewerBilling(env: Env, id: string) {
  return env.DB.prepare("SELECT email, stripe_customer_id FROM users WHERE id = ?")
    .bind(id)
    .first<{ email: string; stripe_customer_id: string | null }>();
}

async function hasActiveSubscription(env: Env, viewerId: string, creatorId: string) {
  return (
    (await env.DB.prepare("SELECT 1 AS x FROM subscriptions WHERE viewer_id = ? AND creator_id = ? AND status = 'active'")
      .bind(viewerId, creatorId)
      .first()) !== null
  );
}

async function hasPurchased(env: Env, viewerId: string, episodeId: string) {
  return (
    (await env.DB.prepare("SELECT 1 AS x FROM purchases WHERE viewer_id = ? AND episode_id = ? AND status = 'completed'")
      .bind(viewerId, episodeId)
      .first()) !== null
  );
}

// ---- subscribe -----------------------------------------------------------

billing.post("/subscriptions", requireAuth, async (c) => {
  const viewerId = c.get("user").sub;
  const body = (await c.req.json().catch(() => ({}))) as { creatorId?: unknown };
  if (typeof body.creatorId !== "string") return c.json({ error: "creatorId required" }, 400);
  if (body.creatorId === viewerId) return c.json({ error: "you cannot subscribe to yourself" }, 400);

  const creator = await loadCreator(c.env, body.creatorId);
  if (!creator) return c.json({ error: "creator not found" }, 404);
  if (!creator.subscription_price_cents) return c.json({ error: "creator does not offer subscriptions" }, 409);
  if (!canTakePayments(creator)) return c.json({ error: "creator cannot accept payments yet" }, 409);
  if (await hasActiveSubscription(c.env, viewerId, creator.id)) return c.json({ error: "already subscribed" }, 409);

  const viewer = (await viewerBilling(c.env, viewerId))!;
  const meta = { type: "subscription", viewer_id: viewerId, creator_id: creator.id };
  const session = await stripePost(c.env, "/checkout/sessions", {
    mode: "subscription",
    success_url: `${c.env.APP_URL}/subscriptions/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${c.env.APP_URL}/creators/${creator.id}`,
    client_reference_id: viewerId,
    ...(viewer.stripe_customer_id ? { customer: viewer.stripe_customer_id } : { customer_email: viewer.email }),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: creator.subscription_price_cents,
          recurring: { interval: "month" },
          product_data: { name: `Subscription to ${creator.creator_name}` },
        },
      },
    ],
    subscription_data: {
      application_fee_percent: PLATFORM_FEE_PERCENT,
      transfer_data: { destination: creator.stripe_account_id },
      metadata: meta,
    },
    metadata: meta,
  });
  return c.json({ checkoutUrl: session.url, sessionId: session.id });
});

billing.get("/subscriptions", requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.creator_id, u.creator_name, s.status, s.price_per_month_cents, s.started_at, s.next_billing_date, s.canceled_at
     FROM subscriptions s JOIN users u ON u.id = s.creator_id
     WHERE s.viewer_id = ? ORDER BY s.created_at DESC`,
  )
    .bind(c.get("user").sub)
    .all<Record<string, unknown>>();
  return c.json({
    subscriptions: results.map((r) => ({
      id: r.id,
      creatorId: r.creator_id,
      creatorName: r.creator_name,
      status: r.status,
      pricePerMonthCents: r.price_per_month_cents,
      startedAt: r.started_at,
      nextBillingDate: r.next_billing_date,
      canceledAt: r.canceled_at,
    })),
  });
});

// Cancel at period end (or undo that). Local status follows via webhook.
billing.put("/subscriptions/:id", requireAuth, async (c) => {
  const row = await c.env.DB.prepare("SELECT stripe_subscription_id, status FROM subscriptions WHERE id = ? AND viewer_id = ?")
    .bind(c.req.param("id"), c.get("user").sub)
    .first<{ stripe_subscription_id: string; status: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { cancelAtPeriodEnd?: unknown };
  if (typeof body.cancelAtPeriodEnd !== "boolean") return c.json({ error: "cancelAtPeriodEnd must be a boolean" }, 400);
  if (row.status === "canceled") return c.json({ error: "subscription already ended" }, 409);
  await stripePost(c.env, `/subscriptions/${row.stripe_subscription_id}`, { cancel_at_period_end: body.cancelAtPeriodEnd });
  return c.json({ ok: true, cancelAtPeriodEnd: body.cancelAtPeriodEnd });
});

// ---- one-time purchase ---------------------------------------------------

billing.post("/purchases", requireAuth, async (c) => {
  const viewerId = c.get("user").sub;
  const body = (await c.req.json().catch(() => ({}))) as { episodeId?: unknown };
  if (typeof body.episodeId !== "string") return c.json({ error: "episodeId required" }, 400);

  const ep = await c.env.DB.prepare(
    "SELECT id, creator_id, title, one_time_price_cents FROM episodes WHERE id = ? AND is_published = 1",
  )
    .bind(body.episodeId)
    .first<{ id: string; creator_id: string; title: string; one_time_price_cents: number | null }>();
  if (!ep) return c.json({ error: "episode not found" }, 404);
  if (ep.creator_id === viewerId) return c.json({ error: "you own this episode" }, 400);
  if (!ep.one_time_price_cents) return c.json({ error: "episode is not for sale" }, 409);

  const creator = await loadCreator(c.env, ep.creator_id);
  if (!creator || !canTakePayments(creator)) return c.json({ error: "creator cannot accept payments yet" }, 409);
  if ((await hasPurchased(c.env, viewerId, ep.id)) || (await hasActiveSubscription(c.env, viewerId, ep.creator_id)))
    return c.json({ error: "you already have access" }, 409);

  const viewer = (await viewerBilling(c.env, viewerId))!;
  const meta = { type: "episode", viewer_id: viewerId, episode_id: ep.id, creator_id: ep.creator_id };
  const session = await stripePost(c.env, "/checkout/sessions", {
    mode: "payment",
    success_url: `${c.env.APP_URL}/episodes/${ep.id}?purchased=1`,
    cancel_url: `${c.env.APP_URL}/episodes/${ep.id}`,
    client_reference_id: viewerId,
    ...(viewer.stripe_customer_id ? { customer: viewer.stripe_customer_id } : { customer_email: viewer.email }),
    line_items: [
      {
        quantity: 1,
        price_data: { currency: "usd", unit_amount: ep.one_time_price_cents, product_data: { name: ep.title } },
      },
    ],
    payment_intent_data: {
      application_fee_amount: splitAmount(ep.one_time_price_cents).platformFeeCents,
      transfer_data: { destination: creator.stripe_account_id },
      metadata: meta,
    },
    metadata: meta,
  });
  return c.json({ checkoutUrl: session.url, sessionId: session.id });
});

billing.get("/viewer/purchases", requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.episode_id, e.title, p.amount_cents, p.purchased_at
     FROM purchases p JOIN episodes e ON e.id = p.episode_id
     WHERE p.viewer_id = ? AND p.status = 'completed' ORDER BY p.purchased_at DESC`,
  )
    .bind(c.get("user").sub)
    .all<Record<string, unknown>>();
  return c.json({
    purchases: results.map((r) => ({ id: r.id, episodeId: r.episode_id, title: r.title, amountCents: r.amount_cents, purchasedAt: r.purchased_at })),
  });
});

// ---- paid playback ---------------------------------------------------------

/** Access = the creator, a buyer of this episode, or an active subscriber to the creator. */
export async function hasEpisodeAccess(env: Env, userId: string, ep: { id: string; creator_id: string }) {
  return (
    ep.creator_id === userId ||
    (await hasPurchased(env, userId, ep.id)) ||
    (await hasActiveSubscription(env, userId, ep.creator_id))
  );
}

billing.get("/episodes/:id/stream", requireAuth, async (c) => {
  const userId = c.get("user").sub;
  const ep = await c.env.DB.prepare("SELECT id, creator_id, is_published, video_key, audio_key FROM episodes WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string; creator_id: string; is_published: number; video_key: string | null; audio_key: string | null }>();
  const isOwner = ep?.creator_id === userId;
  if (!ep || (!ep.is_published && !isOwner)) return c.json({ error: "not found" }, 404);

  if (!(await hasEpisodeAccess(c.env, userId, ep))) return c.json({ error: "purchase or subscription required" }, 403);

  const requested = c.req.query("kind");
  if (requested !== undefined && (!isMediaKind(requested) || requested === "thumbnail"))
    return c.json({ error: "kind must be video or audio" }, 400);
  const kind = (requested as "video" | "audio" | undefined) ?? (ep.video_key ? "video" : "audio");
  const key = ep[MEDIA_POLICY[kind].column as "video_key" | "audio_key"];
  if (!key) return c.json({ error: "no file available" }, 404);

  const url = await signedViewUrl(c.env, key, 60 * 60);
  if (!url) return c.json({ error: "storage not configured" }, 503);
  if (!isOwner) await c.env.DB.prepare("UPDATE episodes SET view_count = view_count + 1 WHERE id = ?").bind(ep.id).run();
  return c.json({ url, kind, expiresInSeconds: 60 * 60 });
});

// The full transcript is the paid content in text form, so it follows the same access rule as playback.
// Summary, tags and quotes are public (see GET /api/episodes/:id).
billing.get("/episodes/:id/transcript", requireAuth, async (c) => {
  const userId = c.get("user").sub;
  const ep = await c.env.DB.prepare("SELECT id, creator_id, is_published, transcript_text FROM episodes WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string; creator_id: string; is_published: number; transcript_text: string | null }>();
  if (!ep || (!ep.is_published && ep.creator_id !== userId)) return c.json({ error: "not found" }, 404);
  if (!(await hasEpisodeAccess(c.env, userId, ep))) return c.json({ error: "purchase or subscription required" }, 403);
  if (!ep.transcript_text) return c.json({ error: "transcript not available" }, 404);
  return c.json({ transcript: ep.transcript_text });
});
