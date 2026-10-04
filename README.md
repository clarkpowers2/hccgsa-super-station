# HCCGSA Super Station

Broadcasting platform API (Cloudflare Workers + D1 + R2). Spec: `docs/SPEC.md`.

## Local setup
1. `npm install`
2. `cp .dev.vars.example .dev.vars` and fill in values (file is gitignored)
3. `npm run db:migrate:local`
4. `npm run dev`

Checks: `npm run typecheck` · `npm test`
