# Next Steps

## Status of the previous "Immediate" list

Confirmed done, based on what this repository's `main` branch actually
contains as of commit `b7648d6` (verified by inspecting the code, not
assumed):
1. ~~`npm install`, provision Postgres, create `kabadi_migrator`/`kabadi_app` roles~~ — `DATABASE_MIGRATION_URL`/`DATABASE_URL` split exists in `src/config/env.ts`, implying this was done
2. ~~Run migrations 0001-0009 against a real database~~ — stated as done by the project owner; not independently re-verified in this round
3. ~~Add the tenant-isolation integration test~~ — done, `tests/integration/tenant-isolation.test.ts` exists and covers `workers`/`role_permissions`
4. Push this repository to GitHub — the project owner has stated this is done (`https://github.com/marshaljr/kabadi-saas`); not independently verifiable from this sandbox, which has no GitHub network access

Still open from that list:
5. Wire up a real HTTP framework (Express or Fastify per section 56) in
   place of the `node:http` server in `src/server.ts`. Route handlers are
   already small, framework-agnostic async functions — this should be a
   thin wrapper, not a rewrite.

## Phase 1 cleanup status

Phase 1 cleanup has been applied, reviewed, merged into `main`, and
verified locally.

Verified on the project owner's Mac:
- `npm run typecheck` → 0 errors
- `npm test` → 24 passed, 0 failed, 0 skipped
- Real PostgreSQL tenant-isolation integration test → passed
- Temporary `src/types/pg-shim.d.ts` → removed after confirming
  `@types/pg` is installed and typecheck remains clean

## Phase 2 — SaaS Foundation (next phase of feature work)

Per the phased plan, once the above is done:
- Business creation / onboarding endpoint: create a `businesses` row,
  immediately set that as the RLS context within the same transaction,
  seed system roles (Owner/Manager/Data Entry/Collector) with their
  default `role_permissions`, call `seed_default_accounts()`, create the
  owner's `business_memberships` row, create a `TRIALING` subscription on
  the FREE (or chosen) plan.
- Business switching endpoint (already partially covered by
  `selectActiveBusiness`, but needs a "switch without re-login" UX path).
- Usage tracking: populate `usage_records` as data is created, and a
  `GET /api/usage` endpoint reading it against the business's plan limits.
- Platform-admin route group, gated on a `platform_admins` row, using
  `withPlatformAdminContext`.

## Phases 3-10

Unchanged from the Master Build Prompt's own phased plan (materials &
people → collections/purchases → inventory → sales → accounting → reports
→ UI polish → testing & hardening). Each phase should follow the same
pattern established in Phase 1: schema first (if needed), service logic
with `withTenantContext`, backend permission checks via
`requirePermission`, tests, docs updated, checkpoint commit.

## Documentation debt

- `API.md` needs the full endpoint list from section 54 filled in as each
  lands (currently only the four auth endpoints are documented).
- `DEPLOYMENT.md` has no concrete steps yet — needs a real hosting
  decision first.
