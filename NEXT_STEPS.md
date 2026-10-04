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

## Phase 2 — SaaS Foundation

**Status: implemented on `claude/phase2-saas-foundation`, sandbox-verified
where the sandbox is capable of verifying (see `DEVELOPMENT_STATUS.md`
for the exact, honest breakdown), NOT YET verified against a real
PostgreSQL instance.**

Action items before this phase can be considered closed:
1. **Run the real test suite on the Mac.** `npm test` there should
   execute all 5 new `business-onboarding.test.ts` scenarios for real,
   including the atomic-rollback proof, which has never actually run
   anywhere yet — only reviewed and typechecked.
2. **Review the default role→permission mapping**
   (`src/modules/business/roleDefaults.ts`) — it's a reasonable
   starting point (documented rationale in the file itself) but is a
   product decision, not a technical one; adjust before real users hit
   it if the defaults feel wrong for the target businesses.
3. Decide whether `POST /api/businesses` needs request-level
   idempotency (a double-submitted "Create Business" click currently
   creates two businesses, not one) — see the explicit note on this in
   `DEVELOPMENT_STATUS.md`. Not solved in Phase 2; would need a new
   mechanism (idempotency key) if it's needed.
4. **Known gap:** permission keys added by future migrations are not
   automatically granted to *existing* businesses' Owner roles —
   `role_permissions` is a snapshot taken at onboarding. Any migration
   that adds a permission key needs a matching backfill (or a shared
   "repair defaults" operation, which `seedDefaultRoles` /
   `assignDefaultPermissions` are already shaped to support).
5. Wire up a real HTTP framework (Express or Fastify per section 56) —
   still open from Phase 1, now with three more routes to carry over.

## Phases 3-10

Unchanged from the Master Build Prompt's own phased plan (materials &
people → collections/purchases → inventory → sales → accounting → reports
→ UI polish → testing & hardening). Each phase should follow the same
pattern established in Phases 1-2: schema first only if genuinely
needed, service logic with `withTenantContext`, backend permission
checks via `requirePermission`, tests (including a real-DB integration
test for anything RLS-relevant), docs updated, checkpoint commit.

## Documentation debt

- `API.md` needs the full endpoint list from section 54 filled in as each
  lands (Phase 1's four auth endpoints and Phase 2's three new endpoints
  are documented; workers/purchases/sales/etc. still pending).
- `DEPLOYMENT.md` has no concrete steps yet — needs a real hosting
  decision first.
