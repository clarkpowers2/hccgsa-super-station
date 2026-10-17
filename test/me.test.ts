import { describe, expect, it } from "vitest";
import { call, makeEnv, run } from "./helpers";

const PW = "a-long-test-password";

async function signup(env: any, email: string, name = "Owner Name") {
  const r = await call(env, "POST", "/api/auth/creator-register", { body: { email, password: PW, creatorName: name } });
  return { token: r.json.token as string, id: r.json.id as string, nid: r.json.network.id as string };
}
async function addMember(env: any, owner: { token: string; nid: string }, email: string, role: string) {
  const inv = await call(env, "POST", `/api/networks/${owner.nid}/users`, { token: owner.token, body: { email, role } });
  const token = new URL(inv.json.inviteUrl).searchParams.get("token");
  const acc = await call(env, "POST", "/api/auth/accept-invite", { body: { token, password: PW, creatorName: email } });
  return { token: acc.json.token as string, id: acc.json.id as string };
}
const me = (env: any, token?: string) => call(env, "GET", "/api/me", { token });

describe("GET /api/me", () => {
  it("returns the owner, admin, creator and guest shapes for the caller's own row", async () => {
    const { env } = makeEnv();
    const o = await signup(env, "owner@example.com", "Olive Owner");
    const admin = await addMember(env, o, "admin@example.com", "admin");
    const creator = await addMember(env, o, "creator@example.com", "creator");
    const guest = await addMember(env, o, "guest@example.com", "guest");

    expect((await me(env, o.token)).json).toEqual({
      id: o.id, email: "owner@example.com", creatorName: "Olive Owner", role: "owner", networkId: o.nid, isCreator: true,
    });
    const a = (await me(env, admin.token)).json;
    expect(a).toMatchObject({ id: admin.id, email: "admin@example.com", role: "admin", networkId: o.nid });
    expect((await me(env, creator.token)).json).toMatchObject({ id: creator.id, role: "creator", networkId: o.nid });
    const g = (await me(env, guest.token)).json;
    expect(g).toMatchObject({ id: guest.id, role: "guest", networkId: o.nid, isCreator: false });
    // Exactly these fields: nothing about passwords, hashes or other users.
    expect(Object.keys(a).sort()).toEqual(["creatorName", "email", "id", "isCreator", "networkId", "role"]);
  });

  it("a viewer with no network gets networkId null", async () => {
    const { env } = makeEnv();
    const v = await call(env, "POST", "/api/auth/register", { body: { email: "viewer@example.com", password: PW, creatorName: "Vee" } });
    const r = await me(env, v.json.token);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: v.json.id, email: "viewer@example.com", creatorName: "Vee", role: "guest", networkId: null, isCreator: false });
  });

  it("reads the users row, not the token: a role change shows on the next call", async () => {
    const { env } = makeEnv();
    const o = await signup(env, "owner@example.com");
    const creator = await addMember(env, o, "creator@example.com", "creator");
    await run(env, "UPDATE users SET role='admin' WHERE id=?", creator.id);
    expect((await me(env, creator.token)).json.role).toBe("admin"); // token still says creator
  });

  it("is 401 when logged out, with a bad token, and for deleted users", async () => {
    const { env } = makeEnv();
    const o = await signup(env, "owner@example.com");
    const member = await addMember(env, o, "creator@example.com", "creator");
    expect((await me(env)).status).toBe(401);
    expect((await me(env, "not-a-token")).status).toBe(401);
    expect((await me(env, member.token)).status).toBe(200);
    await run(env, "UPDATE users SET deleted_at=datetime('now') WHERE id=?", member.id);
    expect((await me(env, member.token)).status).toBe(401);
    await run(env, "DELETE FROM users WHERE id=?", member.id);
    expect((await me(env, member.token)).status).toBe(401);
  });

  it("allows the dashboard origin to read it (CORS)", async () => {
    const { env } = makeEnv();
    const { app } = await import("../src/index");
    const res = await app.fetch(
      new Request("http://localhost/api/me", { method: "OPTIONS", headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } }),
      env,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });
});
