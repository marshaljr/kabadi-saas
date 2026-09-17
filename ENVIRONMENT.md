# Environment Variables

Copy `.env.example` to `.env` and fill in real values. Never commit `.env`.

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | no (default `development`) | `development` \| `test` \| `production` |
| `PORT` | no (default `3000`) | HTTP port for `src/server.ts` |
| `DATABASE_URL` | yes (except `NODE_ENV=test`) | Connection string the **app** uses at runtime. Must authenticate as a non-superuser, non-table-owner role — see `ARCHITECTURE.md`'s tenant isolation contract for why. |
| `DATABASE_MIGRATION_URL` | used by `npm run migrate` | Needs DDL rights; a different (more privileged) role than `DATABASE_URL` is recommended |
| `DATABASE_APP_ROLE` | no (default `kabadi_app`) | Documented for clarity; not currently read by `pool.ts` directly since the role is embedded in `DATABASE_URL`, but kept as an explicit env var so ops tooling / RLS-grant scripts have a single source of truth for the role name |
| `JWT_SECRET` | yes (except `NODE_ENV=test`) | Long random value. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Rotating this invalidates all outstanding tokens. |
| `JWT_ACCESS_TOKEN_TTL_SECONDS` | no (default 28800 = 8h) | Applies to both identity tokens (pre business-selection) and business-scoped tokens |
| `DEFAULT_TRIAL_DAYS` | no (default `14`) | Falls back to whatever `plans.trial_days` says per-plan once onboarding (Phase 2) reads it; this env var is a global default only |

## Client-safe vs. server-only

None of the variables above should ever be exposed to a frontend bundle.
`src/config/env.ts` is the single place `process.env` is read — nothing
else in the codebase should call `process.env` directly, so auditing "is
anything secret leaking to the client" only requires checking that one
file's exports aren't imported from frontend code (no frontend exists yet
in this phase).
