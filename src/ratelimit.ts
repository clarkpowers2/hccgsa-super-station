const WINDOW_SECONDS = 3600;

export interface RateResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // epoch seconds when the window ends
}

/**
 * Fixed-window counter in D1. Workers isolates share no memory, so an in-process Map
 * could not enforce a real limit; the upsert below is atomic across isolates.
 * Requests over the limit still count, which keeps the arithmetic simple.
 */
export async function hit(db: D1Database, bucket: string, limit: number, nowMs = Date.now()): Promise<RateResult> {
  const window = Math.floor(nowMs / 1000 / WINDOW_SECONDS);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket, window) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, window)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  if (count === 1) {
    // First hit of a new window: drop this bucket's stale windows.
    await db.prepare("DELETE FROM rate_limits WHERE bucket = ? AND window < ?").bind(bucket, window).run();
  }
  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetAt: (window + 1) * WINDOW_SECONDS };
}
