import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import type { MiddlewareHandler } from "hono";
import type { AppBindings, Env, Role } from "./types";
import { hashPassword, verifyPassword } from "./password";
import { provisionNetwork, type ProvisionedNetwork } from "./provision";

const ACCESS_TTL_SECONDS = 60 * 60 * 24; // 24h
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLES: readonly string[] = ["owner", "admin", "creator", "guest"];

export async function issueToken(env: Env, u: { id: string; isCreator: boolean; networkId: string | null; role: Role }) {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS;
  return sign({ sub: u.id, isCreator: u.isCreator, network_id: u.networkId, role: u.role, exp }, env.JWT_SECRET);
}

export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return c.json({ error: "unauthorized" }, 401);
  try {
    const p = await verify(token, c.env.JWT_SECRET, "HS256");
    // Tokens minted before multi-network (no role/network_id claims) are rejected: re-login.
    if (typeof p.role !== "string" || !ROLES.includes(p.role) || !("network_id" in p)) throw new Error("stale token");
    c.set("user", {
      sub: String(p.sub),
      isCreator: p.isCreator === true,
      networkId: typeof p.network_id === "string" ? p.network_id : null,
      role: p.role as Role,
    });
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

export const requireCreator: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get("user").isCreator) return c.json({ error: "creator account required" }, 403);
  await next();
};

/** Requires the caller to belong to a network. Handlers read it via c.get("user").networkId. */
export const requireNetwork: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get("user").networkId) return c.json({ error: "network membership required" }, 403);
  await next();
};

export const requireRole = (...roles: Role[]): MiddlewareHandler<AppBindings> => async (c, next) => {
  if (!roles.includes(c.get("user").role)) return c.json({ error: "insufficient role" }, 403);
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
  const insertUser = c.env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, creator_name, is_creator, role) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, email, await hashPassword(password), name, isCreator ? 1 : 0, isCreator ? "owner" : "guest");

  // Every creator signup provisions their own network in the same atomic batch.
  let network: ProvisionedNetwork | null = null;
  try {
    if (isCreator) {
      network = await provisionNetwork(c.env, id, name, insertUser);
    } else {
      await insertUser.run();
    }
  } catch (e) {
    if (String(e).includes("users.email")) return c.json({ error: "email already registered" }, 409);
    throw e;
  }
  const token = await issueToken(c.env, {
    id,
    isCreator,
    networkId: network?.id ?? null,
    role: isCreator ? "owner" : "guest",
  });
  return c.json({ id, token, ...(network ? { network } : {}) }, 201);
}

export const auth = new Hono<AppBindings>();

auth.post("/register", (c) => register(c, false));
auth.post("/creator-register", (c) => register(c, true));

auth.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as RegisterBody;
  const email = body.email?.trim().toLowerCase() ?? "";
  const row = await c.env.DB.prepare(
    "SELECT id, password_hash, is_creator, network_id, role FROM users WHERE email = ? AND deleted_at IS NULL",
  )
    .bind(email)
    .first<{ id: string; password_hash: string; is_creator: number; network_id: string | null; role: Role }>();
  // Same error for unknown email and bad password to avoid account enumeration.
  if (!row || !(await verifyPassword(body.password ?? "", row.password_hash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }
  return c.json({ token: await issueToken(c.env, { id: row.id, isCreator: row.is_creator === 1, networkId: row.network_id, role: row.role }) });
});

// Tokens are stateless; the client discards its token on logout.
auth.post("/logout", (c) => c.json({ ok: true }));

auth.post("/refresh-token", requireAuth, async (c) => {
  // Re-read membership so role/network changes take effect on refresh.
  const row = await c.env.DB.prepare("SELECT id, is_creator, network_id, role FROM users WHERE id = ? AND deleted_at IS NULL")
    .bind(c.get("user").sub)
    .first<{ id: string; is_creator: number; network_id: string | null; role: Role }>();
  if (!row) return c.json({ error: "unauthorized" }, 401);
  return c.json({ token: await issueToken(c.env, { id: row.id, isCreator: row.is_creator === 1, networkId: row.network_id, role: row.role }) });
});
