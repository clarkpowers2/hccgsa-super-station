import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { call, makeEnv } from "./helpers";

const PW = "a-long-test-password";

async function signup(env: any, email: string) {
  const r = await call(env, "POST", "/api/auth/creator-register", { body: { email, password: PW, creatorName: "Owner" } });
  expect(r.status).toBe(201);
  return {
    token: r.json.token as string,
    nid: r.json.network.id as string,
    keys: r.json.network.apiKeys as { public: string; private: string },
  };
}

/** Owner invites `email` with `role`, invitee accepts. Returns the invitee's token. */
async function addMember(env: any, owner: { token: string; nid: string }, email: string, role: string) {
  const inv = await call(env, "POST", `/api/networks/${owner.nid}/users`, { token: owner.token, body: { email, role } });
  expect(inv.status).toBe(201);
  const token = new URL(inv.json.inviteUrl).searchParams.get("token");
  const acc = await call(env, "POST", "/api/auth/accept-invite", { body: { token, password: PW, creatorName: email } });
  expect(acc.status).toBe(201);
  return acc.json.token as string;
}

/** Calls the bearer-authenticated public API. 401 means the key is rejected; 404 means it was accepted. */
async function publicStatus(env: any, key: string) {
  const res = await app.fetch(
    new Request("http://localhost/api/public/episodes/no-such-episode", { headers: { Authorization: `Bearer ${key}` } }),
    env,
  );
  return res.status;
}

describe("API key rotation", () => {
  it("issues new keys that work, and the old keys stop working at once", async () => {
    const { env } = makeEnv();
    const owner = await signup(env, "owner@example.com");
    expect(await publicStatus(env, owner.keys.public)).toBe(404);
    expect(await publicStatus(env, owner.keys.private)).toBe(404);

    const rot = await call(env, "POST", `/api/networks/${owner.nid}/api-keys/rotate`, { token: owner.token });
    expect(rot.status).toBe(200);
    const fresh = rot.json.apiKeys as { public: string; private: string };
    expect(fresh.public).toMatch(/^pk_/);
    expect(fresh.private).toMatch(/^sk_/);
    expect(fresh.public).not.toBe(owner.keys.public);
    expect(fresh.private).not.toBe(owner.keys.private);

    expect(await publicStatus(env, owner.keys.public)).toBe(401);
    expect(await publicStatus(env, owner.keys.private)).toBe(401);
    expect(await publicStatus(env, fresh.public)).toBe(404);
    expect(await publicStatus(env, fresh.private)).toBe(404);
  });

  it("updates the masked hints shown on the network, and never returns a full key there", async () => {
    const { env } = makeEnv();
    const owner = await signup(env, "owner2@example.com");
    const rot = await call(env, "POST", `/api/networks/${owner.nid}/api-keys/rotate`, { token: owner.token });
    const fresh = rot.json.apiKeys as { public: string; private: string };

    const view = await call(env, "GET", `/api/networks/${owner.nid}`, { token: owner.token });
    expect(view.status).toBe(200);
    expect(view.json.apiKeys.public).toBe(`pk_…${fresh.public.slice(-4)}`);
    expect(view.json.apiKeys.private).toBe(`sk_…${fresh.private.slice(-4)}`);
    expect(JSON.stringify(view.json)).not.toContain(fresh.public);
    expect(JSON.stringify(view.json)).not.toContain(fresh.private);
  });

  it("only the network owner can rotate; admins, creators and guests get 403", async () => {
    const { env } = makeEnv();
    const owner = await signup(env, "owner3@example.com");
    const admin = await addMember(env, owner, "admin@example.com", "admin");
    const creator = await addMember(env, owner, "creator@example.com", "creator");
    const guest = await addMember(env, owner, "guest@example.com", "guest");

    for (const token of [admin, creator, guest]) {
      const r = await call(env, "POST", `/api/networks/${owner.nid}/api-keys/rotate`, { token });
      expect(r.status).toBe(403);
    }
    // Rejected attempts change nothing: the original keys still work.
    expect(await publicStatus(env, owner.keys.public)).toBe(404);
  });

  it("another network's owner cannot rotate this network's keys", async () => {
    const { env } = makeEnv();
    const a = await signup(env, "neta@example.com");
    const b = await signup(env, "netb@example.com");

    const r = await call(env, "POST", `/api/networks/${a.nid}/api-keys/rotate`, { token: b.token });
    expect(r.status).toBe(403);
    expect(await publicStatus(env, a.keys.public)).toBe(404);
  });

  it("requires authentication", async () => {
    const { env } = makeEnv();
    const owner = await signup(env, "owner4@example.com");
    const r = await call(env, "POST", `/api/networks/${owner.nid}/api-keys/rotate`);
    expect(r.status).toBe(401);
    expect(await publicStatus(env, owner.keys.public)).toBe(404);
  });
});
