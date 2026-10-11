import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call, makeEnv, one, all, run } from "./helpers";
import { deliverDueWebhooks } from "../src/webhook-sender";
import { encryptSecret, decryptSecret } from "../src/webhook-crypto";
import { signPayload, verifyPayload } from "../src/webhook-signing";

const PW = "a-long-test-password";
afterEach(() => vi.restoreAllMocks());

async function owner(env: any, email: string) {
  const r = await call(env, "POST", "/api/auth/creator-register", { body: { email, password: PW, creatorName: email } });
  return { token: r.json.token as string, nid: r.json.network.id as string };
}
async function register(env: any, o: { token: string; nid: string }, url: string, events: string[]) {
  const r = await call(env, "POST", `/api/networks/${o.nid}/webhooks`, { token: o.token, body: { url, events } });
  expect(r.status).toBe(201);
  return r.json as { id: string; secret: string };
}
const okFetch = () => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

describe("signing", () => {
  it("matches an independent HMAC-SHA256 computation and rejects a tampered body", async () => {
    const secret = "whsec_test_value";
    const body = '{"id":"e1"}';
    const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(await signPayload(secret, body)).toBe(expected);
    expect(await verifyPayload(secret, body, expected)).toBe(true);
    expect(await verifyPayload(secret, '{"id":"e2"}', expected)).toBe(false);
    expect(await verifyPayload(secret, body, null)).toBe(false);
  });
});

describe("secret encryption", () => {
  it("round-trips, stores no plaintext, and fails under a different key", async () => {
    const { env } = makeEnv();
    const ct = await encryptSecret(env, "whsec_abc");
    expect(ct).not.toContain("whsec_abc");
    expect(await decryptSecret(env, ct)).toBe("whsec_abc");
    const other = { ...env, WEBHOOK_ENC_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") } as any;
    await expect(decryptSecret(other, ct)).rejects.toThrow();
  });
});

describe("delivery", () => {
  it("sends the signature header, and it verifies against the exact body sent", async () => {
    const { env } = makeEnv();
    const a = await owner(env, "a@example.com");
    const hook = await register(env, a, "https://hooks.example.com/in", ["episode.created"]);
    const f = okFetch();
    const created = await call(env, "POST", "/api/creator/episodes", { token: a.token, body: { title: "Hello" } });
    expect(created.status).toBe(201);
    expect(await deliverDueWebhooks(env)).toBe(1);

    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/in");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Webhook-Event"]).toBe("episode.created");
    expect(await verifyPayload(hook.secret, init.body as string, headers["X-Webhook-Signature"] ?? null)).toBe(true);
    const row = await one<{ status: string }>(env, "SELECT status FROM webhook_deliveries");
    expect(row?.status).toBe("delivered");
  });

  it("retries 4 times with 5, 15, 60 minute waits, then marks failed", async () => {
    const { env } = makeEnv();
    const a = await owner(env, "r@example.com");
    await register(env, a, "https://hooks.example.com/in", ["episode.created"]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await call(env, "POST", "/api/creator/episodes", { token: a.token, body: { title: "Retry me" } });

    const waits: number[] = [];
    for (let i = 1; i <= 4; i++) {
      await deliverDueWebhooks(env);
      const d = await one<{ status: string; attempts: number; next: number | null }>(
        env,
        "SELECT status, attempts, CAST(strftime('%s', next_attempt_at) AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) AS next FROM webhook_deliveries",
      );
      expect(d!.attempts).toBe(i);
      if (i < 4) {
        expect(d!.status).toBe("pending");
        waits.push(d!.next!);
        // Make the row due again without waiting; the schedule itself is what is under test.
        await run(env, "UPDATE webhook_deliveries SET next_attempt_at = datetime('now', '-1 second')");
      } else {
        expect(d!.status).toBe("failed");
      }
    }
    expect(waits).toHaveLength(3);
    const [w1, w2, w3] = waits as [number, number, number];
    expect(w1).toBeGreaterThan(290);
    expect(w1).toBeLessThanOrEqual(300);
    expect(w2).toBeGreaterThan(890);
    expect(w2).toBeLessThanOrEqual(900);
    expect(w3).toBeGreaterThan(3590);
    expect(w3).toBeLessThanOrEqual(3600);
  });

  it("filters by event type: a publish-only subscriber does not get created events", async () => {
    const { env } = makeEnv();
    const a = await owner(env, "f@example.com");
    await register(env, a, "https://hooks.example.com/pub", ["episode.published"]);
    const f = okFetch();
    const ep = await call(env, "POST", "/api/creator/episodes", { token: a.token, body: { title: "Filter" } });
    await call(env, "PUT", `/api/creator/episodes/${ep.json.id}`, { token: a.token, body: { isPublished: true } });
    // Publishing needs media; the transition check is what matters, so the write may 409 without an upload.
    await deliverDueWebhooks(env);
    const events = (await all<{ event_type: string }>(env, "SELECT event_type FROM webhook_deliveries")).map((r) => r.event_type);
    expect(events.every((e) => e === "episode.published")).toBe(true);
    expect(f.mock.calls.length).toBe(events.length);
  });

  it("network isolation: network A's episode events never create deliveries for network B", async () => {
    const { env } = makeEnv();
    const a = await owner(env, "na@example.com");
    const b = await owner(env, "nb@example.com");
    await register(env, a, "https://hooks.example.com/a", ["episode.created"]);
    await register(env, b, "https://hooks.example.com/b", ["episode.created"]);
    okFetch();
    await call(env, "POST", "/api/creator/episodes", { token: a.token, body: { title: "A only" } });
    const rows = await all<{ network_id: string; url: string }>(
      env,
      "SELECT d.network_id, w.url FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.network_id).toBe(a.nid);
    expect(rows[0]?.url).toBe("https://hooks.example.com/a");
    const list = await call(env, "GET", `/api/networks/${b.nid}/webhooks`, { token: b.token });
    expect(list.json.webhooks.map((w: any) => w.url)).toEqual(["https://hooks.example.com/b"]);
  });

  it("refuses private and malformed targets at registration", async () => {
    const { env } = makeEnv();
    const a = await owner(env, "u@example.com");
    for (const url of ["http://hooks.example.com", "https://127.0.0.1/x", "https://10.0.0.1/x", "https://[::1]/x", "https://user:pass@hooks.example.com", "https://localhost/x", "https://svc.localhost/x", "https://intranet/x"]) {
      expect((await call(env, "POST", `/api/networks/${a.nid}/webhooks`, { token: a.token, body: { url, events: ["episode.created"] } })).status).toBe(400);
    }
  });

  it("does not follow redirects and counts a 3xx as a failed attempt", async () => {
    const { env } = makeEnv();
    const a = await owner(env, "rd@example.com");
    await register(env, a, "https://hooks.example.com/in", ["episode.created"]);
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://169.254.169.254/" } }));
    await call(env, "POST", "/api/creator/episodes", { token: a.token, body: { title: "Redirect" } });
    await deliverDueWebhooks(env);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0]?.[1] as RequestInit).redirect).toBe("manual");
    const d = await one<{ status: string; last_status_code: number }>(env, "SELECT status, last_status_code FROM webhook_deliveries");
    expect(d).toMatchObject({ status: "pending", last_status_code: 302 });
  });

  it("never exposes the secret in listings, payloads, or logs", async () => {
    const { env } = makeEnv();
    const a = await owner(env, "s@example.com");
    const hook = await register(env, a, "https://hooks.example.com/in", ["episode.created"]);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(JSON.stringify(args)));
    vi.spyOn(console, "error").mockImplementation((...args) => logs.push(JSON.stringify(args)));
    okFetch();
    await call(env, "POST", "/api/creator/episodes", { token: a.token, body: { title: "Secret check" } });
    await deliverDueWebhooks(env);
    const list = await call(env, "GET", `/api/networks/${a.nid}/webhooks`, { token: a.token });
    expect(JSON.stringify(list.json)).not.toContain(hook.secret);
    const payloads = await all<{ payload: string }>(env, "SELECT payload FROM webhook_deliveries");
    expect(JSON.stringify(payloads)).not.toContain(hook.secret);
    const stored = await one<{ secret_ciphertext: string }>(env, "SELECT secret_ciphertext FROM webhooks");
    expect(stored!.secret_ciphertext).not.toContain(hook.secret);
    expect(logs.join("\n")).not.toContain(hook.secret);
    expect(logs.join("\n")).not.toContain("hooks.example.com");
  });
});
