import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { app } from "../src/index";
import type { Env } from "../src/types";

// Vite does not resolve the node:sqlite builtin, so load it via require.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = DatabaseSyncType;

/** Real SQLite behind the subset of the D1 API the app uses. */
class FakeStatement {
  private params: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...p: unknown[]) {
    this.params = p;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return ((this.db.prepare(this.sql).get(...(this.params as any[])) as T | undefined) ?? null);
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...(this.params as any[])) as T[] };
  }
  async run() {
    this.db.prepare(this.sql).run(...(this.params as any[]));
    return { success: true };
  }
}

export function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").sort()) db.exec(readFileSync(`migrations/${f}`, "utf8"));
  return { prepare: (sql: string) => new FakeStatement(db, sql) } as unknown as D1Database;
}

export interface FakeObject {
  size: number;
  httpMetadata?: { contentType?: string };
  body?: Uint8Array;
}

export function fakeR2() {
  const objects = new Map<string, FakeObject>();
  const bucket = {
    head: async (k: string) => objects.get(k) ?? null,
    get: async (k: string) => {
      const o = objects.get(k);
      return o ? { size: o.size, arrayBuffer: async () => (o.body ?? new Uint8Array(o.size)).buffer } : null;
    },
    delete: async (k: string) => void objects.delete(k),
  } as unknown as R2Bucket;
  return { bucket, objects };
}

export function makeEnv(overrides: Partial<Env> = {}) {
  const r2 = fakeR2();
  const env = {
    DB: fakeD1(),
    MEDIA: r2.bucket,
    ENVIRONMENT: "test",
    JWT_SECRET: "test-only-secret-not-real",
    R2_ACCOUNT_ID: "testaccount",
    R2_ACCESS_KEY_ID: "TESTKEYID",
    R2_SECRET_ACCESS_KEY: "testsecret",
    R2_BUCKET_NAME: "testbucket",
    STRIPE_SECRET_KEY: "stripe-test-key-placeholder",
    STRIPE_WEBHOOK_SECRET: "test-platform-webhook-secret",
    STRIPE_CONNECT_WEBHOOK_SECRET: "test-connect-webhook-secret",
    APP_URL: "https://app.test",
    ...overrides,
  } as unknown as Env;
  return { env, objects: r2.objects };
}

export async function call(env: Env, method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
  );
  return { status: res.status, json: (await res.json()) as any };
}

export async function registerCreator(env: Env, email = "creator@example.com") {
  const r = await call(env, "POST", "/api/auth/creator-register", {
    body: { email, password: "a-long-test-password", creatorName: "Test Creator" },
  });
  return { token: r.json.token as string, id: r.json.id as string };
}

// ---- Stripe test support ----------------------------------------------------
import { createHmac } from "node:crypto";
import { vi } from "vitest";

/** Independent signer (node:crypto) so the production verifier is checked against a second implementation. */
export function stripeSignatureHeader(payload: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

export async function postWebhook(
  env: Env,
  path: "stripe" | "stripe-connect",
  event: object,
  opts: { secret?: string; header?: string | null; t?: number } = {},
) {
  const payload = JSON.stringify(event);
  const secret = opts.secret ?? (path === "stripe" ? env.STRIPE_WEBHOOK_SECRET : env.STRIPE_CONNECT_WEBHOOK_SECRET);
  const header = opts.header === undefined ? stripeSignatureHeader(payload, secret, opts.t) : opts.header;
  const res = await app.fetch(
    new Request(`http://localhost/api/webhooks/${path}`, {
      method: "POST",
      headers: { ...(header ? { "Stripe-Signature": header } : {}), "Content-Type": "application/json" },
      body: payload,
    }),
    env,
  );
  return { status: res.status, json: (await res.json()) as any };
}

export interface StripeCall {
  path: string;
  params: Record<string, string>;
  headers: Record<string, string>;
}

/** Stubs global fetch (used only for Stripe) and records each call. */
export function mockStripe(responses: Record<string, (params: Record<string, string>) => any> = {}) {
  const calls: StripeCall[] = [];
  const defaults: Record<string, (p: Record<string, string>) => any> = {
    "/accounts": () => ({ id: "acct_test1" }),
    "/account_links": () => ({ url: "https://connect.test/onboard" }),
    "/checkout/sessions": () => ({ id: "cs_test1", url: "https://checkout.test/cs_test1" }),
  };
  const all = { ...defaults, ...responses };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname.replace(/^\/v1/, "");
      const params = Object.fromEntries(new URLSearchParams(String(init.body ?? "")));
      calls.push({ path, params, headers: init.headers as Record<string, string> });
      const handler = all[path] ?? (() => ({ id: "obj_test" }));
      const body = handler(params);
      return new Response(JSON.stringify(body.__error ? { error: body.__error } : body), { status: body.__error ? 402 : 200 });
    }),
  );
  return calls;
}

export const run = (env: Env, sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
export const one = <T>(env: Env, sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).first<T>();
export const all = async <T>(env: Env, sql: string, ...params: unknown[]) => (await env.DB.prepare(sql).bind(...params).all<T>()).results;
