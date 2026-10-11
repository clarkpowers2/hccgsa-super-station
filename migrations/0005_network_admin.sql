-- Network admin: invites (onboarding links), webhook registrations, branding.

ALTER TABLE networks ADD COLUMN branding TEXT; -- JSON object

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'creator', 'guest')),
  token_hash TEXT NOT NULL UNIQUE, -- SHA-256 hex; the plaintext lives only in the invite URL
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_invites_network ON invites(network_id, email);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  url TEXT NOT NULL,
  events TEXT NOT NULL, -- JSON array
  secret TEXT NOT NULL, -- HMAC key, needed in plaintext at delivery time (delivery not built yet)
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_webhooks_network ON webhooks(network_id);
