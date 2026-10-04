import { describe, expect, it } from "vitest";
import { call, makeEnv, registerCreator } from "./helpers";

describe("auth endpoints", () => {
  it("registers, logs in, and rejects bad credentials", async () => {
    const { env } = makeEnv();
    const reg = await call(env, "POST", "/api/auth/register", {
      body: { email: "Viewer@Example.com", password: "a-long-test-password", creatorName: "Viewer" },
    });
    expect(reg.status).toBe(201);
    expect(reg.json.token).toBeTruthy();

    const ok = await call(env, "POST", "/api/auth/login", {
      body: { email: "viewer@example.com", password: "a-long-test-password" },
    });
    expect(ok.status).toBe(200);

    const bad = await call(env, "POST", "/api/auth/login", { body: { email: "viewer@example.com", password: "wrong-password-1" } });
    const unknown = await call(env, "POST", "/api/auth/login", { body: { email: "nobody@example.com", password: "wrong-password-1" } });
    expect(bad.status).toBe(401);
    expect(unknown.json).toEqual(bad.json); // no account enumeration
  });

  it("rejects duplicate emails, short passwords, and bad emails", async () => {
    const { env } = makeEnv();
    const body = { email: "a@example.com", password: "a-long-test-password", creatorName: "A" };
    expect((await call(env, "POST", "/api/auth/register", { body })).status).toBe(201);
    expect((await call(env, "POST", "/api/auth/register", { body })).status).toBe(409);
    expect((await call(env, "POST", "/api/auth/register", { body: { ...body, email: "b@example.com", password: "short" } })).status).toBe(400);
    expect((await call(env, "POST", "/api/auth/register", { body: { ...body, email: "nope" } })).status).toBe(400);
  });

  it("refreshes a valid token and rejects a missing one", async () => {
    const { env } = makeEnv();
    const { token } = await registerCreator(env);
    expect((await call(env, "POST", "/api/auth/refresh-token", { token })).status).toBe(200);
    expect((await call(env, "POST", "/api/auth/refresh-token")).status).toBe(401);
  });
});
