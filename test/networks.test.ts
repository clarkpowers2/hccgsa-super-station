import { describe, expect, it } from "vitest";
import { verify } from "hono/jwt";
import { call, makeEnv, registerCreator } from "./helpers";

const mkEpisode = (env: any, token: string, title = "Pilot") =>
  call(env, "POST", "/api/creator/episodes", { token, body: { title } });

async function twoNetworks() {
  const { env } = makeEnv();
  const a = await registerCreator(env, "a@example.com");
  const b = await registerCreator(env, "b@example.com");
  const ep = await mkEpisode(env, a.token, "A's episode");
  return { env, a, b, episodeId: ep.json.id as string };
}

describe("network provisioning", () => {
  it("creator registration creates an active network, keys, and JWT claims", async () => {
    const { env } = makeEnv();
    const r = await call(env, "POST", "/api/auth/creator-register", {
      body: { email: "c@example.com", password: "a-long-test-password", creatorName: "Net Zero AI" },
    });
    expect(r.status).toBe(201);
    expect(r.json.network).toMatchObject({ slug: "net-zero-ai", status: "active", stripe: { status: "not_connected" } });
    expect(r.json.network.apiKeys.public).toMatch(/^pk_/);
    expect(r.json.network.apiKeys.private).toMatch(/^sk_/);
    const claims = await verify(r.json.token, "test-only-secret-not-real", "HS256");
    expect(claims).toMatchObject({ network_id: r.json.network.id, role: "owner" });

    // Only hashes are stored.
    const row = await env.DB.prepare("SELECT public_api_key_hash FROM networks WHERE id = ?").bind(r.json.network.id).first<any>();
    expect(row.public_api_key_hash).not.toContain("pk_");
  });

  it("gives colliding names distinct slugs and rolls back on duplicate email", async () => {
    const { env } = makeEnv();
    const reg = (email: string) =>
      call(env, "POST", "/api/auth/creator-register", { body: { email, password: "a-long-test-password", creatorName: "Same Name" } });
    const one = await reg("1@example.com");
    const two = await reg("2@example.com");
    expect(two.json.network.slug).not.toBe(one.json.network.slug);
    expect((await reg("1@example.com")).status).toBe(409);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM networks").first<any>();
    expect(count.n).toBe(3); // seeded net_freqone + 2 signups; the failed signup left no orphan
  });

  it("lets a viewer create a network once, and rotates their token", async () => {
    const { env } = makeEnv();
    const v = await call(env, "POST", "/api/auth/register", { body: { email: "v@example.com", password: "a-long-test-password", creatorName: "V" } });
    expect((await mkEpisode(env, v.json.token)).status).toBe(403);
    const made = await call(env, "POST", "/api/networks/create", { token: v.json.token, body: { displayName: "Viewer FM" } });
    expect(made.status).toBe(201);
    expect((await mkEpisode(env, made.json.token)).status).toBe(201);
    expect((await call(env, "POST", "/api/networks/create", { token: made.json.token, body: { displayName: "Again" } })).status).toBe(409);
  });
});

describe("network isolation", () => {
  it("network B cannot read or modify network A's data through any creator route", async () => {
    const { env, b, episodeId } = await twoNetworks();
    expect((await call(env, "GET", `/api/creator/episodes/${episodeId}`, { token: b.token })).status).toBe(404);
    expect((await call(env, "PUT", `/api/creator/episodes/${episodeId}`, { token: b.token, body: { title: "x" } })).status).toBe(404);
    expect((await call(env, "POST", `/api/creator/episodes/${episodeId}/uploads`, { token: b.token, body: { kind: "audio", contentType: "audio/mpeg", sizeBytes: 5 } })).status).toBe(404);
    expect((await call(env, "GET", "/api/creator/episodes", { token: b.token })).json.episodes).toHaveLength(0);
    expect((await call(env, "GET", "/api/creator/analytics", { token: b.token })).json.totalEpisodes).toBe(0);
  });

  it("a user whose network changed cannot see episodes left in the old network", async () => {
    const { env, a, episodeId } = await twoNetworks();
    const other = await env.DB.prepare("SELECT id FROM networks WHERE owner_id != (SELECT id FROM users WHERE email = 'a@example.com')").first<any>();
    await env.DB.prepare("UPDATE users SET network_id = ? WHERE email = 'a@example.com'").bind(other.id).run();
    const fresh = (await call(env, "POST", "/api/auth/refresh-token", { token: a.token })).json.token;
    expect((await call(env, "GET", `/api/creator/episodes/${episodeId}`, { token: fresh })).status).toBe(404);
    expect((await call(env, "GET", "/api/creator/episodes", { token: fresh })).json.episodes).toHaveLength(0);
  });

  it("new episodes take network_id from the token, not the request", async () => {
    const { env, a } = await twoNetworks();
    const r = await call(env, "POST", "/api/creator/episodes", { token: a.token, body: { title: "t", network_id: "net_freqone" } });
    const row = await env.DB.prepare("SELECT network_id FROM episodes WHERE id = ?").bind(r.json.id).first<any>();
    expect(row.network_id).not.toBe("net_freqone");
  });
});

describe("network endpoint and RBAC", () => {
  it("owner can read own network with masked keys; other networks get 403", async () => {
    const { env } = makeEnv();
    const a = await call(env, "POST", "/api/auth/creator-register", { body: { email: "a@example.com", password: "a-long-test-password", creatorName: "A" } });
    const b = await call(env, "POST", "/api/auth/creator-register", { body: { email: "b@example.com", password: "a-long-test-password", creatorName: "B" } });
    const own = await call(env, "GET", `/api/networks/${a.json.network.id}`, { token: a.json.token });
    expect(own.status).toBe(200);
    expect(own.json.apiKeys.public).toMatch(/^pk_….{4}$/);
    expect(JSON.stringify(own.json)).not.toContain(a.json.network.apiKeys.private);
    expect((await call(env, "GET", `/api/networks/${a.json.network.id}`, { token: b.json.token })).status).toBe(403);
  });

  it("guests are blocked from creator and network-admin routes; stale tokens are rejected", async () => {
    const { env, a } = await twoNetworks();
    const net = await env.DB.prepare("SELECT network_id FROM users WHERE email = 'a@example.com'").first<any>();
    await env.DB.prepare("UPDATE users SET role = 'guest' WHERE email = 'a@example.com'").run();
    const guest = (await call(env, "POST", "/api/auth/refresh-token", { token: a.token })).json.token;
    expect((await call(env, "GET", "/api/creator/episodes", { token: guest })).status).toBe(403);
    expect((await call(env, "GET", `/api/networks/${net.network_id}`, { token: guest })).status).toBe(403);

    const { sign } = await import("hono/jwt");
    const legacy = await sign({ sub: "u", isCreator: true, exp: Math.floor(Date.now() / 1000) + 600 }, "test-only-secret-not-real");
    expect((await call(env, "GET", "/api/creator/episodes", { token: legacy })).status).toBe(401);
  });
});
