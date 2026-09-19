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

## Action items from this round of cleanup

- **Run `npm test` on a machine with real `pg` installed and a real
  Postgres instance** to get an actual, verified pass count including
  `tests/httpError.test.ts` (8 new tests) and
  `tests/integration/tenant-isolation.test.ts`. In the sandbox that
  produced this round's changes, the result was 23/24 (1 failure caused
  by `pg` not being installable there — see `DEVELOPMENT_STATUS.md`).
  That sandbox result is NOT a substitute for running it for real.
- **Confirm whether `src/types/pg-shim.d.ts` is still needed.** It was
  left untouched in this round (out of scope). Check whether
  `node_modules/@types/pg` exists in the actual project checkout — if
  it does and `npm run typecheck` still passes with the shim removed,
  delete it.
- Apply the `claude/phase1-cleanup` branch/patch from this round and
  merge it into `main` once reviewed (not done automatically — this
  round explicitly did not commit to or push `main`, and did not push
  anywhere at all).

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
