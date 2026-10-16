import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { all, call, makeEnv, mockStripe, one, postWebhook, registerCreator, run } from "./helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

afterEach(() => vi.unstubAllGlobals());

const T0 = 1_760_000_000;

interface Net {
  networkId: string;
  creator: { token: string; id: string };
  episodeId: string;
}

/** One creator + network + published $4.99 episode, with a $5 subscription. The network is NOT yet connected to Stripe. */
async function addNetwork(env: any, email: string): Promise<Net> {
  const creator = await registerCreator(env, email);
  await run(env, "UPDATE users SET subscription_price_cents=500 WHERE id=?", creator.id);
  const networkId = (await one<any>(env, "SELECT network_id n FROM users WHERE id=?", creator.id)).n as string;
  const ep = await call(env, "POST", "/api/creator/episodes", { token: creator.token, body: { title: `Pilot ${email}`, oneTimePriceCents: 499 } });
  await run(env, "UPDATE episodes SET video_key='k/v.mp4', is_published=1, publish_date=datetime('now') WHERE id=?", ep.json.id);
  return { networkId, creator, episodeId: ep.json.id };
}
const connect = (env: any, n: Net, account: string, feePercent?: number) =>
  run(
    env,
    "UPDATE networks SET stripe_account_id=?, stripe_charges_enabled=1, stripe_payouts_enabled=1, platform_fee_percent=COALESCE(?, platform_fee_percent) WHERE id=?",
    account,
    feePercent ?? null,
    n.networkId,
  );

async function viewerOf(env: any) {
  const r = await call(env, "POST", "/api/auth/register", { body: { email: "viewer@example.com", password: "a-long-test-password", creatorName: "viewer" } });
  return { token: r.json.token as string, id: r.json.id as string };
}

const buy = (env: any, viewer: { token: string }, n: Net) => call(env, "POST", "/api/purchases", { token: viewer.token, body: { episodeId: n.episodeId } });
const subscribe = (env: any, viewer: { token: string }, n: Net) => call(env, "POST", "/api/subscriptions", { token: viewer.token, body: { creatorId: n.creator.id } });

/** Mirrors what Stripe sends back for a session we created: our own metadata, echoed. */
const sessionMeta = (calls: any[], prefix = "metadata") =>
  Object.fromEntries(
    Object.entries(calls[0]!.params as Record<string, string>)
      .filter(([k]) => k.startsWith(`${prefix}[`))
      .map(([k, v]) => [k.slice(prefix.length + 1, -1), v]),
  );

const episodePaid = (meta: Record<string, string>, id = "evt_p1", pi = "pi_1", amount = 499) => ({
  id,
  type: "checkout.session.completed",
  created: T0,
  data: { object: { id: "cs_1", mode: "payment", payment_status: "paid", payment_intent: pi, amount_total: amount, customer: "cus_1", metadata: meta } },
});
const subCompleted = (meta: Record<string, string>, id = "evt_sc1") => ({
  id,
  type: "checkout.session.completed",
  created: T0,
  data: { object: { id: "cs_2", mode: "subscription", payment_status: "paid", subscription: "sub_1", amount_total: 500, customer: "cus_1", metadata: meta } },
});
const invoicePaid = (meta: Record<string, string>, extra: Record<string, unknown> = {}, id = "evt_inv1", invoiceId = "in_1") => ({
  id,
  type: "invoice.paid",
  created: T0 + 100,
  data: { object: { id: invoiceId, subscription: "sub_1", amount_paid: 500, status_transitions: { paid_at: T0 + 100 }, subscription_details: { metadata: meta }, ...extra } },
});

describe("payee is the episode's / creator's network", () => {
  it("an active network is paid, never the creator's own Connect account", async () => {
    const { env } = makeEnv();
    const a = await addNetwork(env, "a@example.com");
    await connect(env, a, "acct_netA");
    await run(env, "UPDATE users SET stripe_account_id='acct_creatorA', stripe_ready=1 WHERE id=?", a.creator.id);
    const viewer = await viewerOf(env);
    const calls = mockStripe();

    expect((await buy(env, viewer, a)).status).toBe(200);
    expect((await subscribe(env, viewer, a)).status).toBe(200);
    expect(calls[0]!.params["payment_intent_data[transfer_data][destination]"]).toBe("acct_netA");
    expect(calls[1]!.params["subscription_data[transfer_data][destination]"]).toBe("acct_netA");
    expect(JSON.stringify(calls)).not.toContain("acct_creatorA");
  });

  it("network A's checkout never pays network B's account, and vice versa", async () => {
    const { env } = makeEnv();
    const a = await addNetwork(env, "a@example.com");
    const b = await addNetwork(env, "b@example.com");
    await connect(env, a, "acct_netA");
    await connect(env, b, "acct_netB");
    const viewer = await viewerOf(env);
    const calls = mockStripe();

    await buy(env, viewer, a);
    await subscribe(env, viewer, a);
    await buy(env, viewer, b);
    await subscribe(env, viewer, b);

    const dest = (i: number) => calls[i]!.params["payment_intent_data[transfer_data][destination]"] ?? calls[i]!.params["subscription_data[transfer_data][destination]"];
    expect([dest(0), dest(1), dest(2), dest(3)]).toEqual(["acct_netA", "acct_netA", "acct_netB", "acct_netB"]);
    expect(JSON.stringify(calls.slice(0, 2))).not.toContain("acct_netB");
    expect(JSON.stringify(calls.slice(2))).not.toContain("acct_netA");
  });
});

describe("checkout is refused unless the network is active", () => {
  it.each([
    ["not_connected", "UPDATE networks SET stripe_account_id=NULL, stripe_charges_enabled=0, stripe_payouts_enabled=0"],
    ["pending (account, nothing enabled)", "UPDATE networks SET stripe_charges_enabled=0, stripe_payouts_enabled=0"],
    ["pending (charges only)", "UPDATE networks SET stripe_payouts_enabled=0"],
    ["pending (payouts only)", "UPDATE networks SET stripe_charges_enabled=0"],
  ])("%s -> 409 and Stripe is never called", async (_label, update) => {
    const { env } = makeEnv();
    const a = await addNetwork(env, "a@example.com");
    await connect(env, a, "acct_netA");
    await run(env, `${update} WHERE id=?`, a.networkId);
    // the creator's own account is ready: it must NOT be used as a fallback
    await run(env, "UPDATE users SET stripe_account_id='acct_creatorA', stripe_ready=1 WHERE id=?", a.creator.id);
    const viewer = await viewerOf(env);
    const calls = mockStripe();

    const p = await buy(env, viewer, a);
    const s = await subscribe(env, viewer, a);
    expect(p.status).toBe(409);
    expect(s.status).toBe(409);
    expect(p.json).toEqual({ error: "network cannot accept payments yet" });
    expect(s.json).toEqual({ error: "network cannot accept payments yet" });
    expect(calls).toHaveLength(0);
  });

  it("one network not being ready does not affect another", async () => {
    const { env } = makeEnv();
    const a = await addNetwork(env, "a@example.com");
    const b = await addNetwork(env, "b@example.com");
    await connect(env, b, "acct_netB"); // A never connected
    const viewer = await viewerOf(env);
    mockStripe();
    expect((await buy(env, viewer, a)).status).toBe(409);
    expect((await buy(env, viewer, b)).status).toBe(200);
  });
});

describe("fee comes from networks.platform_fee_percent, frozen at checkout", () => {
  it("defaults to 15%", async () => {
    const { env } = makeEnv();
    const a = await addNetwork(env, "a@example.com");
    await connect(env, a, "acct_netA");
    const viewer = await viewerOf(env);
    const calls = mockStripe();
    await buy(env, viewer, a);
    await subscribe(env, viewer, a);
    expect(calls[0]!.params["payment_intent_data[application_fee_amount]"]).toBe("75");
    expect(calls[1]!.params["subscription_data[application_fee_percent]"]).toBe("15");
  });

  it("a custom 10% flows into the checkout params and the revenue rows", async () => {
    const { env } = makeEnv();
    const a = await addNetwork(env, "a@example.com");
    await connect(env, a, "acct_netA", 10);
    const viewer = await viewerOf(env);
    const calls = mockStripe();

    await buy(env, viewer, a);
    await subscribe(env, viewer, a);
    expect(calls[0]!.params["payment_intent_data[application_fee_amount]"]).toBe("50"); // 49.9 -> 50
    expect(calls[1]!.params["subscription_data[application_fee_percent]"]).toBe("10");

    // Stripe echoes our metadata back on the webhooks. Invoice has no application_fee_amount here.
    await postWebhook(env, "stripe", episodePaid(sessionMeta([calls[0]])));
    await postWebhook(env, "stripe", subCompleted(sessionMeta([calls[1]])));
    await postWebhook(env, "stripe", invoicePaid(sessionMeta([calls[1]], "subscription_data[metadata]")));
    const rows = await all<any>(env, "SELECT source, gross_cents g, platform_fee_cents f, creator_cents c FROM revenue ORDER BY source");
    expect(rows).toEqual([
      { source: "purchase", g: 499, f: 50, c: 449 },
      { source: "subscription", g: 500, f: 50, c: 450 },
    ]);
  });

  it("revenue uses the rate frozen in the metadata even if the network's rate changed since", async () => {
    const { env } = makeEnv();
    const a = await addNetwork(env, "a@example.com");
    await connect(env, a, "acct_netA", 10);
    const viewer = await viewerOf(env);
    const calls = mockStripe();
    await buy(env, viewer, a);
    await run(env, "UPDATE networks SET platform_fee_percent=30 WHERE id=?", a.networkId);
    await postWebhook(env, "stripe", episodePaid(sessionMeta(calls)));
    expect((await one<any>(env, "SELECT platform_fee_cents f FROM revenue")).f).toBe(50); // 10%, not 30%
  });

  it("without frozen metadata it falls back to the network's current rate; Stripe's applied invoice fee wins over both", async () => {
    const { env } = makeEnv();
    const a = await addNetwork(env, "a@example.com");
    await connect(env, a, "acct_netA", 30);
    const viewer = await viewerOf(env);
    const calls = mockStripe();
    await buy(env, viewer, a);
    await subscribe(env, viewer, a);
    const { fee_percent: _drop, ...bare } = sessionMeta([calls[0]]) as Record<string, string>;
    await postWebhook(env, "stripe", episodePaid(bare));
    expect((await one<any>(env, "SELECT platform_fee_cents f FROM revenue WHERE source='purchase'")).f).toBe(150); // 30% of 499

    const { fee_percent: _d2, ...subBare } = sessionMeta([calls[1]]) as Record<string, string>;
    await postWebhook(env, "stripe", invoicePaid(subBare, { application_fee_amount: 123 }));
    expect((await one<any>(env, "SELECT platform_fee_cents f FROM revenue WHERE source='subscription'")).f).toBe(123);
  });

  it("a 0% network sends no fee parameter", async () => {
    const { env } = makeEnv();
    const a = await addNetwork(env, "a@example.com");
    await connect(env, a, "acct_netA", 0);
    const viewer = await viewerOf(env);
    const calls = mockStripe();
    await buy(env, viewer, a);
    await subscribe(env, viewer, a);
    expect(Object.keys(calls[0]!.params).some((k) => k.includes("application_fee"))).toBe(false);
    expect(Object.keys(calls[1]!.params).some((k) => k.includes("application_fee"))).toBe(false);
    expect(calls[0]!.params["payment_intent_data[transfer_data][destination]"]).toBe("acct_netA");
  });

  it("a corrupt stored rate fails closed: 500 and Stripe is never called", async () => {
    const { env } = makeEnv();
    const a = await addNetwork(env, "a@example.com");
    await connect(env, a, "acct_netA", 150);
    const viewer = await viewerOf(env);
    const calls = mockStripe();
    expect((await buy(env, viewer, a)).status).toBe(500);
    expect((await subscribe(env, viewer, a)).status).toBe(500);
    expect(calls).toHaveLength(0);
  });
});

describe("money rows carry the right network_id", () => {
  it("purchases, subscriptions and revenue are attributed to the content's network, per network", async () => {
    const { env } = makeEnv();
    const a = await addNetwork(env, "a@example.com");
    const b = await addNetwork(env, "b@example.com");
    await connect(env, a, "acct_netA");
    await connect(env, b, "acct_netB", 10);
    const viewer = await viewerOf(env);
    const calls = mockStripe();
    await buy(env, viewer, a);
    await subscribe(env, viewer, a);
    await buy(env, viewer, b);
    await subscribe(env, viewer, b);

    const pA = sessionMeta([calls[0]]);
    const sA = sessionMeta([calls[1]]);
    const pB = sessionMeta([calls[2]]);
    const sB = sessionMeta([calls[3]]);
    await postWebhook(env, "stripe", episodePaid(pA, "evt_a1", "pi_a"));
    await postWebhook(env, "stripe", episodePaid(pB, "evt_b1", "pi_b"));
    await postWebhook(env, "stripe", { ...subCompleted(sA, "evt_a2"), data: { object: { ...subCompleted(sA).data.object, subscription: "sub_a" } } });
    await postWebhook(env, "stripe", { ...subCompleted(sB, "evt_b2"), data: { object: { ...subCompleted(sB).data.object, subscription: "sub_b" } } });
    await postWebhook(env, "stripe", invoicePaid(sA, {}, "evt_a3", "in_a"));
    await postWebhook(env, "stripe", invoicePaid(sB, {}, "evt_b3", "in_b"));

    expect(await all(env, "SELECT stripe_payment_intent_id p, network_id n FROM purchases ORDER BY p")).toEqual([
      { p: "pi_a", n: a.networkId },
      { p: "pi_b", n: b.networkId },
    ]);
    expect(await all(env, "SELECT stripe_subscription_id s, network_id n FROM subscriptions ORDER BY s")).toEqual([
      { s: "sub_a", n: a.networkId },
      { s: "sub_b", n: b.networkId },
    ]);
    expect(await all(env, "SELECT stripe_object_id o, network_id n, platform_fee_cents f FROM revenue ORDER BY o")).toEqual([
      { o: "in_a", n: a.networkId, f: 75 }, // A: 15% of 500
      { o: "in_b", n: b.networkId, f: 50 }, // B: 10% of 500
      { o: "pi_a", n: a.networkId, f: 75 },
      { o: "pi_b", n: b.networkId, f: 50 },
    ]);
  });

  it("takes network_id from our database, not from (forgeable) metadata", async () => {
    const { env } = makeEnv();
    const a = await addNetwork(env, "a@example.com");
    const b = await addNetwork(env, "b@example.com");
    await connect(env, a, "acct_netA");
    const viewer = await viewerOf(env);
    const calls = mockStripe();
    await buy(env, viewer, a);
    await subscribe(env, viewer, a);

    const lie = { network_id: b.networkId };
    await postWebhook(env, "stripe", episodePaid({ ...sessionMeta([calls[0]]), ...lie }));
    await postWebhook(env, "stripe", subCompleted({ ...sessionMeta([calls[1]]), ...lie }));
    await postWebhook(env, "stripe", invoicePaid({ ...sessionMeta([calls[1]]), ...lie }));
    for (const table of ["purchases", "subscriptions", "revenue"]) {
      expect(await all(env, `SELECT DISTINCT network_id n FROM ${table}`), table).toEqual([{ n: a.networkId }]);
    }
  });
});

describe("migration 0009_revenue_network", () => {
  it("backfills revenue/purchases/subscriptions from the creator's network, else net_freqone, and indexes it", () => {
    const sql = (f: string) => readFileSync(`migrations/${f}`, "utf8");
    const db = new DatabaseSync(":memory:");
    for (const f of readdirSync("migrations").filter((n) => n < "0009").sort()) db.exec(sql(f));
    db.exec("INSERT INTO networks (id,slug,display_name) VALUES ('net_x','x','X')");
    db.exec("INSERT INTO users (id,email,password_hash,creator_name,is_creator,network_id,role) VALUES ('cx','cx@x.co','h','CX',1,'net_x','owner'),('cf','cf@x.co','h','CF',1,'net_freqone','owner'),('c0','c0@x.co','h','C0',1,NULL,'creator'),('v1','v1@x.co','h','V1',0,NULL,'guest')");
    db.exec("INSERT INTO episodes (id,creator_id,network_id,title) VALUES ('ex','cx','net_x','T'),('e0','c0',NULL,'T0')");
    db.exec("INSERT INTO revenue (id,creator_id,source,stripe_object_id,gross_cents,platform_fee_cents,creator_cents,occurred_at) VALUES ('r1','cx','purchase','pi_1',100,15,85,'2025-10-01 00:00:00'),('r2','cf','purchase','pi_2',100,15,85,'2025-10-01 00:00:00'),('r3','c0','purchase','pi_3',100,15,85,'2025-10-01 00:00:00')");
    db.exec("INSERT INTO purchases (id,viewer_id,episode_id,stripe_payment_intent_id,amount_cents) VALUES ('p1','v1','ex','pi_1',100)");
    db.exec("INSERT INTO subscriptions (id,viewer_id,creator_id,stripe_subscription_id,price_per_month_cents,started_at) VALUES ('s1','v1','cx','sub_1',500,'2025-10-01 00:00:00')");

    db.exec(sql("0009_revenue_network.sql"));

    expect(db.prepare("SELECT id, network_id FROM revenue ORDER BY id").all()).toEqual([
      { id: "r1", network_id: "net_x" },
      { id: "r2", network_id: "net_freqone" },
      { id: "r3", network_id: "net_freqone" },
    ]);
    expect(db.prepare("SELECT network_id FROM purchases").get()).toEqual({ network_id: "net_x" });
    expect(db.prepare("SELECT network_id FROM subscriptions").get()).toEqual({ network_id: "net_x" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_revenue_network'").get()).toEqual({ name: "idx_revenue_network" });
  });
});
