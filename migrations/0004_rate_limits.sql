-- API key lookup by hash, and fixed-window request counters (one row per bucket per hour).
CREATE INDEX idx_networks_public_key ON networks(public_api_key_hash);
CREATE INDEX idx_networks_private_key ON networks(private_api_key_hash);

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,   -- "<network_id>:<public|private>"
  window INTEGER NOT NULL, -- unix hour: floor(epoch_seconds / 3600)
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window)
);
