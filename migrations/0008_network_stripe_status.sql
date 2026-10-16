-- Stripe Express provisioning (5c): connected-account capability flags, kept in sync by account.updated.
-- Status endpoints read these columns; they never call Stripe live.

ALTER TABLE networks ADD COLUMN stripe_charges_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE networks ADD COLUMN stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE networks ADD COLUMN stripe_details_submitted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_networks_stripe_account ON networks(stripe_account_id);
