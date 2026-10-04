import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import type { MiddlewareHandler } from "hono";
import type { AppBindings, Env } from "./types";
import { hashPassword, verifyPassword } from "./password";

const ACCESS_TTL_SECONDS = 60 * 60 * 24; // 24h
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function issueToken(env: Env, userId: string, isCreator: boolean) {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS;
  return sign({ sub: userId, isCreator, exp }, env.JWT_SECRET);
}

export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return c.json({ error: "unauthorized" }, 401);
  try {
    const p = await verify(token, c.env.JWT_SECRET, "HS256");
    c.set("user", { sub: String(p.sub), isCreator: p.isCreator === true });
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

export const requireCreator: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get("user").isCreator) return c.json({ error: "creator account required" }, 403);
  await next();
};

interface RegisterBody {
  email?: string;
  password?: string;
  creatorName?: string;
}

async function register(c: any, isCreator: boolean) {
  const body = (await c.req.json().catch(() => ({}))) as RegisterBody;
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  const name = body.creatorName?.trim() ?? "";
  if (!EMAIL_RE.test(email)) return c.json({ error: "valid email required" }, 400);
  if (password.length < 10) return c.json({ error: "password must be at least 10 characters" }, 400);
  if (!name) return c.json({ error: "creatorName required" }, 400);

  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, creator_name, is_creator) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, email, await hashPassword(password), name, isCreator ? 1 : 0)
      .run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "email already registered" }, 409);
    throw e;
  }
  return c.json({ id, token: await issueToken(c.env, id, isCreator) }, 201);
}

export const auth = new Hono<AppBindings>();

auth.post("/register", (c) => register(c, false));
auth.post("/creator-register", (c) => register(c, true));

auth.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as RegisterBody;
  const email = body.email?.trim().toLowerCase() ?? "";
  const row = await c.env.DB.prepare("SELECT id, password_hash, is_creator FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; password_hash: string; is_creator: number }>();
  // Same error for unknown email and bad password to avoid account enumeration.
  if (!row || !(await verifyPassword(body.password ?? "", row.password_hash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }
  return c.json({ token: await issueToken(c.env, row.id, row.is_creator === 1) });
});

// Tokens are stateless; the client discards its token on logout.
auth.post("/logout", (c) => c.json({ ok: true }));

auth.post("/refresh-token", requireAuth, async (c) => {
  const u = c.get("user");
  return c.json({ token: await issueToken(c.env, u.sub, u.isCreator) });
});
