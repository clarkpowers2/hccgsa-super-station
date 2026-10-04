export const PLATFORM_FEE_PERCENT = 20;

/** Split a gross amount (cents). Fee rounds to the nearest cent; creator gets the remainder, so the parts always sum to gross. */
export function splitAmount(grossCents: number) {
  if (!Number.isInteger(grossCents) || grossCents < 0) throw new Error("gross must be a non-negative integer");
  const platformFeeCents = Math.round((grossCents * PLATFORM_FEE_PERCENT) / 100);
  return { grossCents, platformFeeCents, creatorCents: grossCents - platformFeeCents };
}

/** Stripe's unix seconds -> the 'YYYY-MM-DD HH:MM:SS' UTC format SQLite's datetime('now') produces. */
export const sqlTime = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace("T", " ");
