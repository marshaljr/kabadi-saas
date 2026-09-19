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

**Test results — verified on the project owner's Mac:**
- `npm run typecheck` → **0 errors**
- `npm test` → **24 passed, 0 failed, 0 skipped**
- The real PostgreSQL integration test
  (`tests/integration/tenant-isolation.test.ts`) passed against the
  local `kabadi_saas` database.
- The 8 new HTTP error-status tests also passed.
- `src/types/pg-shim.d.ts` was removed after confirming
  `node_modules/@types/pg` is installed and `npm run typecheck` still
  passes without the shim.

**Sandbox limitation for Claude cleanup work:**
- Claude's network-isolated sandbox could not install/use the real `pg`
  package or access GitHub directly. Its reported sandbox test result
  for the cleanup branch was 23 passed, 1 failed because the integration
  test could not import `pg`. This was not the result of the project
  owner's local environment and is not the project's verified test
  result.

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
