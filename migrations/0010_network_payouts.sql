-- 5e: network Express accounts receive payouts too, so a payout can belong to a network with no creator.
-- payouts.creator_id was NOT NULL; SQLite cannot drop NOT NULL in place, so rebuild the table.
-- payouts.network_id already exists (added in 0004); it is carried over, not re-added.
-- Nothing references payouts, so the drop/rename is safe.

CREATE TABLE payouts_new (
  id TEXT PRIMARY KEY,
  creator_id TEXT REFERENCES users(id),
  stripe_payout_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,
  arrival_date TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  network_id TEXT REFERENCES networks(id)
);

-- Existing rows are all creator payouts. Network from the row itself, else the creator's network,
-- else the seeded 'net_freqone' (same fallback as 0004 and 0009).
INSERT INTO payouts_new (id, creator_id, stripe_payout_id, amount_cents, currency, status, arrival_date, paid_at, created_at, network_id)
SELECT p.id, p.creator_id, p.stripe_payout_id, p.amount_cents, p.currency, p.status, p.arrival_date, p.paid_at, p.created_at,
       COALESCE(p.network_id, (SELECT u.network_id FROM users u WHERE u.id = p.creator_id), 'net_freqone')
FROM payouts p;

DROP TABLE payouts;
ALTER TABLE payouts_new RENAME TO payouts;

CREATE INDEX idx_payouts_creator ON payouts(creator_id);
CREATE INDEX idx_payouts_network ON payouts(network_id);
CREATE INDEX idx_payouts_network_created ON payouts(network_id, created_at);
