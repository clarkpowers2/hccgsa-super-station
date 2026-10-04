-- Milestone 3: Stripe billing. Money is integer cents (USD).
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_details_submitted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN stripe_ready INTEGER NOT NULL DEFAULT 0; -- transfers active + payouts enabled
ALTER TABLE users ADD COLUMN subscription_price_cents INTEGER;        -- NULL = creator offers no subscription

-- v1.0 payouts table was never written to; Stripe pays creators directly, so we
-- only record what Stripe reports via payout.paid / payout.failed webhooks.
DROP TABLE payouts;
CREATE TABLE payouts (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id),
  stripe_payout_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,
  arrival_date TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payouts_creator ON payouts(creator_id);

-- One row per successful charge (purchase PaymentIntent or subscription invoice).
CREATE TABLE revenue (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id),
  viewer_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('subscription', 'purchase')),
  stripe_object_id TEXT NOT NULL UNIQUE,
  gross_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  creator_cents INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_revenue_creator ON revenue(creator_id, occurred_at);

-- Webhook replay protection.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
