# Development Status

_Last updated: end of Phase 2 (claude/phase2-saas-foundation branch, not yet merged)._

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

## Phase 2 — SaaS Foundation ✅ Complete (sandbox-verified where possible; real-DB verification pending)

**Implemented:**
- Business onboarding (`src/modules/business/business.service.ts`):
  `createBusiness(userId, input)` runs the full lifecycle — create
  business → seed 4 default system roles → assign default permissions
  → create owner membership → seed default chart of accounts (reuses
  the existing `seed_default_accounts()`, does not duplicate it) →
  create `TRIALING` subscription → record initial usage — inside a
  single `withTenantContext` transaction. Split into `createBusinessTx`
  (pure step sequence, takes an already-scoped client) and the public
  `createBusiness` wrapper (generates the business id, owns the
  transaction) — this separation is what makes the rollback test below
  possible without leaving test data behind.
- Default role/permission mapping (`src/modules/business/roleDefaults.ts`):
  explicit, hand-written key lists for Manager/Data Entry/Collector
  against the real 29-key permission catalog seeded in migration
  `0001`; Owner receives every permission that exists in the catalog
  **at the moment that specific business is onboarded** — a one-time
  grant, not a fixed hardcoded list, and importantly *not* a live
  subscription: an existing business's Owner role does not
  automatically receive permission keys added by later migrations
  after it was created.
- Usage tracking foundation (`src/modules/usage/usage.service.ts`):
  `recordUsage` (atomic upsert into `usage_records`, current calendar
  month), `getUsageSummary` (current usage + plan limits) —
  deliberately minimal, no billing analytics, no Stripe.
- Platform-admin foundation (`src/modules/admin/admin.service.ts`):
  `isPlatformAdmin`/`requirePlatformAdmin` (checked via
  `platform_admins`, independent of any business role) and one
  read-only cross-tenant listing (`listAllBusinesses`, via
  `withPlatformAdminContext`) — not a dashboard.
- New endpoints in `src/server.ts`: `POST /api/businesses`,
  `GET /api/usage`, `GET /api/admin/businesses`. Reuses
  `GET /api/auth/businesses` and `POST /api/auth/select-business` from
  Phase 1 rather than duplicating them under a new prefix.
  **Post-review correction:** `POST /api/businesses` originally
  pre-validated `name` at the route level with `AuthError` (→ `401`) —
  wrong status for a request-validation problem. Fixed by removing that
  check entirely and routing all name validation through
  `createBusinessTx`'s existing `BusinessError("NAME_REQUIRED")` (→
  `400`), which is now defensive against non-string/`undefined` input
  as well (previously a bare `.trim()` on a missing `name` would have
  thrown an unhandled `TypeError`, surfacing as a generic `500`).
- `BusinessError` added to `src/lib/httpError.ts`'s existing duck-typed
  error-mapping pattern (→ `400`), alongside the existing
  `AuthError`/`ForbiddenError` handling — extended, not rewritten.
- **No new migration.** Every table/function Phase 2 needed already
  existed from `0001`/`0002`/`0006` — confirmed by reading the actual
  schema before writing any service code, not assumed.
- Tests: `tests/business.roleDefaults.test.ts` (8 tests, pure logic —
  cross-checks every default-mapped permission key against the actual
  migration `0001` seed data, not a hardcoded copy of it),
  `tests/business.validation.test.ts` (4 tests, pure logic, **added in
  the post-review correction round** — proves the `NAME_REQUIRED`
  validation fix above using a `PoolClient` stand-in that throws if
  ever queried, so passing also proves validation happens before any
  database access), 2 new cases in `tests/httpError.test.ts` for the
  `BusinessError` → `400` mapping, and
  `tests/integration/business-onboarding.test.ts` (5 scenarios: full
  success path including permission-enforcement spot checks, **atomic
  rollback proof** — a deliberately-invalid plan code fails partway
  through onboarding and a separate connection then confirms zero rows
  exist for that business across `businesses`/`roles`/
  `business_memberships`/`accounts`/`subscriptions`/`usage_records` —
  idempotent reseeding, RLS isolation on the two new tenant tables, and
  full business-switching including non-member/inactive-membership
  rejection). **Post-review correction:** the business-switching
  scenario originally called the full `createBusiness()` onboarding
  (creating ~57 rows across 8 tables: 4 roles, ~29 role_permissions, 18
  accounts, 1 subscription, 1 event, 1 usage record, 1 membership) just
  to test `selectActiveBusiness`, then only soft-deleted the business
  afterward — leaving 56 of those rows behind permanently on every test
  run, across every table. Rewritten to construct only the minimal
  fixture business switching actually needs (one business, one Owner
  role, one membership), and to properly hard-delete the membership and
  role rows in cleanup (both support real `DELETE` under platform-admin
  RLS context — the generic tenant policy has no explicit `FOR` clause,
  so it defaults to `FOR ALL`). Only the `businesses` row itself is
  soft-deleted (`deleted_at`), because that table genuinely has no
  `DELETE` policy at all (by design — see `DATABASE.md`) — this is not
  a workaround or a weakening of that design, it's the same operation a
  real "archive this business" action would perform. Net effect: one
  soft-deleted, otherwise-empty business row left behind per test run,
  down from a full tenant's worth of live-looking data.
- Documentation: `DATABASE.md` (migration table corrected to include
  `0009`, which had been missing — unrelated pre-existing gap fixed
  while already there; new Phase 2 "no new migration" note; new note on
  why `businesses` has no `DELETE` RLS policy), `API.md` (new
  endpoints documented), this file, `NEXT_STEPS.md`, `CHANGELOG.md`.

**On idempotency/retry-safety — read this before assuming more than
what's actually implemented:** `seedDefaultRoles` and
`assignDefaultPermissions` are genuinely idempotent (tested directly,
twice-in-a-row, in the same transaction) via `ON CONFLICT DO NOTHING`
plus a re-read step. `seed_default_accounts()` was already idempotent
before Phase 2 touched anything. **Full business-creation-request
idempotency (e.g., a double-clicked "Create Business" button producing
one business instead of two) is NOT implemented.** `createBusiness`
generates a fresh UUID per call, so two independent calls create two
independent businesses — this is correct behavior for "the user
deliberately created two businesses" and would also happen for "the
same click got sent twice," and Phase 2 does not distinguish between
those cases. Solving that would need a client-supplied idempotency key,
which does not exist anywhere in the current schema or architecture,
and inventing one was explicitly out of scope for this phase. What
Phase 2 *does* guarantee is atomicity: no half-created tenant is ever
left behind, proven by the rollback test above.

**Test results — reported precisely, and kept separate by environment
as instructed:**

*In the sandbox that produced this round's changes* (no network
access — cloned from `kabadi-saas-phase2-base.bundle`, no `pg` package
installable):
- `tsc --noEmit` → **0 errors**
- Full test run (`tsx --test tests/*.test.ts tests/integration/*.test.ts`)
  → **38 passed, 3 failed, 0 skipped, out of 41 total.** The 3 failures
  are the three files under `tests/integration/` that need the real
  `pg` package: `tenant-isolation.test.ts` (pre-existing, unrelated to
  Phase 2), `business-onboarding.test.ts`, and `http-routes.test.ts`.
  Each fails with `ERR_MODULE_NOT_FOUND: Cannot find package 'pg'` at
  module-load time, before a single assertion runs, because this
  sandbox cannot install `pg`. **None of the 5 business-onboarding
  scenarios — including the rollback proof — nor the 2 HTTP route tests
  have executed against a real database anywhere yet.** Every other
  test genuinely ran and passed, including
  `tests/business.validation.test.ts` (5 tests) and the 2
  `BusinessError` mapping tests in `tests/httpError.test.ts`.
- **HTTP route tests (`tests/integration/http-routes.test.ts`) — what
  was and was not verified.** They start the real `server` from
  `src/server.ts` and send real HTTP requests (via `node:http`):
  `POST /api/businesses` with a missing/blank/non-string name → `400`,
  and `GET /api/admin/businesses` as a non-platform-admin → `403`. They
  can't load in the sandbox for two independent reasons: they need
  `pg`, and `server.ts` statically imports Phase 1's `auth.service.ts`,
  which imports `pg` eagerly (Phase 1 code was deliberately not
  reworked to change that). As a partial check, they were also run once
  against a **temporary fake `pg` module and dummy env vars** — a stub
  that only answers `BEGIN`/`COMMIT`/`ROLLBACK`, `set_config`, and the
  `platform_admins` lookup (returning "not an admin") and throws on
  anything else. Both tests passed on that stub. That verifies the
  routing, token handling, and error-to-status mapping code paths; it
  is **not** a database test and does not replace running them against
  real Postgres. The stub was deleted and is not in the branch.
- **Early name validation is separately unit-tested.**
  `createBusiness()` validates the name *before* dynamically importing
  the database layer. The HTTP test cannot distinguish that ordering
  (the 400 comes out the same either way), so
  `business.validation.test.ts` has a test that only passes if the early
  check exists — confirmed by removing the check, watching that test
  fail, and restoring it.
- **Post-review correction:** the first version of
  `business.validation.test.ts` also failed to import in this sandbox,
  for the same `pg`-not-installed reason as the two integration test
  files — even though the actual test logic never touches the database.
  The root cause was `business.service.ts` eagerly importing
  `withTenantContext` from `db/tenantContext.ts` at the top of the file,
  which transitively imports the real `pg` package via `db/pool.ts`.
  Fixed by making that one import lazy (`await
  import("../../db/tenantContext.js")`, used only inside the
  `createBusiness` wrapper, which is the only function that actually
  needs it) — `createBusinessTx` and its validation logic no longer
  pull in `pg` at module-load time at all. This has no behavioral
  effect in production (Node caches a dynamic import exactly like a
  static one); it only changes what a test file importing
  `createBusinessTx` in isolation is forced to load alongside it.
- A temporary local type shim was used to make `tsc` possible in this
  sandbox and was deleted before any commit — it is not part of this
  branch's diff.

*On the project owner's Mac, with real `pg` and a real Postgres
instance:* **not yet run as of this writing.** This is the pending
verification step — do not treat the sandbox's 31/33 as the project's
verified Phase 2 result; it is explicitly not, for the same reason the
Phase 1 cleanup sandbox result wasn't (see the Phase 1 section above).

**Not implemented in Phase 2 (by design, deferred):**
- Billing/Stripe integration
- Usage-limit enforcement/blocking (counting only, no gates yet)
- A platform-admin dashboard (one read-only endpoint only)
- Request-level onboarding idempotency (see note above)
- workers, materials, purchases, sales, inventory, accounting
  transaction services, reports, frontend — explicitly out of scope
  per the Phase 2 brief's scope-control section

## Phases 3-10
Not started.
