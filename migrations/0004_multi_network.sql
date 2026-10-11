-- Phase 2: multi-network. One shared D1, partitioned by network_id on every
-- tenant table. Isolation is enforced in the query layer + middleware, not the DB.
-- SQLite cannot add a NOT NULL FK column via ALTER, so network_id is nullable
-- here and enforced by the app (Phase 1 rows are backfilled below).

CREATE TABLE networks (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  owner_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'initializing' CHECK (status IN ('initializing', 'active', 'suspended')),
  stripe_account_id TEXT,
  platform_fee_percent INTEGER NOT NULL DEFAULT 15,
  public_api_key_hash TEXT, -- SHA-256 hex; plaintext is shown once at creation
  public_api_key_hint TEXT, -- last 4 chars, for masked display
  private_api_key_hash TEXT,
  private_api_key_hint TEXT,
  custom_domains TEXT, -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE users ADD COLUMN network_id TEXT REFERENCES networks(id);
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'creator' CHECK (role IN ('owner', 'admin', 'creator', 'guest'));
ALTER TABLE users ADD COLUMN permissions TEXT; -- JSON array
ALTER TABLE users ADD COLUMN deleted_at TEXT;

ALTER TABLE episodes ADD COLUMN network_id TEXT REFERENCES networks(id);
ALTER TABLE subscriptions ADD COLUMN network_id TEXT REFERENCES networks(id);
ALTER TABLE purchases ADD COLUMN network_id TEXT REFERENCES networks(id);
ALTER TABLE payouts ADD COLUMN network_id TEXT REFERENCES networks(id);

CREATE INDEX idx_users_network ON users(network_id);
CREATE INDEX idx_episodes_network ON episodes(network_id, id);
CREATE INDEX idx_episodes_network_published ON episodes(network_id, is_published, publish_date);
CREATE INDEX idx_subs_network ON subscriptions(network_id);
CREATE INDEX idx_purchases_network ON purchases(network_id);
CREATE INDEX idx_payouts_network ON payouts(network_id);

-- Backfill Phase 1 data into the original FREQ ONE network.
INSERT INTO networks (id, slug, display_name, owner_id, status)
VALUES (
  'net_freqone', 'freqone', 'FREQ ONE Network',
  (SELECT id FROM users WHERE is_creator = 1 ORDER BY created_at, id LIMIT 1),
  'active'
);
UPDATE users SET network_id = 'net_freqone', role = CASE WHEN is_creator = 1 THEN 'creator' ELSE 'guest' END;
UPDATE users SET role = 'owner' WHERE id = (SELECT owner_id FROM networks WHERE id = 'net_freqone');
UPDATE episodes SET network_id = 'net_freqone';
UPDATE subscriptions SET network_id = 'net_freqone';
UPDATE purchases SET network_id = 'net_freqone';
UPDATE payouts SET network_id = 'net_freqone';

-- Live-streaming foundation (Phase 3 exposes these; no endpoints in Phase 2).
CREATE TABLE streams (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  episode_id TEXT REFERENCES episodes(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended')),
  start_time TEXT NOT NULL,
  end_time TEXT,
  hls_playlist_url TEXT,
  dash_manifest_url TEXT,
  bitrate INTEGER, -- kbps
  resolution TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_streams_network ON streams(network_id, status);

CREATE TABLE stream_guests (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES streams(id),
  network_id TEXT NOT NULL REFERENCES networks(id),
  remote_user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('guest', 'remote_host')),
  rtmp_url TEXT,
  rtmp_key TEXT, -- ephemeral, per guest per stream
  ingest_status TEXT NOT NULL DEFAULT 'waiting' CHECK (ingest_status IN ('waiting', 'connected', 'streaming', 'ended')),
  joined_at TEXT,
  left_at TEXT
);
CREATE INDEX idx_stream_guests_stream ON stream_guests(network_id, stream_id);

CREATE TABLE stream_recordings (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES streams(id),
  network_id TEXT NOT NULL REFERENCES networks(id),
  r2_key TEXT NOT NULL,
  duration_seconds INTEGER,
  file_size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'processing', 'ready')),
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_stream_recordings_stream ON stream_recordings(network_id, stream_id);
