import { afterEach, describe, expect, it, vi } from "vitest";
import { all, call, makeEnv, mockStripe, one, postWebhook, registerCreator, run } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const T0 = 1_760_000_000;

async function register(env: any, email: string) {
  const r = await call(env, "POST", "/api/auth/register", { body: { email, password: "a-long-test-password", creatorName: email.split("@")[0] } });
  return { token: r.json.token as string, id: r.json.id as string };
}

/** A creator who finished Stripe onboarding, offers a $5 subscription, and has one published $4.99 episode. */
async function world() {
  const t = makeEnv();
  const creator = await registerCreator(t.env, "creator@example.com");
  await run(t.env, "UPDATE users SET stripe_account_id='acct_creator', stripe_ready=1, subscription_price_cents=500 WHERE id=?", creator.id);
  const ep = await call(t.env, "POST", "/api/creator/episodes", { token: creator.token, body: { title: "Pilot", oneTimePriceCents: 499 } });
  await run(t.env, "UPDATE episodes SET video_key='k/video.mp4', is_published=1, publish_date=datetime('now') WHERE id=?", ep.json.id);
  const viewer = await register(t.env, "viewer@example.com");
  return { ...t, creator, viewer, episodeId: ep.json.id as string };
}

const episodePaid = (w: any, id = "evt_ep1", pi = "pi_1", amount = 499) => ({
  id,
  type: "checkout.session.completed",
  created: T0,
  data: {
    object: {
      id: "cs_1",
      mode: "payment",
      payment_status: "paid",
      payment_intent: pi,
      amount_total: amount,
      customer: "cus_1",
      metadata: { type: "episode", viewer_id: w.viewer.id, episode_id: w.episodeId, creator_id: w.creator.id },
    },
  },
});

const subMeta = (w: any) => ({ type: "subscription", viewer_id: w.viewer.id, creator_id: w.creator.id });
const subCompleted = (w: any, id = "evt_sc1") => ({
  id,
  type: "checkout.session.completed",
  created: T0,
  data: { object: { id: "cs_2", mode: "subscription", payment_status: "paid", subscription: "sub_1", amount_total: 500, customer: "cus_1", metadata: subMeta(w) } },
});
const invoicePaid = (w: any, id = "evt_inv1", invoiceId = "in_1", paidAt = T0 + 100) => ({
  id,
  type: "invoice.paid",
  created: T0 + 100,
  data: {
    object: {
      id: invoiceId,
      subscription: "sub_1",
      amount_paid: 500,
      application_fee_amount: 100,
      status_transitions: { paid_at: paidAt },
      subscription_details: { metadata: subMeta(w) },
    },
  },
});
const subEvent = (w: any, type: string, status: string, id: string) => ({
  id,
  type,
  created: T0 + 200,
  data: { object: { id: "sub_1", status, metadata: subMeta(w), start_date: T0, current_period_end: T0 + 2_592_000, items: { data: [{ price: { unit_amount: 500 } }] } } },
});

const stream = (w: any, token?: string, qs = "") => call(w.env, "GET", `/api/episodes/${w.episodeId}/stream${qs}`, { token });

describe("Stripe Connect onboarding", () => {
  it("creates one Express account (monthly payouts) and returns a hosted onboarding link", async () => {
    const w = await world();
    await run(w.env, "UPDATE users SET stripe_account_id=NULL, stripe_ready=0 WHERE id=?", w.creator.id);
    const calls = mockStripe();

    const r = await call(w.env, "POST", "/api/creator/connect/onboarding", { token: w.creator.token });
    expect(r.status).toBe(200);
    expect(r.json.url).toBe("https://connect.test/onboard");

    const acct = calls.find((c) => c.path === "/accounts")!;
    expect(acct.params).toMatchObject({
      type: "express",
      "capabilities[transfers][requested]": "true",
      "settings[payouts][schedule][interval]": "monthly",
      "settings[payouts][schedule][monthly_anchor]": "1",
      "metadata[creator_id]": w.creator.id,
    });
    expect(acct.headers["Idempotency-Key"]).toBe(`acct_${w.creator.id}`);
    expect(acct.headers["Stripe-Version"]).toBeTruthy();
    expect(calls.find((c) => c.path === "/account_links")!.params).toMatchObject({ account: "acct_test1", type: "account_onboarding" });

    await call(w.env, "POST", "/api/creator/connect/onboarding", { token: w.creator.token });
    expect(calls.filter((c) => c.path === "/accounts")).toHaveLength(1); // account reused
  });

  it("marks a creator ready only when transfers, payouts and details are all complete", async () => {
    const w = await world();
    await run(w.env, "UPDATE users SET stripe_ready=0 WHERE id=?", w.creator.id);
    const account = (over: object) => ({
      id: "evt_a" + Math.random(),
      type: "account.updated",
      created: T0,
      account: "acct_creator",
      data: { object: { id: "acct_creator", details_submitted: true, payouts_enabled: true, capabilities: { transfers: "active" }, ...over } },
    });
    await postWebhook(w.env, "stripe-connect", account({ capabilities: { transfers: "inactive" } }));
    expect((await call(w.env, "GET", "/api/creator/connect/status", { token: w.creator.token })).json.readyForPayments).toBe(false);
    await postWebhook(w.env, "stripe-connect", account({}));
    expect((await call(w.env, "GET", "/api/creator/connect/status", { token: w.creator.token })).json).toMatchObject({ started: true, readyForPayments: true });
  });

  it("is creator-only", async () => {
    const w = await world();
    mockStripe();
    expect((await call(w.env, "POST", "/api/creator/connect/onboarding", { token: w.viewer.token })).status).toBe(403);
  });
});

describe("subscription checkout", () => {
  it("creates a destination-charge checkout with a 20% application fee", async () => {
    const w = await world();
    const calls = mockStripe();
    const r = await call(w.env, "POST", "/api/subscriptions", { token: w.viewer.token, body: { creatorId: w.creator.id } });
    expect(r.status).toBe(200);
    expect(r.json.checkoutUrl).toBe("https://checkout.test/cs_test1");
    expect(calls[0]!.params).toMatchObject({
      mode: "subscription",
      customer_email: "viewer@example.com",
      "line_items[0][price_data][unit_amount]": "500",
      "line_items[0][price_data][recurring][interval]": "month",
      "subscription_data[application_fee_percent]": "20",
      "subscription_data[transfer_data][destination]": "acct_creator",
      "subscription_data[metadata][viewer_id]": w.viewer.id,
      "subscription_data[metadata][creator_id]": w.creator.id,
      "subscription_data[metadata][type]": "subscription",
    });
    expect(JSON.stringify(calls)).not.toContain("password");
  });

  it("refuses self-subscription, unknown creators, no-price, not-ready, and duplicates", async () => {
    const w = await world();
    mockStripe();
    const sub = (token: string, creatorId: string) => call(w.env, "POST", "/api/subscriptions", { token, body: { creatorId } });
    expect((await sub(w.creator.token, w.creator.id)).status).toBe(400);
    expect((await sub(w.viewer.token, "nope")).status).toBe(404);
    const otherViewer = await register(w.env, "plain@example.com");
    expect((await sub(w.viewer.token, otherViewer.id)).status).toBe(404); // viewers are not creators
    await run(w.env, "UPDATE users SET stripe_ready=0 WHERE id=?", w.creator.id);
    expect((await sub(w.viewer.token, w.creator.id)).status).toBe(409);
    await run(w.env, "UPDATE users SET stripe_ready=1, subscription_price_cents=NULL WHERE id=?", w.creator.id);
    expect((await sub(w.viewer.token, w.creator.id)).status).toBe(409);
    await run(w.env, "UPDATE users SET subscription_price_cents=500 WHERE id=?", w.creator.id);
    await postWebhook(w.env, "stripe", subCompleted(w));
    expect((await sub(w.viewer.token, w.creator.id)).status).toBe(409); // already subscribed
    expect((await call(w.env, "POST", "/api/subscriptions", { body: { creatorId: w.creator.id } })).status).toBe(401);
  });

  it("lets a creator set and clear their subscription price with validation", async () => {
    const w = await world();
    const put = (v: unknown) => call(w.env, "PUT", "/api/creator/profile", { token: w.creator.token, body: { subscriptionPriceCents: v } });
    expect((await put(999)).status).toBe(200);
    expect((await call(w.env, "GET", "/api/creator/profile", { token: w.creator.token })).json.subscriptionPriceCents).toBe(999);
    expect((await put(50)).status).toBe(400);
    expect((await put(9.5)).status).toBe(400);
    expect((await put(null)).status).toBe(200);
  });
});

describe("subscription lifecycle via webhooks", () => {
  it("activates, records 80/20 revenue, grants access, then revokes on cancellation", async () => {
    const w = await world();
    expect((await stream(w, w.viewer.token)).status).toBe(403);

    expect((await postWebhook(w.env, "stripe", subCompleted(w))).status).toBe(200);
    expect((await postWebhook(w.env, "stripe", invoicePaid(w))).status).toBe(200);

    const subs = await call(w.env, "GET", "/api/subscriptions", { token: w.viewer.token });
    expect(subs.json.subscriptions[0]).toMatchObject({ status: "active", pricePerMonthCents: 500, creatorId: w.creator.id });
    expect(await one(w.env, "SELECT stripe_customer_id AS c FROM users WHERE id=?", w.viewer.id)).toEqual({ c: "cus_1" });

    const rev = await one<any>(w.env, "SELECT * FROM revenue WHERE stripe_object_id='in_1'");
    expect(rev).toMatchObject({ gross_cents: 500, platform_fee_cents: 100, creator_cents: 400, source: "subscription", creator_id: w.creator.id });

    expect((await stream(w, w.viewer.token)).status).toBe(200);
    const subscribers = await call(w.env, "GET", "/api/creator/subscribers", { token: w.creator.token });
    expect(subscribers.json).toMatchObject({ activeCount: 1, monthlyGrossCents: 500 });

    await postWebhook(w.env, "stripe", subEvent(w, "customer.subscription.updated", "past_due", "evt_pd"));
    expect((await stream(w, w.viewer.token)).status).toBe(403);
    await postWebhook(w.env, "stripe", subEvent(w, "customer.subscription.updated", "active", "evt_ok"));
    expect((await stream(w, w.viewer.token)).status).toBe(200);

    await postWebhook(w.env, "stripe", subEvent(w, "customer.subscription.deleted", "canceled", "evt_del"));
    expect((await stream(w, w.viewer.token)).status).toBe(403);
    // A late, out-of-order 'active' must not revive a deleted subscription.
    await postWebhook(w.env, "stripe", subEvent(w, "customer.subscription.updated", "active", "evt_late"));
    expect((await stream(w, w.viewer.token)).status).toBe(403);
    expect((await one<any>(w.env, "SELECT status, canceled_at FROM subscriptions")).canceled_at).toBeTruthy();
  });

  it("handles invoice.paid arriving before checkout.session.completed", async () => {
    const w = await world();
    await postWebhook(w.env, "stripe", invoicePaid(w));
    await postWebhook(w.env, "stripe", subCompleted(w));
    expect(await all(w.env, "SELECT * FROM revenue")).toHaveLength(1);
    expect(await all(w.env, "SELECT * FROM subscriptions")).toHaveLength(1);
  });

  it("is idempotent for replayed events and re-sent invoices", async () => {
    const w = await world();
    await postWebhook(w.env, "stripe", subCompleted(w));
    const first = await postWebhook(w.env, "stripe", invoicePaid(w));
    const replay = await postWebhook(w.env, "stripe", invoicePaid(w)); // same event id
    const resent = await postWebhook(w.env, "stripe", invoicePaid(w, "evt_other", "in_1")); // new event, same invoice
    expect(first.json.duplicate).toBeUndefined();
    expect(replay.json.duplicate).toBe(true);
    expect(resent.status).toBe(200);
    expect(await all(w.env, "SELECT * FROM revenue")).toHaveLength(1);
    // A second month's invoice is a second revenue row.
    await postWebhook(w.env, "stripe", invoicePaid(w, "evt_inv2", "in_2", T0 + 2_592_000));
    expect(await all(w.env, "SELECT * FROM revenue")).toHaveLength(2);
  });

  it("cancels at period end through Stripe, only for the owner", async () => {
    const w = await world();
    await postWebhook(w.env, "stripe", subCompleted(w));
    const id = (await one<{ id: string }>(w.env, "SELECT id FROM subscriptions"))!.id;
    const calls = mockStripe();
    const other = await register(w.env, "other@example.com");
    expect((await call(w.env, "PUT", `/api/subscriptions/${id}`, { token: other.token, body: { cancelAtPeriodEnd: true } })).status).toBe(404);
    expect((await call(w.env, "PUT", `/api/subscriptions/${id}`, { token: w.viewer.token, body: { cancelAtPeriodEnd: "yes" } })).status).toBe(400);
    expect((await call(w.env, "PUT", `/api/subscriptions/${id}`, { token: w.viewer.token, body: { cancelAtPeriodEnd: true } })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/subscriptions/sub_1", params: { cancel_at_period_end: "true" } });
  });
});

describe("one-time purchase", () => {
  it("creates a destination-charge checkout with an exact application fee", async () => {
    const w = await world();
    const calls = mockStripe();
    const r = await call(w.env, "POST", "/api/purchases", { token: w.viewer.token, body: { episodeId: w.episodeId } });
    expect(r.status).toBe(200);
    expect(calls[0]!.params).toMatchObject({
      mode: "payment",
      "line_items[0][price_data][unit_amount]": "499",
      "payment_intent_data[application_fee_amount]": "100",
      "payment_intent_data[transfer_data][destination]": "acct_creator",
      "payment_intent_data[metadata][episode_id]": w.episodeId,
      "metadata[type]": "episode",
    });
  });

  it("refuses unpublished, free, own, not-ready, and already-owned episodes", async () => {
    const w = await world();
    mockStripe();
    const buy = (token: string, episodeId = w.episodeId) => call(w.env, "POST", "/api/purchases", { token, body: { episodeId } });
    expect((await buy(w.viewer.token, "nope")).status).toBe(404);
    expect((await buy(w.creator.token)).status).toBe(400);
    await run(w.env, "UPDATE episodes SET one_time_price_cents=NULL WHERE id=?", w.episodeId);
    expect((await buy(w.viewer.token)).status).toBe(409);
    await run(w.env, "UPDATE episodes SET one_time_price_cents=499 WHERE id=?", w.episodeId);
    await run(w.env, "UPDATE users SET stripe_ready=0 WHERE id=?", w.creator.id);
    expect((await buy(w.viewer.token)).status).toBe(409);
    await run(w.env, "UPDATE users SET stripe_ready=1 WHERE id=?", w.creator.id);
    await run(w.env, "UPDATE episodes SET is_published=0 WHERE id=?", w.episodeId);
    expect((await buy(w.viewer.token)).status).toBe(404);
    await run(w.env, "UPDATE episodes SET is_published=1 WHERE id=?", w.episodeId);
    await postWebhook(w.env, "stripe", episodePaid(w));
    expect((await buy(w.viewer.token)).status).toBe(409); // already purchased
  });

  it("grants access after payment, records the split, and is idempotent", async () => {
    const w = await world();
    expect((await stream(w, w.viewer.token)).status).toBe(403);

    expect((await postWebhook(w.env, "stripe", episodePaid(w))).status).toBe(200);
    expect((await postWebhook(w.env, "stripe", episodePaid(w))).json.duplicate).toBe(true);
    await postWebhook(w.env, "stripe", { ...episodePaid(w, "evt_async"), type: "checkout.session.async_payment_succeeded" }); // same payment, new event

    expect(await all(w.env, "SELECT * FROM purchases")).toHaveLength(1);
    expect(await all(w.env, "SELECT * FROM revenue")).toHaveLength(1);
    expect(await one(w.env, "SELECT gross_cents g, platform_fee_cents f, creator_cents c FROM revenue")).toEqual({ g: 499, f: 100, c: 399 });

    const list = await call(w.env, "GET", "/api/viewer/purchases", { token: w.viewer.token });
    expect(list.json.purchases).toMatchObject([{ episodeId: w.episodeId, amountCents: 499 }]);

    const s = await stream(w, w.viewer.token);
    expect(s.status).toBe(200);
    expect(new URL(s.json.url).pathname).toBe("/testbucket/k/video.mp4");
    expect(s.json.expiresInSeconds).toBe(3600);
    expect((await one<any>(w.env, "SELECT view_count v FROM episodes")).v).toBe(1);

    const earnings = await call(w.env, "GET", "/api/creator/earnings", { token: w.creator.token });
    expect(earnings.json.lifetime).toEqual({ grossCents: 499, platformFeeCents: 100, creatorCents: 399 });
    expect(earnings.json.months).toMatchObject([{ month: "2025-10", charges: 1, grossCents: 499 }]);
  });

  it("ignores unpaid sessions and sessions for unknown episodes without failing the webhook", async () => {
    const w = await world();
    const unpaid = episodePaid(w, "evt_unpaid");
    unpaid.data.object.payment_status = "unpaid";
    expect((await postWebhook(w.env, "stripe", unpaid)).status).toBe(200);
    const ghost = episodePaid(w, "evt_ghost", "pi_ghost");
    ghost.data.object.metadata.episode_id = "does-not-exist";
    expect((await postWebhook(w.env, "stripe", ghost)).status).toBe(200);
    expect(await all(w.env, "SELECT * FROM purchases")).toHaveLength(0);
    expect(await all(w.env, "SELECT * FROM revenue")).toHaveLength(0);
  });
});

describe("paid playback", () => {
  it("requires login, hides drafts, validates kind, and never counts owner views", async () => {
    const w = await world();
    expect((await stream(w)).status).toBe(401);
    expect((await stream(w, w.creator.token)).status).toBe(200); // owner
    expect((await one<any>(w.env, "SELECT view_count v FROM episodes")).v).toBe(0);
    expect((await stream(w, w.creator.token, "?kind=thumbnail")).status).toBe(400);
    expect((await stream(w, w.creator.token, "?kind=audio")).status).toBe(404); // none uploaded
    await run(w.env, "UPDATE episodes SET is_published=0 WHERE id=?", w.episodeId);
    expect((await stream(w, w.viewer.token)).status).toBe(404);
  });

  it("does not let a purchase of one episode unlock another", async () => {
    const w = await world();
    const ep2 = await call(w.env, "POST", "/api/creator/episodes", { token: w.creator.token, body: { title: "Two" } });
    await run(w.env, "UPDATE episodes SET video_key='k/two.mp4', is_published=1 WHERE id=?", ep2.json.id);
    await postWebhook(w.env, "stripe", episodePaid(w));
    expect((await call(w.env, "GET", `/api/episodes/${ep2.json.id}/stream`, { token: w.viewer.token })).status).toBe(403);
  });
});

describe("payouts", () => {
  const payout = (type: string, id: string, extra: object = {}) => ({
    id,
    type,
    created: T0 + 5_000_000,
    account: "acct_creator",
    data: { object: { id: "po_1", amount: 12345, currency: "usd", arrival_date: T0 + 5_000_000, ...extra } },
  });

  it("records paid and failed payouts reported by Stripe and lists them", async () => {
    const w = await world();
    await postWebhook(w.env, "stripe-connect", payout("payout.failed", "evt_pf"));
    expect((await call(w.env, "GET", "/api/creator/payouts", { token: w.creator.token })).json.payouts[0]).toMatchObject({ id: "po_1", status: "failed", amountCents: 12345 });
    await postWebhook(w.env, "stripe-connect", payout("payout.paid", "evt_pp"));
    const list = (await call(w.env, "GET", "/api/creator/payouts", { token: w.creator.token })).json.payouts;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "paid", amountCents: 12345, currency: "usd" });
    expect(list[0].paidAt).toBeTruthy();
  });

  it("ignores payouts for accounts that are not ours", async () => {
    const w = await world();
    const e = payout("payout.paid", "evt_foreign");
    e.account = "acct_stranger";
    expect((await postWebhook(w.env, "stripe-connect", e)).status).toBe(200);
    expect(await all(w.env, "SELECT * FROM payouts")).toHaveLength(0);
  });
});

describe("webhook security", () => {
  it("rejects missing, forged, wrong-endpoint, and stale signatures", async () => {
    const w = await world();
    const evt = episodePaid(w);
    expect((await postWebhook(w.env, "stripe", evt, { header: null })).status).toBe(400);
    expect((await postWebhook(w.env, "stripe", evt, { secret: "attacker-guess" })).status).toBe(400);
    expect((await postWebhook(w.env, "stripe", evt, { secret: w.env.STRIPE_CONNECT_WEBHOOK_SECRET })).status).toBe(400); // connect secret on platform endpoint
    expect((await postWebhook(w.env, "stripe", evt, { t: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(400);
    expect(await all(w.env, "SELECT * FROM purchases")).toHaveLength(0); // nothing was applied
    expect(await all(w.env, "SELECT * FROM stripe_events")).toHaveLength(0);
  });

  it("rejects everything when the webhook secret is not configured", async () => {
    const w = await world();
    const env = { ...w.env, STRIPE_WEBHOOK_SECRET: "" };
    expect((await postWebhook(env, "stripe", episodePaid(w), { secret: "" })).status).toBe(400);
  });

  it("acknowledges event types it does not handle", async () => {
    const w = await world();
    expect((await postWebhook(w.env, "stripe", { id: "evt_x", type: "customer.created", created: T0, data: { object: {} } })).status).toBe(200);
  });

  it("rejects malformed JSON with a valid signature", async () => {
    const w = await world();
    const bad = await postWebhook(w.env, "stripe", { not: "an event" });
    expect(bad.status).toBe(400);
  });
});

describe("Stripe API failures", () => {
  it("returns a generic 502 that does not leak provider details", async () => {
    const w = await world();
    mockStripe({ "/checkout/sessions": () => ({ __error: { message: "No such price: secret_detail_xyz", code: "resource_missing" } }) });
    const r = await call(w.env, "POST", "/api/purchases", { token: w.viewer.token, body: { episodeId: w.episodeId } });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).not.toContain("secret_detail_xyz");
  });
});
