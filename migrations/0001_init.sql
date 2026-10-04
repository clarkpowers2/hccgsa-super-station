-- All money is stored as integer cents.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  creator_name TEXT NOT NULL,
  bio TEXT,
  avatar_url TEXT,
  is_creator INTEGER NOT NULL DEFAULT 0,
  stripe_account_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  thumbnail_key TEXT,
  video_key TEXT,
  audio_key TEXT,
  transcript_text TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'pending',
  metadata_tags TEXT,
  is_published INTEGER NOT NULL DEFAULT 0,
  publish_date TEXT,
  one_time_price_cents INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_episodes_creator ON episodes(creator_id);
CREATE INDEX idx_episodes_published ON episodes(is_published, publish_date);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  viewer_id TEXT NOT NULL REFERENCES users(id),
  creator_id TEXT NOT NULL REFERENCES users(id),
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  price_per_month_cents INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  canceled_at TEXT,
  next_billing_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_subs_viewer ON subscriptions(viewer_id);
CREATE INDEX idx_subs_creator ON subscriptions(creator_id);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  viewer_id TEXT NOT NULL REFERENCES users(id),
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  stripe_payment_intent_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  purchased_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_purchases_viewer ON purchases(viewer_id);

CREATE TABLE payouts (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id),
  month TEXT NOT NULL,
  gross_revenue_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  creator_payout_cents INTEGER NOT NULL,
  stripe_payout_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  paid_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (creator_id, month)
);
