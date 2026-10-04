# HCCGSA Broadcasting Platform — Specification v1.1

**Owner:** Nathaniel Clarke / HCCGSA LLC
**Mission:** Sovereign, uncensored broadcasting. Creators own content, audience, and revenue.
**Stack:** Cloudflare (Workers + D1 + R2 + Workers AI, Pages for frontend) + Stripe Connect + Claude API
**Status:** Milestones 1–3 built. Milestones 4–5 pending.

## Changes from v1.0 (and why)

| v1.0 | v1.1 | Reason |
|---|---|---|
| Secrets in `wrangler.toml` | `.dev.vars` locally, `wrangler secret put` in production | `wrangler.toml` is committed; secrets must never be |
| Claude API transcribes audio | Workers AI (Whisper) transcribes; Claude writes tags/summaries | Claude does not accept audio input |
| Prices/amounts as `REAL` | Integer cents | Avoid floating-point money errors |
| Manual monthly 80/20 payouts | Stripe Connect with 20% application fee | Split happens at charge time; less custom money logic |
| Workers "Node.js backend" | Workers runtime (TypeScript, Hono) | Workers are not Node |
| Per-episode `subscription_price` | Per-creator subscription price | Subscriptions are to a creator, not an episode |

## MVP features

1. Creator dashboard: upload video/audio, set prices, view analytics
2. Viewer interface: browse, subscribe, watch, read transcripts
3. Authentication: creator and viewer accounts
4. Payments: Stripe subscriptions and one-time purchases, 80/20 split
5. Media: upload to R2, CDN delivery
6. AI: transcription, metadata, summaries, searchable transcripts
7. Creator controls: moderation and subscriber management

## Data model

See `migrations/0001_init.sql` (source of truth): `users`, `episodes`, `subscriptions`, `purchases`, `payouts`. All money in integer cents.

## API

Auth (built): `POST /api/auth/register`, `/creator-register`, `/login`, `/logout`, `/refresh-token`
Public: `GET /api/health`, `GET /api/episodes`, `GET /api/episodes/:id` (metadata only; storage keys never exposed)

Creator (built, requires creator token):
- `GET/PUT /api/creator/profile`
- `POST /api/creator/episodes` (create draft) · `GET /api/creator/episodes?published=&limit=&offset=` · `GET/PUT /api/creator/episodes/:id`
- `POST /api/creator/episodes/:id/uploads` → presigned R2 PUT URL (1 hour; video 2 GB, audio 500 MB, thumbnail 5 MB; content type is signed)
- `POST /api/creator/episodes/:id/uploads/complete` → server verifies the object in R2 (prefix, type, size) before attaching it
- `GET /api/creator/episodes/:id/media/:kind` → 15-minute owner preview URL
- `GET /api/creator/analytics`

Upload flow: create episode → request upload URL → browser PUTs file directly to R2 with the returned headers → call `complete` → publish (requires video or audio).

Billing (built):
- Creator: `POST /api/creator/connect/onboarding` (Stripe Express account + hosted onboarding link), `GET /api/creator/connect/status`, `GET /api/creator/earnings` (by month, from the revenue ledger), `GET /api/creator/payouts`, `GET /api/creator/subscribers`; `PUT /api/creator/profile` accepts `subscriptionPriceCents` (100–100000 or null)
- Viewer: `POST /api/subscriptions {creatorId}` and `POST /api/purchases {episodeId}` return a Stripe Checkout URL; `GET /api/subscriptions`; `PUT /api/subscriptions/:id {cancelAtPeriodEnd}`; `GET /api/viewer/purchases`
- Playback: `GET /api/episodes/:id/stream?kind=video|audio` → 1-hour signed URL for the creator, a buyer of that episode, or an active subscriber to the creator; everyone else gets 403
- Webhooks (signature-verified, replay-safe): `POST /api/webhooks/stripe` (checkout.session.completed, checkout.session.async_payment_succeeded, invoice.paid, customer.subscription.updated/deleted) and `POST /api/webhooks/stripe-connect` (account.updated, payout.paid, payout.failed). Two endpoints, two signing secrets.

Pending: transcript access (milestone 4), subscriptions, purchases, `POST /api/webhooks/stripe` (signature verification required).

## Secrets

Names only (values live in `.dev.vars` / Cloudflare secrets): `JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`. Non-secret vars in `wrangler.toml`: `R2_BUCKET_NAME`, `APP_URL`. `R2_BUCKET_NAME` is a non-secret var in `wrangler.toml`. The R2 endpoint is derived as `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.

## Milestones

1. **Foundation** — repo, schema, auth API ✅
2. Episodes + R2 signed uploads + creator dashboard API ✅ (tested with fakes; not yet against live R2)
3. Stripe Connect: subscriptions, purchases, webhooks, payout ledger, paid playback ✅ (tested against a stubbed Stripe; not yet in Stripe test mode)
4. AI: Whisper transcription, Claude metadata, transcript search
5. Next.js frontend on Pages; security audit; deploy

## Definition of done (launch)

End-to-end: creator registers, uploads and publishes an episode; viewer pays via Stripe (test mode, then live); creator receives 80%; transcript appears; secrets scan clean; deployed at broadcast.hccgsa.org / api.broadcast.hccgsa.org.

## Success metrics

30 days: 2+ episodes, 100+ views, payment validated. 90 days: 8+ episodes, 500+ viewers, $500+ revenue, 2–3 test creators. 6 months: 10+ creators, $10,000+/month. These are targets, not guarantees; validate with real creators first.

## Money model (v1.1 decisions)

- **Destination charges.** The platform is the merchant of record. Stripe moves 80% to the creator's connected account at charge time via `transfer_data`; the 20% platform fee is `application_fee_percent` (subscriptions) or `application_fee_amount` (purchases, rounded to the nearest cent).
- **Payouts.** Stripe pays creators' banks on a monthly schedule set when the connected account is created. We do not move payout money ourselves; the `payouts` table records what Stripe reports.
- **Platform bears Stripe's processing fees and dispute/refund liability** on destination charges. Platform net per charge is 20% minus Stripe's fee (about 2.9% + 30¢ in the US), so very low prices have thin margins. Connect account/payout fees also apply. Review Stripe's current pricing before setting a minimum price.
- **Ledger.** `revenue` has one row per successful charge (unique per PaymentIntent / invoice), so replays can't double count.
- **Not yet handled:** refunds and disputes (handle in the Stripe Dashboard for now; reversing the creator transfer needs a deliberate policy), sales tax, non-USD currencies, non-US creators, free episodes.
