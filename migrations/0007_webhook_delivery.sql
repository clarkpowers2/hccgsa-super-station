-- Outbound webhook delivery. Secrets move from plaintext to AES-GCM ciphertext (src/webhook-crypto.ts).
-- Existing registrations were never delivered to, so they are disabled and their plaintext secret is dropped:
-- the owner must register the endpoint again to receive a new secret.

ALTER TABLE webhooks ADD COLUMN secret_ciphertext TEXT;
ALTER TABLE webhooks ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'));
UPDATE webhooks SET status = 'disabled';
ALTER TABLE webhooks DROP COLUMN secret;

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload TEXT NOT NULL, -- exact JSON body that was signed and sent; contains no secrets
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_status_code INTEGER,
  last_error TEXT, -- error class name only
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX idx_webhook_deliveries_network ON webhook_deliveries(network_id, webhook_id);
