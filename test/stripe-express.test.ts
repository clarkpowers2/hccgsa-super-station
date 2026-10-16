import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { call, makeEnv, mockStripe, one, stripeSignatureHeader } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const PW = "a-long-test-password";

async function signup(env: any, email: string) {
  const r = await call(env, "POST", "/api/auth/creator-register", { body: { email, password: PW, creatorName: "Owner" } });
  return { token: r.json.token as string, nid: r.json.network.id as string };
}

async function addMember(env: any, owner: { token: string; nid: string }, email: string, role: string) {
  const inv = await call(env, "POST", `/api/networks/${owner.nid}/users`, { token: owner.token, body: { email, role } });
  const token = new URL(inv.json.inviteUrl).searchParams.get("token");
  const acc = await call(env, "POST", "/api/auth/accept-invite", { body: { token, password: PW, creatorName: email } });
  return acc.json.token as string;
}

/** Each /accounts call mints a distinct id so cross-network leakage would be visible. */
function stripeWithAccounts() {
  let n = 0;
  return mockStripe({ "/accounts": () => ({ id: `acct_net${++n}` }) });
}

function accountUpdated(id: string, flags: { charges?: boolean; payouts?: boolean; details?: boolean }, eventId = "evt_1") {
  return {
    id: eventId,
    object: "event",
    type: "account.updated",
    data: {
      object: {
        id,
        object: "account",
        charges_enabled: !!flags.charges,
        payouts_enabled: !!flags.payouts,
        details_submitted: !!flags.details,
      },
    },
  };
}

async function postStripeWebhook(env: any, event: object, header?: string | null) {
  const payload = JSON.stringify(event);
  const sig = header === undefined ? stripeSignatureHeader(payload, env.STRIPE_WEBHOOK_SECRET) : header;
  const res = await app.fetch(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(sig ? { "Stripe-Signature": sig } : {}) },
      body: payload,
    }),
    env,
  );
  return { status: res.status, json: (await res.json()) as any };
}

describe("POST /api/networks/:id/stripe/onboard", () => {
  it("owner creates an Express account, stores it, and gets an onboarding link", async () => {
    const { env } = makeEnv();
    const calls = stripeWithAccounts();
    const owner = await signup(env, "o@example.com");

    const r = await call(env, "POST", `/api/networks/${owner.nid}/stripe/onboard`, { token: owner.token });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ url: "https://connect.test/onboard", stripe_account_id: "acct_net1" });

    const create = calls.find((c) => c.path === "/accounts")!;
    expect(create.params).toMatchObject({
      type: "express",
      "capabilities[card_payments][requested]": "true",
      "capabilities[transfers][requested]": "true",
      "metadata[network_id]": owner.nid,
    });
    const link = calls.find((c) => c.path === "/account_links")!;
    expect(link.params).toMatchObject({
      account: "acct_net1",
      type: "account_onboarding",
      return_url: env.STRIPE_CONNECT_RETURN_URL,
      refresh_url: env.STRIPE_CONNECT_REFRESH_URL,
    });
    expect((await one<any>(env, "SELECT stripe_account_id FROM networks WHERE id = ?", owner.nid)).stripe_account_id).toBe("acct_net1");
  });

  it("a second call reuses the same account and mints a fresh link", async () => {
    const { env } = makeEnv();
    let links = 0;
    const calls = mockStripe({
      "/accounts": () => ({ id: "acct_once" }),
      "/account_links": () => ({ url: `https://connect.test/onboard/${++links}` }),
    });
    const owner = await signup(env, "o@example.com");

    const a = await call(env, "POST", `/api/networks/${owner.nid}/stripe/onboard`, { token: owner.token });
    const b = await call(env, "POST", `/api/networks/${owner.nid}/stripe/onboard`, { token: owner.token });
    expect(a.json.stripe_account_id).toBe("acct_once");
    expect(b.json.stripe_account_id).toBe("acct_once");
    expect(a.json.url).not.toBe(b.json.url);
    expect(calls.filter((c) => c.path === "/accounts")).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/account_links")).toHaveLength(2);
  });

  it("is owner-only: admin, creator and guest get 403 and Stripe is never called", async () => {
    const { env } = makeEnv();
    const calls = stripeWithAccounts();
    const owner = await signup(env, "o@example.com");
    for (const role of ["admin", "creator", "guest"]) {
      const token = await addMember(env, owner, `${role}@example.com`, role);
      const r = await call(env, "POST", `/api/networks/${owner.nid}/stripe/onboard`, { token });
      expect(r.status, role).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it("403s on another network's id and 401s without a token", async () => {
    const { env } = makeEnv();
    const calls = stripeWithAccounts();
    const a = await signup(env, "a@example.com");
    const b = await signup(env, "b@example.com");
    expect((await call(env, "POST", `/api/networks/${b.nid}/stripe/onboard`, { token: a.token })).status).toBe(403);
    expect((await call(env, "POST", `/api/networks/${a.nid}/stripe/onboard`)).status).toBe(401);
    expect(calls).toHaveLength(0);
    expect((await one<any>(env, "SELECT stripe_account_id FROM networks WHERE id = ?", b.nid)).stripe_account_id).toBeNull();
  });

  it("returns 503 when the return/refresh URLs are not configured", async () => {
    const { env } = makeEnv({ STRIPE_CONNECT_RETURN_URL: "" });
    const calls = stripeWithAccounts();
    const owner = await signup(env, "o@example.com");
    expect((await call(env, "POST", `/api/networks/${owner.nid}/stripe/onboard`, { token: owner.token })).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe("GET /api/networks/:id/stripe/status", () => {
  it("goes not_connected -> pending -> active, read from D1 with no Stripe calls", async () => {
    const { env } = makeEnv();
    const calls = stripeWithAccounts();
    const owner = await signup(env, "o@example.com");
    const status = () => call(env, "GET", `/api/networks/${owner.nid}/stripe/status`, { token: owner.token });

    expect((await status()).json).toEqual({ status: "not_connected", charges_enabled: false, payouts_enabled: false, details_submitted: false });

    await call(env, "POST", `/api/networks/${owner.nid}/stripe/onboard`, { token: owner.token });
    expect((await status()).json).toEqual({ status: "pending", charges_enabled: false, payouts_enabled: false, details_submitted: false });

    await postStripeWebhook(env, accountUpdated("acct_net1", { details: true }, "evt_a"));
    expect((await status()).json).toEqual({ status: "pending", charges_enabled: false, payouts_enabled: false, details_submitted: true });

    await postStripeWebhook(env, accountUpdated("acct_net1", { charges: true, payouts: true, details: true }, "evt_b"));
    expect((await status()).json).toEqual({ status: "active", charges_enabled: true, payouts_enabled: true, details_submitted: true });

    // only the onboard call touched Stripe (account + link); status never did
    expect(calls.map((c) => c.path)).toEqual(["/accounts", "/account_links"]);
  });

  it("allows admin, refuses creator/guest, and refuses another network", async () => {
    const { env } = makeEnv();
    stripeWithAccounts();
    const owner = await signup(env, "o@example.com");
    const other = await signup(env, "x@example.com");
    const url = `/api/networks/${owner.nid}/stripe/status`;
    expect((await call(env, "GET", url, { token: await addMember(env, owner, "admin@example.com", "admin") })).status).toBe(200);
    expect((await call(env, "GET", url, { token: await addMember(env, owner, "creator@example.com", "creator") })).status).toBe(403);
    expect((await call(env, "GET", url, { token: await addMember(env, owner, "guest@example.com", "guest") })).status).toBe(403);
    expect((await call(env, "GET", url, { token: other.token })).status).toBe(403);
  });
});

describe("POST /api/stripe/webhook", () => {
  it("rejects a bad, missing, stale or wrong-secret signature with 400 and changes nothing", async () => {
    const { env } = makeEnv();
    stripeWithAccounts();
    const owner = await signup(env, "o@example.com");
    await call(env, "POST", `/api/networks/${owner.nid}/stripe/onboard`, { token: owner.token });
    const event = accountUpdated("acct_net1", { charges: true, payouts: true, details: true });
    const payload = JSON.stringify(event);

    expect((await postStripeWebhook(env, event, "t=1,v1=deadbeef")).status).toBe(400);
    expect((await postStripeWebhook(env, event, null)).status).toBe(400);
    expect((await postStripeWebhook(env, event, stripeSignatureHeader(payload, "some-other-secret"))).status).toBe(400);
    expect((await postStripeWebhook(env, event, stripeSignatureHeader(payload, env.STRIPE_WEBHOOK_SECRET, 1_000))).status).toBe(400);

    const row = await one<any>(env, "SELECT stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted FROM networks WHERE id = ?", owner.nid);
    expect(row).toEqual({ stripe_charges_enabled: 0, stripe_payouts_enabled: 0, stripe_details_submitted: 0 });
  });

  it("a valid account.updated flips the flags for the matching network only", async () => {
    const { env } = makeEnv();
    stripeWithAccounts();
    const a = await signup(env, "a@example.com");
    const b = await signup(env, "b@example.com");
    await call(env, "POST", `/api/networks/${a.nid}/stripe/onboard`, { token: a.token }); // acct_net1
    await call(env, "POST", `/api/networks/${b.nid}/stripe/onboard`, { token: b.token }); // acct_net2

    const r = await postStripeWebhook(env, accountUpdated("acct_net2", { charges: true, payouts: true, details: true }));
    expect(r.status).toBe(200);

    const flags = (id: string) =>
      one<any>(env, "SELECT stripe_charges_enabled c, stripe_payouts_enabled p, stripe_details_submitted d FROM networks WHERE id = ?", id);
    expect(await flags(b.nid)).toEqual({ c: 1, p: 1, d: 1 });
    expect(await flags(a.nid)).toEqual({ c: 0, p: 0, d: 0 });

    // capability revoked later: flags come back down
    await postStripeWebhook(env, accountUpdated("acct_net2", { details: true }, "evt_2"));
    expect(await flags(b.nid)).toEqual({ c: 0, p: 0, d: 1 });
  });

  it("ignores account.updated for an unknown account, and returns 200 for unknown event types", async () => {
    const { env } = makeEnv();
    stripeWithAccounts();
    const owner = await signup(env, "o@example.com");
    await call(env, "POST", `/api/networks/${owner.nid}/stripe/onboard`, { token: owner.token });

    expect((await postStripeWebhook(env, accountUpdated("acct_unknown", { charges: true, payouts: true, details: true }))).status).toBe(200);
    expect((await postStripeWebhook(env, { id: "evt_x", object: "event", type: "customer.created", data: { object: { id: "cus_1" } } })).status).toBe(200);
    const row = await one<any>(env, "SELECT stripe_charges_enabled FROM networks WHERE id = ?", owner.nid);
    expect(row.stripe_charges_enabled).toBe(0);
  });

  it("is public: no JWT needed", async () => {
    const { env } = makeEnv();
    const r = await postStripeWebhook(env, { id: "evt_p", object: "event", type: "ping", data: { object: {} } });
    expect(r.status).toBe(200);
  });
});
