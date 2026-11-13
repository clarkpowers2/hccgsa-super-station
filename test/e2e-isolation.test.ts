// End-to-end multi-network isolation. Fills the gaps left by networks.test.ts and
// network-admin.test.ts; it does not repeat what those already cover:
//   - creator GET/PUT/uploads/list/analytics on another network's episode (networks.test.ts)
//   - revoked member gets 401 on the next request (network-admin.test.ts)
//   - role change applies on the next request, same token (network-admin.test.ts)
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { deliverDueWebhooks } from "../src/webhook-sender";
import { verifyPayload } from "../src/webhook-signing";
import { all, call, makeEnv, run } from "./helpers";

const PW = "a-long-test-password";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function signup(env: any, email: string) {
  const r = await call(env, "POST", "/api/auth/creator-register", { body: { email, password: PW, creatorName: email } });
  expect(r.status).toBe(201);
  return {
    token: r.json.token as string,
    id: r.json.id as string,
    nid: r.json.network.id as string,
    pub: r.json.network.apiKeys.public as string,
    priv: r.json.network.apiKeys.private as string,
  };
}

async function addMember(env: any, owner: { token: string; nid: string }, email: string, role: string) {
  const inv = await call(env, "POST", `/api/networks/${owner.nid}/users`, { token: owner.token, body: { email, role } });
  expect(inv.status).toBe(201);
  const token = new URL(inv.json.inviteUrl).searchParams.get("token");
  const acc = await call(env, "POST", "/api/auth/accept-invite", { body: { token, password: PW, creatorName: email } });
  expect(acc.status).toBe(201);
  return { token: acc.json.token as string, id: acc.json.id as string };
}

async function episode(env: any, token: string, title: string) {
  const r = await call(env, "POST", "/api/creator/episodes", { token, body: { title } });
  expect(r.status).toBe(201);
  return r.json.id as string;
}

/** Bearer-key GET against the public API (call() only sends JWTs, which is the same header shape). */
async function publicGet(env: any, path: string, key: string) {
  const res = await app.fetch(new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${key}` } }), env);
  return { status: res.status, json: (await res.json()) as any };
}

/** Two networks, each with an owner and one draft episode. A's episode has audio, a transcript and a thumbnail. */
async function twoNetworks() {
  const { env, objects } = makeEnv();
  const a = await signup(env, "a@example.com");
  const b = await signup(env, "b@example.com");
  const epA = await episode(env, a.token, "A secret draft");
  const epB = await episode(env, b.token, "B draft");
  await run(
    env,
    "UPDATE episodes SET audio_key = 'a/audio.mp3', thumbnail_key = 'a/thumb.jpg', transcript_text = 'A-only transcript', transcript_status = 'done' WHERE id = ?",
    epA,
  );
  return { env, objects, a, b, epA, epB };
}

describe("episode isolation between networks", () => {
  it("B's owner cannot reach A's episode through the remaining creator routes", async () => {
    const { env, a, b, epA } = await twoNetworks();
    const base = `/api/creator/episodes/${epA}`;
    for (const [m, p, body] of [
      ["POST", "/uploads/complete", { kind: "audio", key: `networks/${a.nid}/x` }],
      ["POST", "/transcribe", undefined],
      ["GET", "/transcript", undefined],
      ["GET", "/media/audio", undefined],
      ["GET", "/media/thumbnail", undefined],
    ] as const) {
      const r = await call(env, m, base + p, { token: b.token, body });
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(JSON.stringify(r.json)).not.toContain("A-only transcript");
    }
    // The owner still has full access, so the 404s above are about network, not a broken episode.
    expect((await call(env, "GET", `${base}/transcript`, { token: a.token })).json.transcript).toBe("A-only transcript");
    // A's row is untouched by B's attempts.
    const [row] = await all<{ audio_key: string; transcript_status: string }>(env, "SELECT audio_key, transcript_status FROM episodes WHERE id = ?", epA);
    expect(row).toEqual({ audio_key: "a/audio.mp3", transcript_status: "done" });
  });

  it("an invited creator in B cannot reach A's episode either", async () => {
    const { env, b, epA } = await twoNetworks();
    const bc = await addMember(env, b, "bc@example.com", "creator");
    expect((await call(env, "GET", `/api/creator/episodes/${epA}`, { token: bc.token })).status).toBe(404);
    expect((await call(env, "PUT", `/api/creator/episodes/${epA}`, { token: bc.token, body: { title: "hijack" } })).status).toBe(404);
    expect((await call(env, "GET", "/api/creator/episodes", { token: bc.token })).json.episodes.map((e: any) => e.title)).not.toContain("A secret draft");
  });

  it("public API: B's keys never see A's drafts, and get only the public view of A's published episode", async () => {
    const { env, a, b, epA } = await twoNetworks();
    // Drafts are invisible to every key, including A's own, and in the anonymous listing.
    for (const key of [b.pub, b.priv, a.pub])
      expect((await publicGet(env, `/api/public/episodes/${epA}`, key)).status).toBe(404);
    expect((await call(env, "GET", `/api/episodes/${epA}`)).status).toBe(404);
    expect(JSON.stringify((await call(env, "GET", "/api/episodes")).json)).not.toContain("A secret draft");

    // Once published, any network's key can read it (src/public.ts: "global scope" by design),
    // but only the public projection: no storage keys, transcript text, or network internals.
    await run(env, "UPDATE episodes SET is_published = 1, publish_date = datetime('now') WHERE id = ?", epA);
    for (const key of [b.pub, b.priv]) {
      const r = await publicGet(env, `/api/public/episodes/${epA}`, key);
      expect(r.status).toBe(200);
      const s = JSON.stringify(r.json);
      for (const leak of ["a/audio.mp3", "A-only transcript", "audio_key", "network_id", a.nid, a.pub, a.priv])
        expect(s, leak).not.toContain(leak);
    }
  });
});

describe("guest tokens", () => {
  // Every creator and network-admin route on the base branch. ':e' is the guest's own network's episode.
  const routes = (nid: string, e: string, uid: string) =>
    [
      ["GET", "/api/creator/profile"],
      ["PUT", "/api/creator/profile", { creatorName: "x" }],
      ["POST", "/api/creator/episodes", { title: "x" }],
      ["GET", "/api/creator/episodes"],
      ["GET", `/api/creator/episodes/${e}`],
      ["PUT", `/api/creator/episodes/${e}`, { title: "x" }],
      ["POST", `/api/creator/episodes/${e}/uploads`, { kind: "audio", contentType: "audio/mpeg", sizeBytes: 5 }],
      ["POST", `/api/creator/episodes/${e}/uploads/complete`, { kind: "audio", key: "k" }],
      ["POST", `/api/creator/episodes/${e}/transcribe`],
      ["GET", `/api/creator/episodes/${e}/transcript`],
      ["GET", `/api/creator/episodes/${e}/media/audio`],
      ["GET", "/api/creator/analytics"],
      ["POST", "/api/creator/connect/onboarding"],
      ["GET", "/api/creator/connect/status"],
      ["GET", "/api/creator/earnings"],
      ["GET", "/api/creator/payouts"],
      ["GET", "/api/creator/subscribers"],
      ["GET", `/api/networks/${nid}`],
      ["PUT", `/api/networks/${nid}/settings`, { description: "x" }],
      ["GET", `/api/networks/${nid}/earnings`],
      ["GET", `/api/networks/${nid}/payouts`],
      ["GET", `/api/networks/${nid}/users`],
      ["POST", `/api/networks/${nid}/users`, { email: "q@example.com", role: "guest" }],
      ["PUT", `/api/networks/${nid}/users/${uid}`, { role: "admin" }],
      ["POST", `/api/networks/${nid}/webhooks`, { url: "https://hooks.example.com/g", events: ["episode.created"] }],
      ["GET", `/api/networks/${nid}/webhooks`],
      ["DELETE", `/api/networks/${nid}/webhooks/abc`],
      ["POST", `/api/networks/${nid}/stripe/onboard`],
      ["GET", `/api/networks/${nid}/stripe/status`],
    ] as const;

  async function assertBlocked(env: any, token: string, nid: string, e: string, uid: string) {
    // Any outbound call (Stripe, webhooks) would mean a guest got past the gate.
    const f = vi.fn(async () => {
      throw new Error("no network calls expected");
    });
    vi.stubGlobal("fetch", f);
    for (const [m, p, body] of routes(nid, e, uid)) {
      const r = await call(env, m, p, { token, body: body as unknown });
      expect(r.status, `${m} ${p}`).toBe(403);
    }
    expect(f).not.toHaveBeenCalled();
  }

  it("an invited guest is 403 on every creator and network-admin route, and nothing changes", async () => {
    const { env } = makeEnv();
    const o = await signup(env, "o@example.com");
    const e = await episode(env, o.token, "Owner ep");
    const g = await addMember(env, o, "g@example.com", "guest");
    await assertBlocked(env, g.token, o.nid, e, g.id);
    const [u] = await all<{ role: string }>(env, "SELECT role FROM users WHERE id = ?", g.id);
    expect(u!.role).toBe("guest");
    expect(await all(env, "SELECT id FROM webhooks")).toHaveLength(0);
    expect(await all(env, "SELECT id FROM invites WHERE email = 'q@example.com'")).toHaveLength(0);
  });

  it("a demoted creator is 403 everywhere with the old token, even if is_creator were left at 1", async () => {
    const { env } = makeEnv();
    const o = await signup(env, "o@example.com");
    const c = await addMember(env, o, "c@example.com", "creator");
    const e = await episode(env, c.token, "Creator ep");
    expect((await call(env, "PUT", `/api/networks/${o.nid}/users/${c.id}`, { token: o.token, body: { role: "guest" } })).status).toBe(200);
    // Demotion clears is_creator today; force it back so the role gate is tested on its own,
    // since requireCreator alone would let this row through.
    await run(env, "UPDATE users SET is_creator = 1 WHERE id = ?", c.id);
    await assertBlocked(env, c.token, o.nid, e, c.id);
  });
});

describe("webhook delivery isolation", () => {
  it("each network's deliveries go only to its own URL, signed only with its own secret", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "wa@example.com");
    const b = await signup(env, "wb@example.com");
    const reg = async (o: typeof a, url: string) => {
      const r = await call(env, "POST", `/api/networks/${o.nid}/webhooks`, { token: o.token, body: { url, events: ["episode.created"] } });
      expect(r.status).toBe(201);
      return r.json as { id: string; secret: string };
    };
    const hookA = await reg(a, "https://hooks.example.com/a");
    const hookB = await reg(b, "https://hooks.example.com/b");
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    const epA = await episode(env, a.token, "A event");
    const epB = await episode(env, b.token, "B event");
    expect(await deliverDueWebhooks(env)).toBe(2);

    const sent = f.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }));
    expect(sent).toHaveLength(2);
    for (const { url, init } of sent) {
      const body = String(init.body);
      const sig = (init.headers as Record<string, string>)["X-Webhook-Signature"] ?? null;
      const [mine, theirs, myEp, theirEp] =
        url.endsWith("/a") ? [hookA, hookB, epA, epB] : [hookB, hookA, epB, epA];
      expect(body).toContain(myEp);
      expect(body).not.toContain(theirEp);
      expect(await verifyPayload(mine.secret, body, sig)).toBe(true);
      expect(await verifyPayload(theirs.secret, body, sig)).toBe(false);
    }

    // Each network's listing shows only its own webhook, and B cannot delete A's (nor its deliveries).
    const listB = await call(env, "GET", `/api/networks/${b.nid}/webhooks`, { token: b.token });
    expect(listB.json.webhooks.map((w: any) => w.id)).toEqual([hookB.id]);
    expect(JSON.stringify(listB.json)).not.toContain("hooks.example.com/a");
    expect((await call(env, "GET", `/api/networks/${a.nid}/webhooks`, { token: b.token })).status).toBe(403);
    expect((await call(env, "DELETE", `/api/networks/${b.nid}/webhooks/${hookA.id}`, { token: b.token })).status).toBe(404);
    const rows = await all<{ network_id: string; webhook_id: string }>(env, "SELECT network_id, webhook_id FROM webhook_deliveries ORDER BY network_id");
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.webhook_id).toBe(r.network_id === a.nid ? hookA.id : hookB.id);
  });
});
