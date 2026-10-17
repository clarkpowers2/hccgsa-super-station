import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { all, call, makeEnv, one, postWebhook, run } from "./helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

afterEach(() => vi.restoreAllMocks());

const PW = "a-long-test-password";
const T0 = 1_760_000_000;

async function signup(env: any, email: string) {
  const r = await call(env, "POST", "/api/auth/creator-register", { body: { email, password: PW, creatorName: email } });
  return { token: r.json.token as string, id: r.json.id as string, nid: r.json.network.id as string };
}

/** Owner invites `email` with `role`, invitee accepts. */
async function addMember(env: any, owner: { token: string; nid: string }, email: string, role: string) {
  const inv = await call(env, "POST", `/api/networks/${owner.nid}/users`, { token: owner.token, body: { email, role } });
  const token = new URL(inv.json.inviteUrl).searchParams.get("token");
  const acc = await call(env, "POST", "/api/auth/accept-invite", { body: { token, password: PW, creatorName: email } });
  return { token: acc.json.token as string, id: acc.json.id as string };
}

const payout = (type: string, id: string, account: string, poId = "po_1", amount = 12345) => ({
  id,
  type,
  created: T0,
  account,
  data: { object: { id: poId, amount, currency: "usd", arrival_date: T0 } },
});

const revenueRow = (env: any, id: string, creatorId: string, networkId: string | null, gross: number, fee: number, at: string) =>
  run(
    env,
    "INSERT INTO revenue (id, creator_id, network_id, source, stripe_object_id, gross_cents, platform_fee_cents, creator_cents, occurred_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id,
    creatorId,
    networkId,
    "purchase",
    `pi_${id}`,
    gross,
    fee,
    gross - fee,
    at,
  );

describe("network payouts via the connect webhook", () => {
  it("records a network account's payout.paid and payout.failed against the network with no creator", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    await run(env, "UPDATE networks SET stripe_account_id='acct_neta' WHERE id=?", a.nid);

    await postWebhook(env, "stripe-connect", payout("payout.failed", "evt_f1", "acct_neta"));
    expect(await one(env, "SELECT creator_id, network_id, status, amount_cents, paid_at FROM payouts")).toEqual({
      creator_id: null,
      network_id: a.nid,
      status: "failed",
      amount_cents: 12345,
      paid_at: null,
    });

    await postWebhook(env, "stripe-connect", payout("payout.paid", "evt_p1", "acct_neta"));
    const rows = await all<any>(env, "SELECT creator_id, network_id, status, paid_at FROM payouts");
    expect(rows).toHaveLength(1); // ON CONFLICT(stripe_payout_id) updated in place
    expect(rows[0]).toMatchObject({ creator_id: null, network_id: a.nid, status: "paid" });
    expect(rows[0].paid_at).toBeTruthy();
  });

  it("a network account wins over a user row that happens to share the account id", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    await run(env, "UPDATE networks SET stripe_account_id='acct_shared' WHERE id=?", a.nid);
    await run(env, "UPDATE users SET stripe_account_id='acct_shared' WHERE id=?", a.id);
    await postWebhook(env, "stripe-connect", payout("payout.paid", "evt_s1", "acct_shared"));
    expect(await one(env, "SELECT creator_id, network_id FROM payouts")).toEqual({ creator_id: null, network_id: a.nid });
  });

  it("still records a creator's own-account payout, now with the creator's network_id", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    await run(env, "UPDATE users SET stripe_account_id='acct_creator' WHERE id=?", a.id);
    await postWebhook(env, "stripe-connect", payout("payout.paid", "evt_c1", "acct_creator"));
    expect(await one(env, "SELECT creator_id, network_id, status, amount_cents FROM payouts")).toEqual({
      creator_id: a.id,
      network_id: a.nid,
      status: "paid",
      amount_cents: 12345,
    });
    expect((await call(env, "GET", "/api/creator/payouts", { token: a.token })).json.payouts).toHaveLength(1);
  });

  it("a network payout is not listed as a creator payout, and unknown accounts are ignored quietly", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    await run(env, "UPDATE networks SET stripe_account_id='acct_neta' WHERE id=?", a.nid);
    await postWebhook(env, "stripe-connect", payout("payout.paid", "evt_n1", "acct_neta"));
    expect((await call(env, "GET", "/api/creator/payouts", { token: a.token })).json.payouts).toEqual([]);
    expect((await postWebhook(env, "stripe-connect", payout("payout.paid", "evt_x", "acct_stranger", "po_x"))).status).toBe(200);
    expect(await all(env, "SELECT * FROM payouts WHERE stripe_payout_id='po_x'")).toHaveLength(0);
  });
});

describe("GET /api/networks/:networkId/payouts", () => {
  it("lists only this network's payouts, newest first, in the creator-payouts shape", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const b = await signup(env, "b@example.com");
    await run(env, "UPDATE networks SET stripe_account_id='acct_neta' WHERE id=?", a.nid);
    await run(env, "UPDATE networks SET stripe_account_id='acct_netb' WHERE id=?", b.nid);
    await postWebhook(env, "stripe-connect", payout("payout.paid", "evt_1", "acct_neta", "po_a1", 1000));
    await postWebhook(env, "stripe-connect", payout("payout.paid", "evt_2", "acct_neta", "po_a2", 2000));
    await postWebhook(env, "stripe-connect", payout("payout.paid", "evt_3", "acct_netb", "po_b1", 9999));
    await run(env, "UPDATE payouts SET created_at='2025-10-01 00:00:00' WHERE stripe_payout_id='po_a1'");
    await run(env, "UPDATE payouts SET created_at='2025-11-01 00:00:00' WHERE stripe_payout_id='po_a2'");

    const r = await call(env, "GET", `/api/networks/${a.nid}/payouts`, { token: a.token });
    expect(r.status).toBe(200);
    expect(r.json.payouts.map((p: any) => p.id)).toEqual(["po_a2", "po_a1"]);
    expect(Object.keys(r.json.payouts[0]).sort()).toEqual(["amountCents", "arrivalDate", "currency", "id", "paidAt", "status"]);
    expect(r.json.payouts[0]).toMatchObject({ amountCents: 2000, currency: "usd", status: "paid" });
    const rb = await call(env, "GET", `/api/networks/${b.nid}/payouts`, { token: b.token });
    expect(rb.json.payouts.map((p: any) => p.id)).toEqual(["po_b1"]);
  });
});

describe("GET /api/networks/:networkId/earnings", () => {
  it("returns lifetime and per-month totals from revenue, per network", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const b = await signup(env, "b@example.com");
    await revenueRow(env, "r1", a.id, a.nid, 499, 75, "2026-09-10 00:00:00");
    await revenueRow(env, "r2", a.id, a.nid, 1000, 150, "2026-09-20 00:00:00");
    await revenueRow(env, "r3", a.id, a.nid, 500, 75, "2026-10-02 00:00:00");
    await revenueRow(env, "r4", b.id, b.nid, 2000, 300, "2026-10-03 00:00:00");

    const ra = await call(env, "GET", `/api/networks/${a.nid}/earnings`, { token: a.token });
    expect(ra.status).toBe(200);
    expect(ra.json.lifetime).toEqual({ grossCents: 1999, platformFeeCents: 300, networkCents: 1699 });
    expect(ra.json.months).toEqual([
      { month: "2026-10", charges: 1, grossCents: 500, platformFeeCents: 75, networkCents: 425 },
      { month: "2026-09", charges: 2, grossCents: 1499, platformFeeCents: 225, networkCents: 1274 },
    ]);
    const rb = await call(env, "GET", `/api/networks/${b.nid}/earnings`, { token: b.token });
    expect(rb.json.lifetime).toEqual({ grossCents: 2000, platformFeeCents: 300, networkCents: 1700 });
  });

  it("is empty, not an error, for a network with no revenue", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    expect((await call(env, "GET", `/api/networks/${a.nid}/earnings`, { token: a.token })).json).toEqual({
      lifetime: { grossCents: 0, platformFeeCents: 0, networkCents: 0 },
      months: [],
    });
  });
});

describe.each(["earnings", "payouts"])("access control for /api/networks/:networkId/%s", (route) => {
  it("allows owner and admin; refuses creator, guest, other networks and anonymous callers", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const b = await signup(env, "b@example.com");
    const admin = await addMember(env, a, "admin@example.com", "admin");
    const creator = await addMember(env, a, "creator@example.com", "creator");
    const guest = await call(env, "POST", "/api/auth/register", { body: { email: "g@example.com", password: PW, creatorName: "g" } });
    const get = (nid: string, token?: string) => call(env, "GET", `/api/networks/${nid}/${route}`, { token });

    expect((await get(a.nid, a.token)).status).toBe(200);
    expect((await get(a.nid, admin.token)).status).toBe(200);
    expect((await get(a.nid, creator.token)).status).toBe(403);
    expect((await get(a.nid, guest.json.token)).status).toBe(403);
    expect((await get(b.nid, a.token)).status).toBe(403); // someone else's network
    expect((await get(a.nid, b.token)).status).toBe(403);
    expect((await get(a.nid)).status).toBe(401);
  });
});

describe("webhook money writes never carry a NULL network (PR #4 follow-up)", () => {
  it("books a legacy episode with no network to net_freqone and logs the event id only", async () => {
    const { env } = makeEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await signup(env, "a@example.com");
    const viewer = await call(env, "POST", "/api/auth/register", { body: { email: "v@example.com", password: PW, creatorName: "v" } });
    const ep = await call(env, "POST", "/api/creator/episodes", { token: a.token, body: { title: "Legacy", oneTimePriceCents: 499 } });
    await run(env, "UPDATE episodes SET network_id=NULL WHERE id=?", ep.json.id);

    const evt = {
      id: "evt_legacy",
      type: "checkout.session.completed",
      created: T0,
      data: {
        object: {
          id: "cs_l",
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_legacy",
          amount_total: 499,
          metadata: { type: "episode", episode_id: ep.json.id, viewer_id: viewer.json.id, fee_percent: "15" },
        },
      },
    };
    expect((await postWebhook(env, "stripe", evt)).status).toBe(200);
    expect(await one(env, "SELECT network_id FROM purchases")).toEqual({ network_id: "net_freqone" });
    expect(await one(env, "SELECT network_id, gross_cents, platform_fee_cents FROM revenue")).toEqual({
      network_id: "net_freqone",
      gross_cents: 499,
      platform_fee_cents: 75,
    });
    expect(warn).toHaveBeenCalledWith("network_id unresolved, using legacy network", "evt_legacy");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("v@example.com");
  });

  it("a subscription update fills a NULL network_id but never rewrites an existing one", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const viewer = await call(env, "POST", "/api/auth/register", { body: { email: "v@example.com", password: PW, creatorName: "v" } });
    await run(
      env,
      "INSERT INTO subscriptions (id, viewer_id, creator_id, network_id, stripe_subscription_id, status, price_per_month_cents, started_at) VALUES ('s1',?,?,NULL,'sub_1','active',500,'2025-10-01 00:00:00')",
      viewer.json.id,
      a.id,
    );
    const update = (id: string) => ({
      id,
      type: "customer.subscription.updated",
      created: T0,
      data: {
        object: {
          id: "sub_1",
          status: "active",
          start_date: T0,
          current_period_end: T0 + 86400,
          items: { data: [{ price: { unit_amount: 500 } }] },
          metadata: { type: "subscription", viewer_id: viewer.json.id, creator_id: a.id },
        },
      },
    });
    await postWebhook(env, "stripe", update("evt_u1"));
    expect(await one(env, "SELECT network_id FROM subscriptions")).toEqual({ network_id: a.nid });

    // The creator later moves networks; a replayed update must not rewrite the subscription's original network.
    await run(env, "UPDATE users SET network_id='net_freqone' WHERE id=?", a.id);
    await postWebhook(env, "stripe", update("evt_u2"));
    expect(await one(env, "SELECT network_id FROM subscriptions")).toEqual({ network_id: a.nid });
  });
});

describe("episode creation stamps the creator's network (payees cannot diverge)", () => {
  it("every episode carries its creator's network_id, whoever creates it and whatever the body says", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const b = await signup(env, "b@example.com");
    const member = await addMember(env, a, "creator@example.com", "creator");
    const create = (token: string, extra: object = {}) =>
      call(env, "POST", "/api/creator/episodes", { token, body: { title: "T", oneTimePriceCents: 499, ...extra } });

    const e1 = await create(a.token);
    const e2 = await create(member.token, { networkId: b.nid, network_id: b.nid }); // forged network fields are ignored
    const e3 = await create(b.token);
    for (const [ep, creatorId, nid] of [
      [e1, a.id, a.nid],
      [e2, member.id, a.nid],
      [e3, b.id, b.nid],
    ] as const) {
      expect(ep.status).toBe(201);
      const row = await one<any>(env, "SELECT e.network_id eid, u.network_id uid, e.creator_id cid FROM episodes e JOIN users u ON u.id = e.creator_id WHERE e.id = ?", ep.json.id);
      expect(row).toEqual({ eid: nid, uid: nid, cid: creatorId });
    }
    expect(await all(env, "SELECT 1 FROM episodes WHERE network_id IS NULL")).toHaveLength(0);
  });

  it("refuses to create an episode for an account with no network instead of stamping NULL", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    await run(env, "UPDATE users SET network_id=NULL WHERE id=?", a.id);
    // Token claims still say the old network, but the row-level stamp comes from the token's network; make it null too.
    const login = await call(env, "POST", "/api/auth/login", { body: { email: "a@example.com", password: PW } });
    const r = await call(env, "POST", "/api/creator/episodes", { token: login.json.token, body: { title: "T" } });
    expect(r.status).toBe(403);
    expect(await all(env, "SELECT 1 FROM episodes")).toHaveLength(0);
  });
});

describe("migration 0010_network_payouts", () => {
  const sql = (f: string) => readFileSync(`migrations/${f}`, "utf8");
  const dbUpTo = (last: string) => {
    const db = new DatabaseSync(":memory:");
    for (const f of readdirSync("migrations").filter((n) => n < last).sort()) db.exec(sql(f));
    return db;
  };

  it("keeps every existing payout row, fills network_id, and lets new rows have no creator", () => {
    const db = dbUpTo("0010");
    db.exec("INSERT INTO networks (id,slug,display_name) VALUES ('net_x','x','X')");
    db.exec("INSERT INTO users (id,email,password_hash,creator_name,is_creator,network_id,role) VALUES ('cx','cx@x.co','h','CX',1,'net_x','owner'),('c0','c0@x.co','h','C0',1,NULL,'creator')");
    db.exec(`INSERT INTO payouts (id,creator_id,stripe_payout_id,amount_cents,currency,status,arrival_date,paid_at,created_at,network_id) VALUES
      ('p1','cx','po_1',1000,'usd','paid','2025-10-01 00:00:00','2025-10-02 00:00:00','2025-10-01 12:00:00','net_x'),
      ('p2','cx','po_2',2000,'usd','failed',NULL,NULL,'2025-10-03 12:00:00',NULL),
      ('p3','c0','po_3',3000,'eur','paid',NULL,'2025-10-04 00:00:00','2025-10-04 12:00:00',NULL)`);
    const before = db.prepare("SELECT id, creator_id, stripe_payout_id, amount_cents, currency, status, arrival_date, paid_at, created_at FROM payouts ORDER BY id").all();

    db.exec(sql("0010_network_payouts.sql"));

    expect(db.prepare("SELECT id, creator_id, stripe_payout_id, amount_cents, currency, status, arrival_date, paid_at, created_at FROM payouts ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT id, network_id FROM payouts ORDER BY id").all()).toEqual([
      { id: "p1", network_id: "net_x" },
      { id: "p2", network_id: "net_x" }, // from the creator's network
      { id: "p3", network_id: "net_freqone" }, // creator has no network: legacy fallback
    ]);
    // creator_id is now nullable, stripe_payout_id is still unique, every column survived.
    db.exec("INSERT INTO payouts (id,creator_id,stripe_payout_id,amount_cents,status,network_id) VALUES ('p4',NULL,'po_4',500,'paid','net_x')");
    expect(() => db.exec("INSERT INTO payouts (id,creator_id,stripe_payout_id,amount_cents,status) VALUES ('p5','cx','po_4',1,'paid')")).toThrow();
    const cols = (db.prepare("PRAGMA table_info(payouts)").all() as { name: string; notnull: number }[]);
    expect(cols.map((c) => c.name).sort()).toEqual(["amount_cents", "arrival_date", "created_at", "creator_id", "currency", "id", "network_id", "paid_at", "status", "stripe_payout_id"]);
    expect(cols.find((c) => c.name === "creator_id")!.notnull).toBe(0);
    expect(cols.find((c) => c.name === "stripe_payout_id")!.notnull).toBe(1);
    // Foreign keys and indexes preserved, plus the new (network_id, created_at) index.
    expect((db.prepare("PRAGMA foreign_key_list(payouts)").all() as { table: string }[]).map((f) => f.table).sort()).toEqual(["networks", "users"]);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='payouts' AND name LIKE 'idx_%' ORDER BY name").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toEqual(["idx_payouts_creator", "idx_payouts_network", "idx_payouts_network_created"]);
    expect((db.prepare("PRAGMA index_info(idx_payouts_network_created)").all() as { name: string }[]).map((i) => i.name)).toEqual(["network_id", "created_at"]);
  });

  it("applies cleanly on an empty payouts table", () => {
    const db = dbUpTo("0010");
    db.exec(sql("0010_network_payouts.sql"));
    expect(db.prepare("SELECT count(*) n FROM payouts").get()).toEqual({ n: 0 });
  });
});
