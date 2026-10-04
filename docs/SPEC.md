# HCCGSA Broadcasting Platform — Specification v1.1

**Owner:** Nathaniel Clarke / HCCGSA LLC
**Mission:** Sovereign, uncensored broadcasting. Creators own content, audience, and revenue.
**Stack:** Cloudflare (Workers + D1 + R2 + Workers AI, Pages for frontend) + Stripe Connect + Claude API
**Status:** Milestone 1 (foundation) built. Milestones 2–5 pending.

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
Public (partial): `GET /api/health`, `GET /api/episodes`

Pending: creator profile/episodes/subscribers/payouts/analytics, episode detail/stream/transcript, subscriptions, purchases, `POST /api/webhooks/stripe` (signature verification required).

## Secrets

Names only (values live in `.dev.vars` / Cloudflare secrets): `JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`.

## Milestones

1. **Foundation** — repo, schema, auth API ✅
2. Episodes + R2 upload + creator dashboard API
3. Stripe Connect: subscriptions, purchases, webhook, payouts
4. AI: Whisper transcription, Claude metadata, transcript search
5. Next.js frontend on Pages; security audit; deploy

## Definition of done (launch)

End-to-end: creator registers, uploads and publishes an episode; viewer pays via Stripe (test mode, then live); creator receives 80%; transcript appears; secrets scan clean; deployed at broadcast.hccgsa.org / api.broadcast.hccgsa.org.

## Success metrics

30 days: 2+ episodes, 100+ views, payment validated. 90 days: 8+ episodes, 500+ viewers, $500+ revenue, 2–3 test creators. 6 months: 10+ creators, $10,000+/month. These are targets, not guarantees; validate with real creators first.
