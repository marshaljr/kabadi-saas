# Development Status

_Last updated: end of Phase 1._

## Phase 0 — Analysis ✅ Complete
Architecture analysis delivered and approved. See `ARCHITECTURE.md` for
the corrected SaaS data model and the full list of gaps found in the
original ERD/schema.

## Phase 1 — Project Foundation ✅ Complete

**Implemented:**
- TypeScript project setup (strict mode, ES modules, Node 20+)
- Centralized environment configuration (`src/config/env.ts`), including
  a split between `DATABASE_URL` (app runtime, RLS-restricted role) and
  `DATABASE_MIGRATION_URL` (migration runner, DDL-owning role)
- PostgreSQL connection pool (`src/db/pool.ts`) and migration runner
  (`src/db/migrate.ts`)
- Full migration set, `0001` through `0009` (see `DATABASE.md`). `0009`
  fixes a Row-Level Security gap on `role_permissions` (it had none —
  the table has no `business_id` column of its own, so it needed an
  `EXISTS`-based policy through `roles.business_id` rather than the
  generic pattern used elsewhere).
- Versioned ERD source (`docs/ERD.mermaid`), rendered and visually
  verified to `docs/ERD.png`
- Row-Level Security on every tenant table, including `role_permissions`
  as of `0009`, with the `business_memberships` dual-clause policy
  solving the "list my businesses before selecting one" bootstrap
  problem
- Error handling that never leaks raw errors to clients
  (`src/lib/httpError.ts`), with a corrected status-code split for
  `AuthError`: `NOT_A_MEMBER`/`MEMBERSHIP_INACTIVE` → `403`
  (authenticated but not authorized for that business);
  `INVALID_CREDENTIALS`/`ACCOUNT_INACTIVE`/`EMAIL_TAKEN` → `401`
  (genuine authentication/signup failures)
- Authentication foundation: signup, login, list-my-businesses,
  select-active-business, JWT issuance/verification
  (`src/modules/auth/auth.service.ts`)
- Backend permission-checking against `role_permissions`
  (`src/middleware/authorize.ts`) — not a frontend-only check
- A minimal HTTP server wiring all of the above end-to-end
  (`src/server.ts`)
- Unit tests for password hashing, JWT, permission checks, and HTTP
  error-status mapping (23 tests, zero database dependency)
- A real-database integration test
  (`tests/integration/tenant-isolation.test.ts`) proving RLS blocks
  cross-tenant SELECT/UPDATE/INSERT on `workers` and `role_permissions`
- An `.env`-aware `npm test` script so the integration test above picks
  up local `DATABASE_URL`/`DATABASE_MIGRATION_URL` automatically
- Documentation: `README.md`, `ARCHITECTURE.md`, `DATABASE.md`,
  `TESTING.md`, `ENVIRONMENT.md`, `API.md`, `DEPLOYMENT.md`

**Test results — reported precisely, from the environment that actually
ran them (this sandbox, on the `claude/phase1-cleanup` branch):**
- `npm run typecheck` equivalent (`tsc --noEmit`) → **0 errors**
- Test run → **23 passed, 1 failed, out of 24 total.** The 1 failure is
  `tests/integration/tenant-isolation.test.ts`, which fails with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'pg'`. This sandbox has no
  network access, so the real `pg` package was never installed here —
  this is an environment limitation, not a code defect, and neither
  `src/db/pool.ts` nor the test file were modified in this round. All
  23 database-independent tests pass, including all 8 new `httpError`
  tests.
- **This has not been run on the project owner's Mac as part of this
  round.** Whether it produces 24/24 there (where `pg` and a real
  Postgres instance are actually available) has not been confirmed by
  either party as of this writing — that confirmation is a pending
  action item, not a stated fact.

**Known limitations (environment, not design):**
- This round of cleanup was done in a network-isolated sandbox (no
  `npm install`, no real Postgres, no GitHub access — cloned from a git
  bundle instead). A locally-vendored copy of `@types/node` and the
  globally-installed `tsx`/`typescript` were used to run
  `typecheck`/tests; `src/types/pg-shim.d.ts` was left untouched (out of
  scope for this round).
- No git push to GitHub was performed or attempted from this sandbox —
  GitHub is unreachable from here. The `claude/phase1-cleanup` branch
  and its commit exist only in this sandbox; applying/pushing them is a
  manual step for whoever has GitHub access.

**Not implemented in Phase 1 (by design, deferred to later phases):**
- Business creation / onboarding flow
- Any of workers, materials, purchases, sales, inventory, accounting,
  expenses *service logic* (schema exists; services don't yet)
- Frontend (React/Vite) — no scaffolding created yet
- A real HTTP framework (Express/Fastify) in place of `node:http`

## Phase 2 — SaaS Foundation — Not started
See `NEXT_STEPS.md`.

## Phases 3-10
Not started.
