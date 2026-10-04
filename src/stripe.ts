import type { Env } from "./types";

const API = "https://api.stripe.com/v1";
// Pinned so response shapes (e.g. invoice.subscription) don't change under us.
const STRIPE_VERSION = "2024-06-20";

export class StripeError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/** Stripe's form encoding: nested objects as a[b][c]=1, arrays as a[0]=x. */
export function encodeParams(params: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(`${prefix}[${k}]`, x);
    else parts.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return parts.join("&");
}

export async function stripePost<T = any>(
  env: Env,
  path: string,
  params: Record<string, unknown> = {},
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Stripe-Version": STRIPE_VERSION,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const res = await fetch(`${API}${path}`, { method: "POST", headers, body: encodeParams(params) });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new StripeError(res.status, json?.error?.message ?? "stripe request failed", json?.error?.code);
  return json as T;
}

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verifies a Stripe-Signature header (t=...,v1=...) against the raw request body. */
export async function verifyStripeSignature(
  payload: string,
  header: string | undefined,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t" && v) timestamp = v;
    else if (k === "v1" && v) signatures.push(v);
  }
  const t = Number(timestamp);
  if (!timestamp || !Number.isFinite(t) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = toHex(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${payload}`)));
  return signatures.some((s) => constantTimeEqual(s, expected));
}
