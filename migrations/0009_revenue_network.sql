-- 5d: network content is paid to the network's Stripe account, so revenue is attributed to a network.

ALTER TABLE revenue ADD COLUMN network_id TEXT REFERENCES networks(id);

-- Backfill from the creator's network; anything with no network falls back to the seeded 'net_freqone'
-- (same convention as 0004). Pre-5d purchases/subscriptions written since 0004 also have NULL network_id.
UPDATE revenue SET network_id = COALESCE((SELECT u.network_id FROM users u WHERE u.id = revenue.creator_id), 'net_freqone');
UPDATE purchases SET network_id = COALESCE((SELECT e.network_id FROM episodes e WHERE e.id = purchases.episode_id), 'net_freqone') WHERE network_id IS NULL;
UPDATE subscriptions SET network_id = COALESCE((SELECT u.network_id FROM users u WHERE u.id = subscriptions.creator_id), 'net_freqone') WHERE network_id IS NULL;

CREATE INDEX idx_revenue_network ON revenue(network_id, occurred_at);
