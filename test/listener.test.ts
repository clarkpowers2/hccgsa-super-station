import { afterEach, describe, expect, it, vi } from "vitest";
import { call, makeEnv, one, postWebhook, registerCreator, run } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const T0 = 1_760_000_000;

async function world() {
  const t = makeEnv();
  const creator = await registerCreator(t.env, "creator@example.com");
  await run(t.env, "UPDATE users SET subscription_price_cents=500, creator_name='Cora Creator' WHERE id=?", creator.id);
  const ep = await call(t.env, "POST", "/api/creator/episodes", { token: creator.token, body: { title: "Pilot", description: "First one", oneTimePriceCents: 499 } });
  await run(t.env, "UPDATE episodes SET video_key='k/v.mp4', is_published=1, publish_date=datetime('now') WHERE id=?", ep.json.id);
  const draft = await call(t.env, "POST", "/api/creator/episodes", { token: creator.token, body: { title: "Secret draft", oneTimePriceCents: 100 } });
  const v = await call(t.env, "POST", "/api/auth/register", { body: { email: "viewer@example.com", password: "a-long-test-password", creatorName: "Vee" } });
  return { ...t, creator, viewer: { token: v.json.token as string, id: v.json.id as string }, episodeId: ep.json.id as string, draftId: draft.json.id as string };
}
const access = (w: any, id: string, token?: string) => call(w.env, "GET", `/api/episodes/${id}/access`, { token });

describe("GET /api/episodes/:id/access", () => {
  it("requires login", async () => {
    const w = await world();
    expect((await access(w, w.episodeId)).status).toBe(401);
  });

  it("reports none, purchased, subscribed and owner", async () => {
    const w = await world();
    expect((await access(w, w.episodeId, w.viewer.token)).json).toEqual({ hasAccess: false, reason: "none" });
    expect((await access(w, w.episodeId, w.creator.token)).json).toEqual({ hasAccess: true, reason: "owner" });

    await postWebhook(w.env, "stripe", {
      id: "evt_p", type: "checkout.session.completed", created: T0,
      data: { object: { id: "cs_1", mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 499, metadata: { type: "episode", viewer_id: w.viewer.id, episode_id: w.episodeId, creator_id: w.creator.id } } },
    });
    expect((await access(w, w.episodeId, w.viewer.token)).json).toEqual({ hasAccess: true, reason: "purchased" });

    const other = await call(w.env, "POST", "/api/auth/register", { body: { email: "sub@example.com", password: "a-long-test-password", creatorName: "Sub" } });
    await run(w.env, "INSERT INTO subscriptions (id, viewer_id, creator_id, stripe_subscription_id, status, price_per_month_cents, started_at) VALUES ('s1', ?, ?, 'sub_1', 'active', 500, datetime('now'))", other.json.id, w.creator.id);
    expect((await access(w, w.episodeId, other.json.token)).json).toEqual({ hasAccess: true, reason: "subscribed" });
    await run(w.env, "UPDATE subscriptions SET status='canceled' WHERE id='s1'");
    expect((await access(w, w.episodeId, other.json.token)).json).toEqual({ hasAccess: false, reason: "none" });
  });

  it("is read-only: no view_count change, no signed URL, /stream behaviour unchanged", async () => {
    const w = await world();
    await run(w.env, "INSERT INTO purchases (id, viewer_id, episode_id, amount_cents, status, purchased_at, stripe_payment_intent_id) VALUES ('p1', ?, ?, 499, 'completed', datetime('now'), 'pi_x')", w.viewer.id, w.episodeId);
    const r = await access(w, w.episodeId, w.viewer.token);
    expect(r.json).toEqual({ hasAccess: true, reason: "purchased" });
    expect(JSON.stringify(r.json)).not.toContain("url");
    expect((await one<any>(w.env, "SELECT view_count v FROM episodes WHERE id=?", w.episodeId)).v).toBe(0);
    const s = await call(w.env, "GET", `/api/episodes/${w.episodeId}/stream`, { token: w.viewer.token });
    expect(s.status).toBe(200);
    expect((await one<any>(w.env, "SELECT view_count v FROM episodes WHERE id=?", w.episodeId)).v).toBe(1);
    const noAccess = await call(w.env, "GET", `/api/episodes/${w.episodeId}/stream`, { token: (await call(w.env, "POST", "/api/auth/register", { body: { email: "x@example.com", password: "a-long-test-password", creatorName: "X" } })).json.token });
    expect(noAccess.status).toBe(403);
  });

  it("404 for unknown and for unpublished (except the owner)", async () => {
    const w = await world();
    expect((await access(w, "nope", w.viewer.token)).status).toBe(404);
    expect((await access(w, w.draftId, w.viewer.token)).status).toBe(404);
    expect((await access(w, w.draftId, w.creator.token)).json).toEqual({ hasAccess: true, reason: "owner" });
  });
});

describe("GET /api/creators/:id", () => {
  it("is public and lists published episodes only, with a safe field set", async () => {
    const w = await world();
    const r = await call(w.env, "GET", `/api/creators/${w.creator.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      id: w.creator.id,
      creatorName: "Cora Creator",
      subscriptionPriceCents: 500,
      episodes: [{ id: w.episodeId, title: "Pilot", priceCents: 499, publishDate: expect.any(String) }],
    });
    const text = JSON.stringify(r.json);
    expect(text).not.toContain("creator@example.com");
    expect(text).not.toContain(w.draftId);
    expect(text).not.toMatch(/stripe|network|acct_/i);
  });

  it("null subscription price when none is offered; 404 for unknown ids and non-creators", async () => {
    const w = await world();
    await run(w.env, "UPDATE users SET subscription_price_cents=NULL WHERE id=?", w.creator.id);
    expect((await call(w.env, "GET", `/api/creators/${w.creator.id}`)).json.subscriptionPriceCents).toBeNull();
    expect((await call(w.env, "GET", "/api/creators/nope")).status).toBe(404);
    expect((await call(w.env, "GET", `/api/creators/${w.viewer.id}`)).status).toBe(404);
  });
});

describe("GET /api/episodes/:id (public)", () => {
  it("has everything the episode page needs, and 404s when unpublished", async () => {
    const w = await world();
    const r = await call(w.env, "GET", `/api/episodes/${w.episodeId}`);
    expect(r.json).toMatchObject({ id: w.episodeId, title: "Pilot", description: "First one", creatorId: w.creator.id, creatorName: "Cora Creator", oneTimePriceCents: 499 });
    expect(JSON.stringify(r.json)).not.toContain("creator@example.com");
    expect((await call(w.env, "GET", `/api/episodes/${w.draftId}`)).status).toBe(404);
  });
});
