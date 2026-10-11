import type { Env } from "./types";
import { decryptSecret } from "./webhook-crypto";
import { signPayload } from "./webhook-signing";

// Attempt 1 is immediate. After a failed attempt n, wait RETRY_MINUTES[n-1] before the next one.
// A failure on the last attempt marks the delivery failed. Retries run only from the cron tick.
export const MAX_ATTEMPTS = 4;
export const RETRY_MINUTES = [5, 15, 60];
const TIMEOUT_MS = 10_000;

export interface EnqueueArgs {
  networkId: string;
  eventType: string;
  eventId: string;
  payload: Record<string, unknown>;
}

/** Creates one pending delivery per active webhook in the same network that subscribes to the event. */
export async function enqueueWebhookEvent(env: Env, args: EnqueueArgs): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id, events FROM webhooks WHERE network_id = ? AND status = 'active'")
    .bind(args.networkId)
    .all<{ id: string; events: string }>();
  const body = JSON.stringify(args.payload); // stored exactly as signed and sent
  let queued = 0;
  for (const w of results) {
    if (!(JSON.parse(w.events) as string[]).includes(args.eventType)) continue;
    await env.DB.prepare(
      `INSERT INTO webhook_deliveries (id, network_id, webhook_id, event_type, event_id, payload, status, attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, datetime('now'))`,
    )
      .bind(crypto.randomUUID(), args.networkId, w.id, args.eventType, args.eventId, body)
      .run();
    queued++;
  }
  return queued;
}

/** Enqueue for an API write. A failure here is logged and never fails the request that caused it. */
export async function enqueueWebhookEventSafe(env: Env, args: EnqueueArgs): Promise<void> {
  try {
    await enqueueWebhookEvent(env, args);
  } catch (e) {
    console.error("webhook enqueue failed", args.eventType, e instanceof Error ? e.constructor.name : "unknown");
  }
}

interface DueRow {
  id: string;
  event_type: string;
  payload: string;
  attempts: number;
  url: string;
  secret_ciphertext: string | null;
}

/** Sends pending deliveries whose retry time has come. Returns how many were attempted. */
export async function deliverDueWebhooks(env: Env, limit = 25): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.event_type, d.payload, d.attempts, w.url, w.secret_ciphertext
     FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= datetime('now') AND w.status = 'active'
     ORDER BY d.next_attempt_at LIMIT ?`,
  )
    .bind(limit)
    .all<DueRow>();
  for (const row of results) await attemptDelivery(env, row);
  return results.length;
}

async function attemptDelivery(env: Env, row: DueRow): Promise<void> {
  let statusCode: number | null = null;
  let errorName: string | null = null;
  let ok = false;
  try {
    if (!row.secret_ciphertext) throw new Error("no secret");
    const secret = await decryptSecret(env, row.secret_ciphertext);
    const signature = await signPayload(secret, row.payload);
    // Known limit (DNS rebinding): validWebhookUrl (networks.ts) checks the hostname string at registration only.
    // We do not resolve DNS here and Workers cannot pin the connection to a vetted IP, so a public-looking
    // hostname that later resolves to a private or internal address is not caught. Mitigations in place:
    // https only, no IP literals or local-style names, no credentials in the URL, redirects not followed,
    // a 10s timeout, and no response body ever read or stored. Closing the gap needs an egress proxy or a
    // DNS-over-HTTPS resolve-and-check step; that is an open decision, not a tested guarantee.
    // redirect: "manual" means a 3xx is a failure, so the request is never followed to another host.
    const res = await fetch(row.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Event": row.event_type,
        "X-Webhook-Id": row.id,
        "X-Webhook-Signature": signature,
      },
      body: row.payload,
    });
    statusCode = res.status;
    ok = res.status >= 200 && res.status < 300;
    await res.body?.cancel();
  } catch (e) {
    errorName = e instanceof Error ? e.constructor.name : "unknown";
  }

  const attempts = row.attempts + 1;
  if (ok) {
    await env.DB.prepare(
      "UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status_code = ?, last_error = NULL, delivered_at = datetime('now') WHERE id = ?",
    )
      .bind(attempts, statusCode, row.id)
      .run();
  } else if (attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_status_code = ?, last_error = ? WHERE id = ?")
      .bind(attempts, statusCode, errorName ?? `HTTP ${statusCode}`, row.id)
      .run();
  } else {
    await env.DB.prepare(
      "UPDATE webhook_deliveries SET attempts = ?, last_status_code = ?, last_error = ?, next_attempt_at = datetime('now', ?) WHERE id = ?",
    )
      .bind(attempts, statusCode, errorName ?? `HTTP ${statusCode}`, `+${RETRY_MINUTES[attempts - 1]} minutes`, row.id)
      .run();
  }
  // Log identifiers only: never the URL, payload, signature, or secret.
  console.log("webhook delivery", { id: row.id, event: row.event_type, status: statusCode, attempts, outcome: ok ? "delivered" : errorName ? errorName : "http_error" });
}
