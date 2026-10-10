import { describe, expect, it } from "vitest";
import { call, makeEnv } from "./helpers";

const PW = "a-long-test-password";

async function signup(env: any, email: string, name = "Owner") {
  const r = await call(env, "POST", "/api/auth/creator-register", { body: { email, password: PW, creatorName: name } });
  return { token: r.json.token as string, id: r.json.id as string, nid: r.json.network.id as string };
}

/** Owner invites `email` with `role`, invitee accepts. */
async function addMember(env: any, owner: { token: string; nid: string }, email: string, role: string) {
  const inv = await call(env, "POST", `/api/networks/${owner.nid}/users`, { token: owner.token, body: { email, role } });
  expect(inv.status).toBe(201);
  const token = new URL(inv.json.inviteUrl).searchParams.get("token");
  const acc = await call(env, "POST", "/api/auth/accept-invite", { body: { token, password: PW, creatorName: email } });
  expect(acc.status).toBe(201);
  return { token: acc.json.token as string, id: acc.json.id as string };
}

describe("invites", () => {
  it("runs pending -> accepted and joins the invitee to the inviter's network with the chosen role", async () => {
    const { env } = makeEnv();
    const owner = await signup(env, "o@example.com");
    const inv = await call(env, "POST", `/api/networks/${owner.nid}/users`, { token: owner.token, body: { email: "New@Example.com", role: "creator" } });
    expect(inv.json.inviteUrl).toContain("/accept-invite?token=");
    const token = new URL(inv.json.inviteUrl).searchParams.get("token");

    const before = await call(env, "GET", `/api/networks/${owner.nid}/users`, { token: owner.token });
    expect(before.json.pendingInvites).toMatchObject([{ email: "new@example.com", role: "creator" }]);
    expect(before.json.users).toHaveLength(1);

    const acc = await call(env, "POST", "/api/auth/accept-invite", { body: { token, password: PW, creatorName: "New" } });
    expect(acc.status).toBe(201);
    expect(acc.json).toMatchObject({ networkId: owner.nid, role: "creator" });
    expect((await call(env, "POST", "/api/creator/episodes", { token: acc.json.token, body: { title: "From invitee" } })).status).toBe(201);

    const after = await call(env, "GET", `/api/networks/${owner.nid}/users`, { token: owner.token });
    expect(after.json.pendingInvites).toHaveLength(0);
    expect(after.json.users.map((u: any) => u.email)).toContain("new@example.com");

    // single use
    expect((await call(env, "POST", "/api/auth/accept-invite", { body: { token, password: PW, creatorName: "Again" } })).status).toBe(410);
  });

  it("rejects expired and unknown tokens, taken emails, and bad input", async () => {
    const { env } = makeEnv();
    const owner = await signup(env, "o@example.com");
    const body = (email: string, role = "creator") => ({ token: owner.token, body: { email, role } });
    expect((await call(env, "POST", `/api/networks/${owner.nid}/users`, body("o@example.com"))).status).toBe(409);
    expect((await call(env, "POST", `/api/networks/${owner.nid}/users`, body("x@example.com", "owner"))).status).toBe(400);
    expect((await call(env, "POST", `/api/networks/${owner.nid}/users`, body("nope"))).status).toBe(400);

    const inv = await call(env, "POST", `/api/networks/${owner.nid}/users`, body("late@example.com"));
    await env.DB.prepare("UPDATE invites SET expires_at = datetime('now', '-1 hour')").run();
    const token = new URL(inv.json.inviteUrl).searchParams.get("token");
    expect((await call(env, "POST", "/api/auth/accept-invite", { body: { token, password: PW, creatorName: "L" } })).status).toBe(410);
    expect((await call(env, "POST", "/api/auth/accept-invite", { body: { token: "bogus", password: PW, creatorName: "L" } })).status).toBe(410);
  });

  it("stores only a hash of the invite token", async () => {
    const { env } = makeEnv();
    const owner = await signup(env, "o@example.com");
    const inv = await call(env, "POST", `/api/networks/${owner.nid}/users`, { token: owner.token, body: { email: "h@example.com", role: "guest" } });
    const token = new URL(inv.json.inviteUrl).searchParams.get("token")!;
    const row = await env.DB.prepare("SELECT token_hash FROM invites").first<any>();
    expect(row.token_hash).not.toContain(token);
  });
});

describe("role enforcement and isolation", () => {
  it("only the owner can invite or change users; admins can list; creators cannot", async () => {
    const { env } = makeEnv();
    const owner = await signup(env, "o@example.com");
    const admin = await addMember(env, owner, "admin@example.com", "admin");
    const creator = await addMember(env, owner, "creator@example.com", "creator");
    const url = `/api/networks/${owner.nid}/users`;
    expect((await call(env, "POST", url, { token: admin.token, body: { email: "z@example.com", role: "guest" } })).status).toBe(403);
    expect((await call(env, "PUT", `${url}/${creator.id}`, { token: admin.token, body: { role: "guest" } })).status).toBe(403);
    expect((await call(env, "GET", url, { token: admin.token })).status).toBe(200);
    expect((await call(env, "GET", url, { token: creator.token })).status).toBe(403);
    expect((await call(env, "PUT", `${url.replace("/users", "")}/settings`, { token: creator.token, body: { description: "x" } })).status).toBe(403);
  });

  it("returns 403 for every admin route on another network, and never lists its users", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const b = await signup(env, "b@example.com");
    const base = `/api/networks/${a.nid}`;
    for (const [m, p, body] of [
      ["GET", "/users"], ["POST", "/users", { email: "q@example.com", role: "guest" }], ["PUT", `/users/${a.id}`, { role: "guest" }],
      ["PUT", "/settings", { description: "x" }], ["GET", "/webhooks"], ["POST", "/webhooks", { url: "https://x.example.com", events: ["stream.ended"] }],
      ["DELETE", "/webhooks/abc"],
    ] as const) {
      expect((await call(env, m, base + p, { token: b.token, body })).status, `${m} ${p}`).toBe(403);
    }
    const mine = await call(env, "GET", `/api/networks/${b.nid}/users`, { token: b.token });
    expect(mine.json.users.map((u: any) => u.email)).toEqual(["b@example.com"]);
  });
});

describe("revoking and changing members", () => {
  it("a revoked member is locked out immediately, cannot log in, and drops off the list", async () => {
    const { env } = makeEnv();
    const owner = await signup(env, "o@example.com");
    const m = await addMember(env, owner, "m@example.com", "creator");
    const r = await call(env, "PUT", `/api/networks/${owner.nid}/users/${m.id}`, { token: owner.token, body: { deleted: true } });
    expect(r.status).toBe(200);
    expect((await call(env, "GET", "/api/creator/episodes", { token: m.token })).status).toBe(401);
    expect((await call(env, "POST", "/api/auth/login", { body: { email: "m@example.com", password: PW } })).status).toBe(401);
    const list = await call(env, "GET", `/api/networks/${owner.nid}/users`, { token: owner.token });
    expect(list.json.users.map((u: any) => u.email)).toEqual(["o@example.com"]);
  });

  it("role changes apply on the next request; owner is protected; other networks' users are 404", async () => {
    const { env } = makeEnv();
    const owner = await signup(env, "o@example.com");
    const other = await signup(env, "x@example.com");
    const m = await addMember(env, owner, "m@example.com", "creator");
    const url = `/api/networks/${owner.nid}/users`;
    expect((await call(env, "GET", "/api/creator/episodes", { token: m.token })).status).toBe(200);
    await call(env, "PUT", `${url}/${m.id}`, { token: owner.token, body: { role: "guest" } });
    expect((await call(env, "GET", "/api/creator/episodes", { token: m.token })).status).toBe(403); // same token, no re-login
    expect((await call(env, "PUT", `${url}/${owner.id}`, { token: owner.token, body: { deleted: true } })).status).toBe(409);
    expect((await call(env, "PUT", `${url}/${other.id}`, { token: owner.token, body: { deleted: true } })).status).toBe(404);
    expect((await call(env, "PUT", `${url}/${m.id}`, { token: owner.token, body: {} })).status).toBe(400);
  });
});

describe("settings", () => {
  it("updates name, description and branding for owner and admin, validating input", async () => {
    const { env } = makeEnv();
    const owner = await signup(env, "o@example.com");
    const admin = await addMember(env, owner, "a@example.com", "admin");
    const url = `/api/networks/${owner.nid}/settings`;
    const r = await call(env, "PUT", url, { token: admin.token, body: { displayName: "Renamed", description: "About", branding: { color: "#fff" } } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ displayName: "Renamed", description: "About", branding: { color: "#fff" }, slug: "owner" });
    expect((await call(env, "PUT", url, { token: owner.token, body: { displayName: "" } })).status).toBe(400);
    expect((await call(env, "PUT", url, { token: owner.token, body: { branding: [1] } })).status).toBe(400);
    expect((await call(env, "PUT", url, { token: owner.token, body: {} })).status).toBe(400);
  });
});

describe("webhooks", () => {
  it("registers, lists without the secret, filters input, and deletes within the network", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const b = await signup(env, "b@example.com");
    const url = `/api/networks/${a.nid}/webhooks`;
    const made = await call(env, "POST", url, { token: a.token, body: { url: "https://hooks.example.com/x", events: ["episode.created", "episode.created", "stream.started"] } });
    expect(made.status).toBe(201);
    expect(made.json.secret).toMatch(/^whsec_/);
    expect(made.json.events).toEqual(["episode.created", "stream.started"]);

    const list = await call(env, "GET", url, { token: a.token });
    expect(list.json.webhooks).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain("whsec_");

    for (const bad of [
      { url: "http://hooks.example.com", events: ["stream.ended"] },
      { url: "https://localhost/x", events: ["stream.ended"] },
      { url: "https://169.254.169.254/latest", events: ["stream.ended"] },
      { url: "https://hooks.example.com", events: ["nope"] },
      { url: "https://hooks.example.com", events: [] },
    ])
      expect((await call(env, "POST", url, { token: a.token, body: bad })).status).toBe(400);

    // network b cannot see or delete a's webhook (403 on a's path; 404 on its own path)
    expect((await call(env, "DELETE", `${url}/${made.json.id}`, { token: b.token })).status).toBe(403);
    expect((await call(env, "DELETE", `/api/networks/${b.nid}/webhooks/${made.json.id}`, { token: b.token })).status).toBe(404);
    expect((await call(env, "DELETE", `${url}/${made.json.id}`, { token: a.token })).status).toBe(200);
    expect((await call(env, "GET", url, { token: a.token })).json.webhooks).toHaveLength(0);
  });

  it("caps webhooks per network", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const url = `/api/networks/${a.nid}/webhooks`;
    for (let i = 0; i < 10; i++)
      expect((await call(env, "POST", url, { token: a.token, body: { url: `https://h${i}.example.com`, events: ["stream.ended"] } })).status).toBe(201);
    expect((await call(env, "POST", url, { token: a.token, body: { url: "https://h99.example.com", events: ["stream.ended"] } })).status).toBe(409);
  });
});
