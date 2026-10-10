# FREQ ONE Product Roadmap (Phases 1–5)

**Updated:** October 10, 2026  
**Status:** Phase 1 Complete, Phase 2 In Progress (provisioning + RBAC + isolation done; admin endpoints next)

---

## Executive Summary

**FREQ ONE** is a dual-platform broadcasting operating system:

- **FREQ ONE Network** — Nathaniel Clarke's private broadcasting empire with live studio capabilities, AI-assisted production, and dedicated hardware
- **FREQ ONE Cloud** — A SaaS platform enabling creators and organizations to launch their own independent broadcasting networks on shared, secure infrastructure

This roadmap outlines the five-phase path from the current creator dashboard (Phase 1, complete) through multi-network isolation (Phase 2), live streaming and AI-assisted production (Phase 3), platform-wide distribution and monetization (Phase 4), and production-grade hardening with integrated hardware (Phase 5).

Each phase builds on the previous one with careful attention to multi-tenancy, data isolation, real-time streaming architecture, and revenue sustainability. **Phase 2 is architected to include foundational infrastructure for live streaming, so Phase 3 features plug in cleanly without architectural redesign.**

---

## Phases at a Glance

| Phase | Timeline | Status | Objective |
|-------|----------|--------|-----------|
| **1** | Complete | ✓ Done | Creator Dashboard — single-network episode upload, pricing, analytics, profile |
| **2** | Q4 2026 – Q1 2027 | 🔄 In Progress | Multi-Network + Live Foundation — independent networks, provisioning, RBAC, real-time tables |
| **3** | Q2–Q3 2027 | Planned | Live Broadcasting + AI + Soundstage — HLS/DASH, AI director, hardware control |
| **4** | Q4 2027 – Q1 2028 | Planned | Distribution + Monetization Scaling — multi-platform, sponsorships, network effects |
| **5** | Q2–Q4 2028 | Planned | Hardening + Hardware Ecosystem — 99.99% uptime, appliances, Superstation OS |

---

## Phase 1: Creator Dashboard

**Status: ✓ COMPLETE**

### Objectives
- Validate core creator workflow on Cloudflare Workers backend
- Establish authentication and session management patterns
- Build episode CRUD, pricing management, and storage foundation
- Prove real-time API contract with e2e tests

### Architecture
- **Backend:** Cloudflare Workers (Hono.js, TypeScript) with D1 SQLite database
- **Frontend:** Next.js 14 App Router (TypeScript) on Cloudflare Pages
- **Auth:** JWT tokens (HS256), auth_token cookie + localStorage
- **Storage:** Cloudflare R2 (S3-compatible) with presigned URLs for browser uploads
- **Pricing:** API stores cents, UI displays dollars (conversion at boundary)

### Delivered Features

| Feature | Endpoint | Method | Notes |
|---------|----------|--------|-------|
| Registration | `/api/auth/creator-register` | POST | Email, password (10+ chars), creator name |
| Login | `/api/auth/login` | POST | Email/password validation, JWT issuance |
| Dashboard | `/api/creator/episodes` | GET | Episodes list with view count |
| Episode Creation | `/api/creator/episodes` | POST | Title + description, redirect to upload |
| Price Editing | `/api/creator/episodes/{id}` | PUT | Dollars ↔ API cents conversion |
| Episode Preview | `/api/creator/episodes/{id}/media/audio` | GET | Audio playback, price display |
| Audio Upload | `/api/creator/episodes/{id}/uploads` | POST | Presigned R2 URL → PUT to R2 → complete |
| Analytics | `/api/creator/analytics` | GET | Total views, total episodes, top episodes |
| Profile | `/api/creator/profile` | GET/PUT | Creator name management |
| Session Persistence | — | — | Token in cookie + localStorage, survives reload |

### Testing Status

✓ **6 e2e tests passing:**
- Creator registration with 10-char password and creator name
- Login and token-based session
- Error handling for invalid credentials
- Dashboard episode list display
- Episode creation with redirect to upload page
- Navigation to analytics, profile, sign out

⚠ **Not Tested (Blocked):** Audio upload to R2. Root cause: placeholder R2 credentials in `.dev.vars` (intentional for local dev). When real credentials available: implement full presigned URL → PUT → completion flow test.

### Success Criteria Met

- ✓ All 6 playwright tests pass
- ✓ No console errors on dashboard pages
- ✓ Can create account → see dashboard → create episode
- ✓ Auth token persists across page reloads
- ✓ Logout clears session and returns to login
- ✓ API responses match dashboard expectations (fields, types, structure)

---

## Phase 2: Multi-Network Architecture with Live Streaming Foundation

**Timeline:** Q4 2026 – Q1 2027 (12–16 weeks)  
**Status:** 🔄 In Progress (Week 1–2: provisioning, JWT/RBAC, query scoping, isolation tests done)

### Objectives

- Enable each creator/organization to launch an independent network on shared infrastructure
- Enforce strict network data isolation (complete separation per network)
- Implement network provisioning (signup, API keys, Stripe Express accounts)
- **Establish foundational architecture for live streaming** (real-time infrastructure, data structures, guest/remote architecture) so Phase 3 features plug in cleanly

### Architecture Decision: Shared D1 Database, Partitioned by network_id

**Why this model:**

- Cloudflare Workers context: D1 is designed for shared databases. Per-network databases become operationally complex and expensive at scale.
- Middleware enforcement: Hono.js middleware extracts `network_id` from JWT and enforces it on every query. Data isolation is proven via tests, not DB-level isolation.
- Simplicity + cost: One D1, shared across all networks. Partitioning by `network_id` is the standard SaaS pattern.
- Platform analytics: Cross-network queries (for FREQ ONE dashboard stats, sponsorship reporting, etc.) are easier with shared schema.

**Data isolation:**

- Every tenant table has a `network_id` column.
- `requireAuth` verifies the JWT and puts `networkId` and `role` on the request context. `requireNetwork` rejects accounts with no network.
- All creator-route D1 queries filter by the token's `network_id`. The request body is never trusted for network context.
- Tests prove: Network B gets 404 on every creator route for Network A's data. Asking for another network's record on `/api/networks/{id}` returns 403.

### Database Schema Changes

**New Tables:** (see `migrations/0002_multi_network.sql` for the authoritative definitions)

```sql
-- Networks: independent networks on shared infrastructure
CREATE TABLE networks (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  owner_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'initializing' CHECK (status IN ('initializing', 'active', 'suspended')),
  stripe_account_id TEXT,              -- lazy provisioning on first paid listener
  platform_fee_percent INTEGER NOT NULL DEFAULT 15,
  public_api_key_hash TEXT,            -- SHA-256 hex; plaintext shown once
  public_api_key_hint TEXT,            -- last 4 chars, for masked display
  private_api_key_hash TEXT,
  private_api_key_hint TEXT,
  custom_domains TEXT,                 -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Streams: live broadcast sessions (Phase 3 will expose endpoints; Phase 2 builds tables only)
CREATE TABLE streams (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  episode_id TEXT,  -- nullable: standalone stream not attached to episode
  title TEXT NOT NULL,
  status TEXT CHECK (status IN ('scheduled', 'live', 'ended')),
  start_time TEXT NOT NULL,  -- datetime('now') format
  end_time TEXT,
  hls_playlist_url TEXT,  -- populated when live
  dash_manifest_url TEXT,
  bitrate INTEGER,  -- kbps
  resolution TEXT,  -- "1920x1080"
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (network_id) REFERENCES networks(id),
  FOREIGN KEY (episode_id) REFERENCES episodes(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Remote guests in a stream
CREATE TABLE stream_guests (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  remote_user_id TEXT,  -- nullable: guest from another network
  name TEXT NOT NULL,
  role TEXT CHECK (role IN ('guest', 'remote_host')),
  rtmp_url TEXT,
  rtmp_key TEXT,  -- ephemeral, per-guest per-stream
  ingest_status TEXT DEFAULT 'waiting',
  joined_at TEXT,
  left_at TEXT,
  FOREIGN KEY (stream_id) REFERENCES streams(id),
  FOREIGN KEY (network_id) REFERENCES networks(id),
  FOREIGN KEY (remote_user_id) REFERENCES users(id)
);

-- VOD recordings from streams
CREATE TABLE stream_recordings (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,  -- "networks/net_123/streams/str_456/recording.mp4"
  duration_seconds INTEGER,
  file_size_bytes INTEGER,
  status TEXT CHECK (status IN ('recording', 'processing', 'ready')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (stream_id) REFERENCES streams(id),
  FOREIGN KEY (network_id) REFERENCES networks(id)
);
```

**Modified Tables:**

- `users` — Add `network_id` (FK networks), `role` (owner/admin/creator/guest), `permissions` (JSON), `deleted_at` (soft delete)
- `episodes` — Add `network_id` (FK networks) as partition key
- `subscriptions`, `purchases`, `payouts` — Add `network_id` (FK networks) for money data isolation

Existing Phase 1 rows are backfilled into a seeded `net_freqone` network by the migration.

### Network Provisioning Flow

**When a creator signs up:**

1. **Register creator account + network, atomically** — `POST /api/auth/creator-register` inserts the user and the `networks` row (slug from creator name, `status='active'`) in one D1 batch. A duplicate email rolls back both; a slug collision gets a random suffix. No orphan networks.
2. **Shared schema** — Network tables already exist; no per-network DB creation needed.
3. **Create API keys** — Generate 2 keys: public (for browser embed) and private (server-to-server). Plaintext is returned once in the signup response; only SHA-256 hashes (plus last-4 hints) are stored.
4. **Stripe Express account (lazy, not yet built)** — Signup returns `stripe: { status: "not_connected" }`. Real provisioning happens when the owner first enables paid listeners (Week 5–6).
5. **DNS + CORS (not yet built)** — Optional subdomain `<network-slug>.freq.one` and per-network CORS origins.
6. **Storage prefix** — Uploads go under `networks/<network_id>/…`.

Accounts with no network (viewers) can create one later via `POST /api/networks/create`, which returns a fresh token.

### Authentication & RBAC

**JWT Payload (as implemented):**
```json
{
  "sub": "user_id",
  "isCreator": true,
  "network_id": "net_123",
  "role": "owner" | "admin" | "creator" | "guest",
  "exp": 1700000000
}
```
`network_id` is `null` for accounts that belong to no network. Tokens minted before multi-network (no `role`/`network_id`) are rejected with 401. `requireAuth` re-reads the user row on every request, so revocation and role changes take effect immediately; the token only proves identity. A `permissions` claim is not implemented yet; roles are the only gate.

**Roles:**
- `owner` — Network creator. Can: manage users, settings, billing, monetization.
- `admin` — Invited by owner. Can: manage episodes, streams, analytics (except billing).
- `creator` — Can: create/edit episodes, go live, see own analytics.
- `guest` — Blocked from creator routes. Intended for remote guests during live streams (Phase 3).

**Middleware Enforcement:**
- `requireAuth` — Verify JWT, put `sub`, `networkId`, `role` on the request context
- `requireNetwork` — Reject (403) accounts with no network
- `requireRole(...roles)` — Reject (403) roles not listed
- Creator-route queries are filtered by the token's `network_id`; a record in another network looks like it doesn't exist (404)
- `/api/networks/{id}` returns 403 when `{id}` is not the caller's network

### API Additions (Phase 2)

| Endpoint | Method | Purpose | Auth | Status |
|----------|--------|---------|------|--------|
| `POST /api/networks/create` | POST | Create a network for an account that has none | JWT | ✓ Built |
| `GET /api/networks/{network_id}` | GET | Get network metadata, api keys (masked) | JWT (admin+) | ✓ Built |
| `PUT /api/networks/{network_id}/settings` | PUT | Update network name, description, branding | JWT (admin+) | ✓ Built |
| `GET /api/networks/{network_id}/users` | GET | List network users + pending invites | JWT (admin+) | ✓ Built |
| `POST /api/networks/{network_id}/users` | POST | Create invite; returns a 24h onboarding link (no email sent) | JWT (owner) | ✓ Built |
| `PUT /api/networks/{network_id}/users/{user_id}` | PUT | Change user role or revoke access | JWT (owner) | ✓ Built |
| `POST /api/auth/accept-invite` | POST | Redeem an onboarding link, create the account | Public | ✓ Built |
| `POST /api/networks/{network_id}/webhooks` | POST | Register webhook (secret shown once) | JWT (admin+) | ✓ Built (no delivery/signing yet) |
| `GET /api/networks/{network_id}/webhooks` | GET | List webhooks | JWT (admin+) | ✓ Built |
| `DELETE /api/networks/{network_id}/webhooks/{webhook_id}` | DELETE | Delete webhook | JWT (admin+) | ✓ Built |

**Modified endpoints:**
- All existing `/api/creator/*` endpoints enforce `network_id` in middleware and queries
- `GET /api/creator/episodes` → Returns only episodes for current network
- `POST /api/creator/episodes` → Assigns `network_id` from JWT
- Registration responses gain an additive `network` object

### Live Streaming Foundation (Phase 2 Infrastructure Only)

The following is built but not exposed via API in Phase 2. Phase 3 adds endpoints and UI.

**Real-Time Infrastructure:**
- `streams`, `stream_guests`, `stream_recordings` tables exist and are queryable
- RTMP ingest server (Phase 3 deployment): receives streams, routes by stream_id + key
- HLS/DASH encoder (Phase 3): transcodes RTMP to multiple bitrates, playlists in R2
- Real-time message bus (Redis, Phase 3): pub/sub for guest status, chat, scene switches
- Recording service (Phase 3): segments stream, saves to R2 as VOD

**Guest/Remote Architecture:**
- Guest role in JWT created for remote guests, expires at stream end_time
- RTMP ingest per guest: unique URL `rtmp://<network-domain>/live/<stream_id>/<guest_rtmp_key>`
- Fallback for non-RTMP guests: browser-based WebRTC gateway (Phase 3+)
- Guest metadata in `stream_guests` table: name, role, ingest status, joined_at, left_at

### Phase 2 Decisions & Constraints

**Nullable network_id in Database:**
SQLite's ALTER TABLE cannot add NOT NULL foreign-key columns. `network_id` is nullable in the schema; middleware enforces it in code. Phase 5 can rebuild tables if needed.

**Timestamps:**
Stream tables use `TEXT datetime('now')` format to match Phase 1 migrations (0001), not unix timestamps. This is sortable, human-readable, and debuggable.

**Global Email Uniqueness (Phase 2 Constraint):**
Emails are unique across all networks, and each user belongs to exactly one network (`users.network_id`). Login has no network context yet. Letting one person belong to several networks would need a separate membership table; revisit if creators ask.

**API Keys:**
- Public key (for browser embeds) and private key (server-to-server) are shown once, at network creation
- Only SHA-256 hashes are stored; keys cannot be recovered
- Validation + rate limiting: built on `GET /api/public/episodes/:id` (bearer key; `X-RateLimit-*` and `Retry-After` headers; open CORS for browser embeds). Counters live in D1 (`rate_limits`) because Workers isolates share no memory, at the cost of one small write per request. Scope is global (any network's key reads any published episode) until subdomain scoping.
- Not yet built: key rotation/regeneration endpoint

**R2 Key Prefix:**
New uploads go under `networks/<network_id>/…`. Existing Phase 1 episodes keep their original keys and continue working.

**Deleted Users:**
Login and token refresh reject users with `deleted_at` set. Soft deletes preserve data lineage.

**Old Sessions:**
Tokens issued before this change are rejected once; users log in again.

**Public Listing:**
`GET /api/episodes` and `GET /api/episodes/:id` still list published episodes across all networks (platform directory). Before network sites rely on this, scope it by subdomain or API key.

### Implementation Timeline

| Week | Work |
|------|------|
| 1–2 | Network provisioning, JWT/RBAC enforcement, query scoping, isolation tests ✓ |
| 3–4 | User management, invites, settings, webhook registration ✓; remaining: audit endpoints, token rotation |
| 5–6 | Stripe Express provisioning, webhook handling, API key validation/rate limits |
| 7–8 | Stream tables are already created; populate/verify data structures (no endpoints yet) |
| 9–10 | Dashboard UI: network selector, user management, settings pages |
| 11–12 | End-to-end testing: multi-network isolation, provisioning flow, RBAC enforcement |
| 13–16 | Buffer, hardening, documentation |

### Success Criteria

- ☑ Multiple networks coexist on the same database with no cross-network leakage on creator routes (proven by tests)
- ☑ Network provisioning (signup → network + API keys + Stripe placeholder) works end-to-end
- ☑ RBAC enforced on creator routes: guests are blocked, other networks' episodes are invisible
- ☐ Each network's Stripe account receives correct payouts minus platform fee
- ☑ API keys generate, validate (SHA-256 lookup) and rate-limit (D1 fixed-window counter: 1000/hr public, 10k/hr private)
- ☐ Webhooks signed and routed to correct network handler (registration ✓; delivery, HMAC signing and retries not built)
- ☑ Live streaming tables exist, schema supports guest RTMP ingest + recording storage
- ☐ Backward compatible: Phase 1 endpoints work, but existing sessions must re-login once

---

## Phase 3: Live Broadcasting, AI Director, Smart Soundstage

**Timeline:** Q2–Q3 2027 (12–16 weeks)  
**Status:** Planned

### Objectives

- Enable creators to go live in real-time with HLS/DASH delivery to listeners
- Integrate AI-assisted production: real-time scene detection, audio mixing, guest framing
- Enable hardware-controlled soundstage: multi-camera support, automated switching, live graphics
- First production networks go live on FREQ ONE Cloud

### Live Streaming Architecture

**RTMP Ingest & Transcoding:**
- Receives OBS/Streamlabs streams, validates auth via stream_id + rtmp_key
- Transcodes to HLS @ 720p, 480p, 360p (adaptive bitrate) + DASH @ same resolutions
- Playlists stored in R2, served via CloudFront CDN
- 2–5 second end-to-end latency (near real-time, suitable for interactive shows)
- Automatic failover if RTMP connection lost

**Guest & Remote Host Integration:**
- Each remote guest receives unique RTMP URL + key (from `stream_guests` table)
- Browser guests: WebRTC gateway for non-OBS guests
- Host sees real-time ingest status (waiting, connected, streaming)
- Can mute audio, toggle video, eject guest

**Real-Time Communication:**
- Redis pub/sub: network-scoped channels per stream
- Messages: guest joined/left, scene switch, chat, director command
- <100ms latency (responsive director UI and guest feedback)

### AI Director

**Computer Vision (Scene Detection):**
- Input: incoming RTMP stream (main host camera)
- Model: TensorFlow.js or ONNX.js
- Detections: human presence, pose, scene context (studio, outdoor, home office)
- Output: scene confidence, key frame detection

**Audio Mixing:**
- Inputs: host mic, guest mics, background music/effects
- Real-time levels, compressor, EQ, noise gate
- Normalization: all sources to standard loudness (-14 LUFS)
- Output: mixed audio to RTMP encoder + VOD track

**Guest Framing:**
- Multi-camera switching based on guest presence and speech
- Picture-in-picture recommendations
- Auto-crop if guest off-center

### Smart Soundstage

**Hardware Controller:**
- Supported: PTZ cameras (ONVIF), LED lighting (DMX), graphics overlay (OBS/Streamlabs), physical set automation (Arduino/Home Assistant)
- Director commands: scene presets, lighting, camera angles, graphics layers
- Real-time sync: WebSocket to hardware controller, <200ms latency

**Scene Presets:**
- Pre-configured: Interview (2-shot), Presentation (slides + host), Announcement (full-screen), Panel (multi-guest)
- Each has camera angles, lighting, graphics templates
- One-click switching
- Custom presets: record during setup

### Success Criteria

- ✓ Creator can schedule live stream, share RTMP URL with OBS/Streamlabs
- ✓ Stream goes live, HLS/DASH playlists generated, playable in browser (adaptive bitrate)
- ✓ Multiple guests can ingest simultaneous RTMP feeds without latency degradation
- ✓ Director can switch cameras, control lighting, apply scene presets in real-time
- ✓ AI detects scene changes, recommends camera angles, maintains audio levels
- ✓ Listeners see live stream with guest tiles, can donate/subscribe
- ✓ First 3 FREQ ONE Cloud networks successfully go live with zero critical incidents

---

## Phase 4: Distribution, Monetization Scaling, Platform Network Effects

**Timeline:** Q4 2027 – Q1 2028 (12–16 weeks)  
**Status:** Planned

### Objectives

- Distribute episodes and streams to Apple Podcasts, Spotify, YouTube, and major platforms
- Scale monetization: tiered subscriptions, premium features, sponsorship marketplace
- Build network effects: creator discovery, listener recommendations, ecosystem partnerships

### Multi-Platform Distribution

**Podcast Feeds:**
- Each network generates RSS feed automatically from episodes + streams (as VOD)
- One-click submit to Apple Podcasts, Spotify, YouTube Music, Amazon Music Podcasts
- Metadata sync: cover art, description, guest credits, transcript (Phase 5 AI transcription)
- Auto-update on platforms when episode updated on FREQ ONE

**Video Distribution:**
- YouTube: auto-upload stream VODs to creator channel (with network branding)
- TikTok/Shorts: 60-second highlights auto-generated from applause/laughter segments, uploaded to TikTok/Instagram Reels with link to full episode

**Embed & White-Label:**
- Embeddable player: creator embeds on personal website, LinkedIn, Substack (light/dark mode)
- Whitelabel dashboard: custom domain (netzero.ai/episodes instead of freq.one/networks/net_123)

### Monetization Scaling

**Subscription Tiers:**
- Tier 1 (Free): 3 free episodes/month, ads, limited community
- Tier 2 ($9.99/month): Unlimited episodes, no ads, exclusive community
- Tier 3 ($29.99/month): Tier 2 + monthly Q&A, early access, merch discount
- Tier 4 ($99/month): Tier 3 + 1-on-1 call, custom episode request

**Sponsorship Marketplace:**
- Network listing: listener demographics, download counts, engagement rates
- Sponsor request: placement in specific episodes or time slots
- Creator approval: set price and placement
- Dynamic insertion: sponsor ad inserted into VOD and podcast feed (geo-targeting, A/B testing)

**Premium Features:**
- Advanced analytics: listener drop-off, sentiment analysis, recommendation flow
- AI insights: auto-transcript, keyword extraction, guest bio auto-fetch, topic clustering
- Monetization tools: affiliate links, Patreon embed, digital product storefront

### Network Effects & Discovery

**Creator Discovery:**
- Network directory: filterable by category/language
- Recommendation algorithm: based on listening history, community follows
- Trending dashboard: top networks by listener growth, engagement, new episodes

**Community Features:**
- Network communities: Discord-like channels (#general, #episodes, #meta, creator-moderated)
- Cross-network collab: joint stream (multi-network stream_id, appear in both directories)
- Listener follows: follow creators, get aggregated feed

**Platform Partnerships:**
- Influencer partnerships: 50+ influencers for native placements
- Corporate partnerships: enterprise networks get dedicated support + custom features
- University program: educational networks get free premium tier

### Success Criteria

- ✓ 500+ networks on FREQ ONE platform
- ✓ Each network's episodes on 5+ distribution platforms
- ✓ Subscription revenue: avg $5k/month per active network
- ✓ Sponsorship marketplace: 10+ brands running ads, avg $2k/sponsorship
- ✓ FREQ ONE platform revenue: $50k/month (15% platform fee)
- ✓ 1M+ monthly active listeners across all networks
- ✓ Creator retention: 80%+ networks active (monthly episodes or streams)

---

## Phase 5: Production Hardening, Hardware Ecosystem, Superstation OS

**Timeline:** Q2–Q4 2028 (20–24 weeks)  
**Status:** Planned

### Objectives

- Production-grade reliability: 99.99% uptime SLA, disaster recovery, observability
- Dedicated hardware ecosystem: turnkey studio kits, appliances, remote equipment
- Complete Superstation OS: unified content, rights, distribution, production across all networks

### Hardening & Reliability

**Observability:**
- Metrics: Prometheus scraping Workers, D1, R2. Grafana dashboards for latency, error rates, storage usage
- Logging: Structured JSON to Datadog. Per-network, per-user context for troubleshooting
- Tracing: Distributed tracing (OpenTelemetry) across auth, episodes, analytics pipelines
- Alerting: PagerDuty integration for incident response (on-call rotation)

**Disaster Recovery:**
- D1 backups: daily snapshots to R2, tested restore 1x/week. RPO <1 day, RTO <1 hour
- R2 replication: multi-region for critical buckets (us-west, eu-central)
- DNS failover: standby API region on hot-standby. Auto-failover if primary down >5min
- Incident runbooks: procedures for database corruption, API outage, Stripe sync failure

**Security Hardening:**
- Secrets management: Cloudflare Vault for all keys (no secrets in code)
- Rate limiting: Cloudflare WAF DDoS protection. Per-user rate limits in middleware
- Audit logs: all API calls logged with user_id, network_id, action, timestamp
- Penetration testing: annual third-party audit. Bug bounty program

### Hardware Ecosystem

**FREQ ONE Appliance:**
- Form: compact desktop/rack-mounted (Elgato Streamdeck Pro size)
- Specs: ARM64 (Apple Silicon or Qualcomm), 8GB RAM, 256GB SSD, Gigabit Ethernet, HDMI out
- Capabilities: director console UI (browser-based), controls cameras/lighting (ONVIF, DMX, MQTT), local streaming fallback
- Price: $2,999 (1-year support, firmware updates)

**Turnkey Studio Kit:**
- Components: FREQ ONE Appliance + PTZ camera + LED light ring + wireless mic + XLR mixer + cables
- Setup time: <30 minutes
- Price: $7,999 (includes appliance, hardware, training, 2-day onboarding)
- Target: small studios, remote teams, corporate producers

**Remote Hardware Control:**
- FREQ ONE Remote: wireless control for cameras, lighting, scene presets. Bluetooth to appliance.
- Mobile director app: iOS/Android directing from anywhere (4G/WiFi). Real-time sync with studio.
- Guest hardware pod: lightweight, battery-powered device for remote guests. Built-in audio/video, WiFi, RTMP ingest. Plug-and-play.

### Superstation OS

**Content Hub:**
- Unified library: all episodes and streams from all networks in one searchable dashboard (role-based access)
- Smart tagging: AI auto-tags episodes by topic, guest, sentiment. Creators can override.
- Rights management: track network ownership. Enforce IP/copyright. License content to other networks.

**Production Suite:**
- Unified editor: edit, trim, clip episodes across all networks. Generate highlights, transcripts, captions (auto AI)
- Template library: reusable scene presets, graphics templates, music beds. Share across networks.
- Quality control: automated checks (audio levels, captions, metadata). Flag for review before publish.

**Analytics & Business Intelligence:**
- Cross-network dashboard: aggregate metrics (total listeners, engagement, network growth, sponsorship ROI)
- Predictive models: forecast trending topics, optimal publish times, listener churn risk
- Attribution: sponsor mention conversions, guest-driven listener repeat rate

**Ecosystem Integrations:**
- Native integrations: Slack (post to channel), Zapier (workflows), Google Workspace (calendar sync), Stripe (billing)
- API first: all features via REST + GraphQL. Third-party developers can build apps.
- Marketplace: app store for third-party integrations (transcription, distribution partners, analytics)

### Success Criteria

- ✓ 99.99% uptime SLA maintained for 12 consecutive months
- ✓ Disaster recovery tested successfully
- ✓ 1,000+ hardware units shipped
- ✓ Hardware NPS > 70
- ✓ 80%+ of networks using Superstation OS features
- ✓ Annual recurring revenue (ARR): $5M+ (SaaS + hardware + platform fees)
- ✓ $20M+ annual GMV across all networks

---

## Cross-Phase Dependencies & Critical Path

### Dependency Graph

- **Phase 1 → Phase 2:** Phase 2 builds on Phase 1's auth, episode CRUD, API patterns. Add network_id to existing tables and middleware.
- **Phase 2 → Phase 3:** Live streaming data structures (streams, stream_guests, stream_recordings) exist in Phase 2; Phase 3 adds RTMP ingest, transcoding, director UI.
- **Phase 3 → Phase 4:** Phase 4 distributes Phase 3 streams (as VODs) to external platforms. Integrations only.
- **Phase 4 → Phase 5:** Phase 5 hardens infrastructure built in Phases 1–4. Observability, DR, hardware.

### Critical Path

Longest sequential dependency chain (blocks completion date):

1. **Phase 1** ✓ (Complete) — Creator dashboard validated. Unblocks Phase 2.
2. **Phase 2** (16 weeks) — Multi-network isolation + provisioning. Unblocks Phase 3.
3. **Phase 3** (16 weeks) — Live streaming + AI + hardware. Unblocks Phase 4.
4. **Phase 4** (16 weeks) — Distribution + monetization. Unblocks Phase 5.
5. **Phase 5** (24 weeks) — Hardening + hardware ecosystem. Final phase.

**Total critical path: ~72 weeks (17 months)** from Phase 2 start through Phase 5 complete.

### Risk Mitigation

- **Parallel work:** While Phase 3 works on live streaming, Phase 4 designs distribution integrations, Phase 5 plans observability.
- **Stripe Express risk:** Late integration in Phase 2 could slip. Mitigation: mock Stripe API until Phase 2 Week 8, then integrate real accounts.
- **RTMP/HLS risk:** Cloudflare Stream API may not support all features. Mitigation: parallel evaluation of Wowza, AWS MediaLive. Decision by Phase 2 Week 12.
- **Hardware supply chain:** Long lead times. Mitigation: place orders by Phase 3 Week 12.

---

## Next Immediate Action (Phase 2, Week 3–4)

**Priority 4: User Management & Settings Endpoints — ✓ built (invites are onboarding links; email sending is Phase 3+)**

Done since: API key validation + rate limiting (5a).

Next: Stripe Express provisioning (5b), webhook delivery + HMAC signing (5c), key rotation.

Now that network provisioning and RBAC are working, build the management endpoints:

1. `POST /api/networks/{network_id}/users` — Invite user to network (open question: send email, or return an onboarding link)
2. `GET /api/networks/{network_id}/users` — List network users with roles
3. `PUT /api/networks/{network_id}/users/{user_id}` — Change role or revoke access
4. `PUT /api/networks/{network_id}/settings` — Update network name, description, branding

These unblock the dashboard UI work (Week 9–10) and move toward the Phase 2 Week 4 checkpoint (all admin endpoints working, full RBAC enforcement).

---

## Appendix: Architecture Evolution Summary

| Aspect | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|--------|---------|---------|---------|---------|---------|
| **Networks** | Single | Multi-tenant | Each can stream | Reach external platforms | Unified OS, all features |
| **Content Types** | Episodes (VOD) | Episodes only | Episodes + Streams | Episodes + Streams + Highlights | All + AI-generated |
| **Storage** | Episodes in R2 | Network-partitioned R2 | Live streams to R2 (HLS/DASH) | VODs, clips, metadata | Global CDN, multi-region |
| **Database** | Single D1 | Shared D1, partitioned by network_id | Add streams, guests | Add analytics, rights | Unified schema, sharding optional |
| **Monetization** | None | Stripe per-network setup | Pay-per-view + subscriptions | Sponsorships, affiliates, premium | Hardware sales, ecosystem |
| **Real-Time** | None | Webhook infrastructure | RTMP, Redis pub/sub, WebSocket | Real-time analytics, chat | Cross-network sync |
| **Hardware** | None | None | Controller service, presets | Smart soundstage, remote | Appliances, kits, remote gear |
| **Teams** | 1 | 2 | 3 | 4 | 5+ |

---

## Document History

| Date | Status | Notes |
|------|--------|-------|
| 2026-10-10 | Phase 2 Week 1–2 | Network provisioning, JWT/RBAC, query scoping and isolation tests done (migrations 0002, 32 tests passing). Admin endpoints next. |
