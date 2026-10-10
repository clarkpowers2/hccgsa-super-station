import { describe, expect, it } from "vitest";
import app from "../src/index";
import { hit } from "../src/ratelimit";
import { call, makeEnv } from "./helpers";

const PW = "a-long-test-password";

async function signup(env: any, email: string) {
  const r = await call(env, "POST", "/api/auth/creator-register", { body: { email, password: PW, creatorName: email } });
  return { token: r.json.token as string, nid: r.json.network.id as string, pub: r.json.network.apiKeys.public as string, priv: r.json.network.apiKeys.private as string };
}

async function publishedEpisode(env: any, token: string, published = true) {
  const ep = await call(env, "POST", "/api/creator/episodes", { token, body: { title: "Public one" } });
  if (published) await env.DB.prepare("UPDATE episodes SET is_published = 1, audio_key = 'k', publish_date = datetime('now') WHERE id = ?").bind(ep.json.id).run();
  return ep.json.id as string;
}

const get = (env: any, path: string, key?: string, origin?: string) =>
  app.fetch(new Request(`http://localhost${path}`, { headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(origin ? { Origin: origin } : {}) } }), env);

describe("public API keys", () => {
  it("serves published episodes to public and private keys, hiding storage keys", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const id = await publishedEpisode(env, a.token);
    for (const key of [a.pub, a.priv]) {
      const res = await get(env, `/api/public/episodes/${id}`, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toMatchObject({ id, title: "Public one" });
      expect(JSON.stringify(body)).not.toContain("audio_key");
    }
  });

  it("returns 404 for unpublished or unknown episodes", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const draft = await publishedEpisode(env, a.token, false);
    expect((await get(env, `/api/public/episodes/${draft}`, a.pub)).status).toBe(404);
    expect((await get(env, "/api/public/episodes/nope", a.pub)).status).toBe(404);
  });

  it("rejects missing, malformed, wrong, and suspended-network keys", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    expect((await get(env, "/api/public/episodes/x")).status).toBe(401);
    expect((await get(env, "/api/public/episodes/x", "pk_deadbeef")).status).toBe(401);
    expect((await get(env, "/api/public/episodes/x", a.token)).status).toBe(401); // a JWT is not an API key
    await env.DB.prepare("UPDATE networks SET status = 'suspended' WHERE id = ?").bind(a.nid).run();
    expect((await get(env, "/api/public/episodes/x", a.pub)).status).toBe(401);
  });

  it("sets rate-limit headers and counts down", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const r1 = await get(env, "/api/public/episodes/x", a.pub);
    const r2 = await get(env, "/api/public/episodes/x", a.pub);
    expect(r1.headers.get("X-RateLimit-Limit")).toBe("1000");
    expect(r1.headers.get("X-RateLimit-Remaining")).toBe("999");
    expect(r2.headers.get("X-RateLimit-Remaining")).toBe("998");
    expect(Number(r2.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(Date.now() / 1000);
    expect((await get(env, "/api/public/episodes/x", a.priv)).headers.get("X-RateLimit-Limit")).toBe("10000");
  });

  it("returns 429 with Retry-After past the limit, per key type and per network", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const b = await signup(env, "b@example.com");
    const window = Math.floor(Date.now() / 1000 / 3600);
    await env.DB.prepare("INSERT INTO rate_limits (bucket, window, count) VALUES (?, ?, 1000)").bind(`${a.nid}:public`, window).run();

    const over = await get(env, "/api/public/episodes/x", a.pub);
    expect(over.status).toBe(429);
    expect(over.headers.get("X-RateLimit-Remaining")).toBe("0");
    const retry = Number(over.headers.get("Retry-After"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(3600);

    expect((await get(env, "/api/public/episodes/x", a.priv)).status).toBe(404); // a's private bucket is separate
    expect((await get(env, "/api/public/episodes/x", b.pub)).status).toBe(404); // b is unaffected
  });

  it("allows cross-origin browser calls with a key, while the dashboard API stays origin-restricted", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "a@example.com");
    const res = await get(env, "/api/public/episodes/x", a.pub, "https://someblog.example");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const pre = await app.fetch(
      new Request("http://localhost/api/public/episodes/x", { method: "OPTIONS", headers: { Origin: "https://someblog.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } }),
      env,
    );
    expect(pre.status).toBe(204);
    const dash = await get(env, "/api/health", undefined, "https://someblog.example");
    expect(dash.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("rate limiter", () => {
  it("resets in a new window and prunes old rows", async () => {
    const { env } = makeEnv();
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) await hit(env.DB, "n:public", 2, t0);
    const blocked = await hit(env.DB, "n:public", 2, t0);
    expect(blocked).toMatchObject({ allowed: false, remaining: 0 });
    const next = await hit(env.DB, "n:public", 2, t0 + 3600_000);
    expect(next).toMatchObject({ allowed: true, remaining: 1 });
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<any>();
    expect(rows.n).toBe(1);
  });
});
