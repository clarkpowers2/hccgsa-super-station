# HCCGSA Super Station

Broadcasting platform API (Cloudflare Workers + D1 + R2). Spec: `docs/SPEC.md`.

## Local setup
1. `npm install`
2. `cp .dev.vars.example .dev.vars` and fill in values (file is gitignored)
3. `npm run db:migrate:local`
4. `npm run dev`

Checks: `npm run typecheck` · `npm test`

## R2 upload credentials (one-time, you do this in the Cloudflare dashboard)
1. R2 → Manage API Tokens → create a token with **Object Read & Write**, limited to the `hccgsa-broadcast-media` bucket.
2. Put the Access Key ID and Secret in `.dev.vars` (local) and set them for production with
   `npx wrangler secret put R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID`.
3. Add a CORS rule on the bucket allowing `PUT` from your frontend origin with header `Content-Type`.
