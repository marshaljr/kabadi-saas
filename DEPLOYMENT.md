# Deployment

Target (per Master Build Prompt section 78): frontend on Vercel,
database on Supabase/managed PostgreSQL, backend architecture chosen based
on final framework decision (Phase 1 currently uses plain `node:http`; see
README for the planned Express/Fastify swap-in).

## Not yet configured

This is Phase 1 — no deployment pipeline exists yet. Documented here now
so the constraints are visible early:

- **RLS depends on connection role.** Whatever hosts Postgres (Supabase or
  otherwise), the app's runtime connection string must use a role that is
  neither a superuser nor a table owner, or Row-Level Security
  (`migrations/0008_rls_policies.sql`) is bypassed entirely. Supabase's
  default `service_role` key bypasses RLS by design — do NOT use it for
  the app's normal request-serving connection. Use Supabase's
  RLS-respecting `anon`/`authenticated` roles or a custom role, consistent
  with `DATABASE_URL` in `.env.example`.
- **No local filesystem persistence** — nothing in Phase 1 writes to disk
  outside of `dist/` build output, consistent with section 78's
  requirement.
- **Secrets** must be set as platform environment variables (Vercel
  project settings / Supabase connection secrets), never committed — see
  `ENVIRONMENT.md`.
- **Migrations in production**: run `npm run migrate` as a one-off
  deploy step (or CI job) using the elevated `DATABASE_MIGRATION_URL`
  role, before traffic is routed to a new release. Never run destructive
  manual SQL against production directly — always a new numbered
  migration file, per the project's change-management rule.

This file will be filled in with real steps once a hosting decision and
framework choice (Phase 2+) are finalized.
