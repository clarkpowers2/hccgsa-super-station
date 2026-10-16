/** A platform fee rate as stored in networks.platform_fee_percent: a whole percent, 0-100. */
export const isValidFeePercent = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100;

/**
 * Split a gross amount (cents) at `percent` (the network's platform_fee_percent). The fee rounds to the
 * nearest cent; the creator gets the remainder, so the parts always sum to gross.
 */
export function splitAmount(grossCents: number, percent: number) {
  if (!Number.isInteger(grossCents) || grossCents < 0) throw new Error("gross must be a non-negative integer");
  if (!isValidFeePercent(percent)) throw new Error("fee percent must be an integer from 0 to 100");
  const platformFeeCents = Math.round((grossCents * percent) / 100);
  return { grossCents, platformFeeCents, creatorCents: grossCents - platformFeeCents };
}

/** Stripe's unix seconds -> the 'YYYY-MM-DD HH:MM:SS' UTC format SQLite's datetime('now') produces. */
export const sqlTime = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace("T", " ");
