import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import app from "../src/index";
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
  db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  return { prepare: (sql: string) => new FakeStatement(db, sql) } as unknown as D1Database;
}

export interface FakeObject {
  size: number;
  httpMetadata?: { contentType?: string };
}

export function fakeR2() {
  const objects = new Map<string, FakeObject>();
  const bucket = {
    head: async (k: string) => objects.get(k) ?? null,
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
