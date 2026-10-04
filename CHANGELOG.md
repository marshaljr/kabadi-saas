# Changelog

All notable changes to this project are recorded here, newest first.

## [Phase 2] — SaaS Foundation (business onboarding, roles/permissions, usage, platform-admin)

### Added
- `src/modules/business/business.service.ts` — `createBusiness`
  (public, transactional) and `createBusinessTx`
  (transaction-internal step sequence): creates a business, seeds the
  four default system roles, assigns default permissions, creates the
  owner's membership, seeds default accounts, creates a trial
  subscription, and records initial usage — all in one atomic
  transaction. `seedDefaultRoles` and `assignDefaultPermissions` are
  exported and independently idempotent.
- `src/modules/business/roleDefaults.ts` — explicit Owner/Manager/Data
  Entry/Collector default permission mapping against the real 29-key
  catalog in migration `0001` (Owner = every permission that exists in
  the catalog at the moment that business is onboarded — a one-time
  grant, not retroactively applied to existing businesses when new
  permission keys are added later; the other three are fixed,
  documented key lists).
- `src/modules/usage/usage.service.ts` — `recordUsage` (atomic upsert),
  `getUsageSummary` (current-period usage + plan limits).
- `src/modules/admin/admin.service.ts` — `isPlatformAdmin`,
  `requirePlatformAdmin`, `listAllBusinesses` — minimal platform-admin
  foundation, not a dashboard.
- New endpoints: `POST /api/businesses`, `GET /api/usage`,
  `GET /api/admin/businesses` (`src/server.ts`).
- `BusinessError` in `src/lib/httpError.ts` (→ `400`), extending the
  existing duck-typed error-mapping pattern.
- `tests/business.roleDefaults.test.ts` — 8 pure-logic tests, no DB
  required, cross-checking every default-mapped permission key against
  the actual migration `0001` seed data (not a hardcoded copy of it).
- `tests/integration/business-onboarding.test.ts` — 5 real-database
  scenarios: full onboarding success path (with permission-enforcement
  spot checks), **atomic rollback proof** (forces a failure partway
  through onboarding via an invalid plan code, then verifies from a
  separate connection that zero rows exist across every table the
  onboarding sequence touches), idempotent role/permission reseeding,
  RLS tenant isolation on `usage_records`/`subscriptions`, and full
  business-switching (owner succeeds, non-member is rejected, inactive
  membership is rejected).

### Fixed (documentation only, unrelated to Phase 2 code)
- `DATABASE.md`'s migration table was missing `0009_role_permissions_rls.sql`
  entirely — added. Also documents why `businesses` has no `DELETE` RLS
  policy (soft-delete via `deleted_at` is the intended pattern).

### Explicitly not implemented
- Request-level onboarding idempotency (a double-submitted create
  request produces two businesses, not one — see
  `DEVELOPMENT_STATUS.md` for why this was out of scope, not an
  oversight).
- Billing/Stripe integration, usage-limit enforcement, and a
  platform-admin dashboard — all deliberately deferred.
- No new migration — Phase 2 needed none; verified by reading the
  existing schema before writing any service code.

### Test results
See `DEVELOPMENT_STATUS.md`'s Phase 2 section for the exact, environment
-separated sandbox-vs-Mac breakdown. Summary: sandbox — 38/41 passed, 3
failed (the three `tests/integration/*.test.ts` files, all due to `pg` not
being installable in that sandbox, not a code defect; none of those
files' assertions have actually executed against a real database
anywhere). Real-database
verification on the Mac is a pending action item, not yet performed as
of this entry.

### Post-review corrections (before the Phase 2 patch was applied)
- **`POST /api/businesses` validation status code fixed:** a missing or
  blank `name` now correctly returns `400 Bad Request` via
  `BusinessError`, not `401` via `AuthError`. The underlying
  `createBusinessTx` name check was also hardened against
  non-string/`undefined` input (previously would have thrown an
  unhandled `TypeError`, surfacing as a generic `500`).
- **`tests/business.validation.test.ts` added** (4 tests) proving the
  fix above, and **`business.service.ts`'s import of
  `withTenantContext` made lazy** so this test file — and
  `createBusinessTx` in general — can be exercised without pulling in
  the real `pg` package at module-load time (no production behavior
  change; Node caches a dynamic import exactly like a static one).
- **2 tests added to `tests/httpError.test.ts`** for the
  `BusinessError` → `400` mapping specifically (`NAME_REQUIRED` and
  `INVALID_PLAN`), closing a gap where the mapping existed in code but
  had no direct test.
- **Business-switching integration test cleanup fixed:** previously
  committed a full onboarding tenant (~57 rows across 8 tables) just to
  test `selectActiveBusiness`, then only soft-deleted the business,
  leaving 56 rows behind on every run. Rewritten to construct only the
  minimal fixture the test actually needs, and to properly hard-delete
  everything that supports it (memberships, roles), leaving only one
  soft-deleted, empty business row behind — without adding a `DELETE`
  policy to `businesses` or otherwise weakening its soft-delete-only
  design.
- Test suite after the first correction round: 33 → 39 total.

### Final correction round (before the Phase 2 patch was applied)
- **Removed `pool.end()` from the business-switching integration
  test.** `pool` is the shared application pool; an individual test
  must not close it. (The existing Phase 1 `tenant-isolation.test.ts`
  still calls `pool.end()` and was left unchanged, as instructed.)
  Side effect worth knowing about: idle pooled connections now stay open
  until `pg`'s idle timeout (30s by default) instead of being closed
  immediately, so a test file that opened a connection may take up to
  that long to let its process exit. Not measured — no real DB here.
- **HTTP-level tests added** (`tests/integration/http-routes.test.ts`):
  real `node:http` server + real requests for
  `POST /api/businesses` with missing/blank/non-string name → `400`, and
  `GET /api/admin/businesses` as a non-platform-admin → `403`. Cannot
  load in the sandbox (needs `pg`); see `DEVELOPMENT_STATUS.md` for the
  exact limits of what was verified.
- **Early name validation extracted and unit-tested:** a small
  `validateBusinessName()` helper, called at the top of `createBusiness`
  (before the dynamic import of the database layer) and again inside
  `createBusinessTx`; one new test in `business.validation.test.ts`
  that fails if the early call is removed (verified by mutation).
- **Owner-permission wording corrected** in `roleDefaults.ts`,
  `business.service.ts`, `DEVELOPMENT_STATUS.md`, and this file: Owner
  receives every permission in the catalog **at the moment that
  business is onboarded**. Earlier text claiming it "never goes stale"
  was wrong — existing businesses' Owner roles do not automatically
  gain permission keys added by later migrations, and no re-sync
  mechanism exists yet.
- Test suite: 39 → 41 total (+1 validation test, +2 HTTP tests that
  cannot load in the sandbox); sandbox result 38 passed, 3 failed (all
  three `pg`-unavailable integration files).

## [Phase 1 cleanup]

### Already present in this codebase (not introduced by this entry — documented here because it was previously undocumented)
- `migrations/0009_role_permissions_rls.sql` — fixes a structural RLS gap:
  `role_permissions` had no Row-Level Security. Since the table has no
  `business_id` column of its own (tenancy is indirect, through `role_id
  → roles.business_id`), the policy uses an `EXISTS` subquery rather
  than the generic `business_id = current_business_id()` pattern used
  elsewhere.
- `tests/integration/tenant-isolation.test.ts` — a real-database
  integration test proving RLS blocks cross-tenant SELECT/UPDATE/INSERT
  on both `workers` and `role_permissions`.
- The `.env`-aware `npm test` script
  (`node --env-file=.env ... --test tests/*.test.ts
  tests/integration/*.test.ts`), and the accompanying split of
  `DATABASE_URL` (app runtime) from `DATABASE_MIGRATION_URL` (migration
  runner) in `src/config/env.ts` / `src/db/migrate.ts`.

### Added
- `tests/httpError.test.ts` — 8 tests locking in the `AuthError` → HTTP
  status mapping introduced below: every `AuthError` code, plus
  `ForbiddenError`, `HttpError` passthrough, and the generic-500/
  no-leakage fallback for unrecognized errors.

### Fixed
- **HTTP status mismatch in error handling** (`src/lib/httpError.ts`):
  `AuthError` was unconditionally mapped to `401`, even when the caller
  was validly authenticated but simply not authorized for the requested
  business. Corrected mapping:
  - `NOT_A_MEMBER` → `403`
  - `MEMBERSHIP_INACTIVE` → `403`
  - `INVALID_CREDENTIALS` → `401` (unchanged)
  - `ACCOUNT_INACTIVE` → `401` (unchanged)
  - `EMAIL_TAKEN` → `401` (unchanged)

  The safe-error-response shape (no raw errors ever reach the client) is
  unchanged; `ForbiddenError` continues to always map to `403`.

## [Phase 1] — Project Foundation & Authentication Foundation

### Added
- Corrected multi-tenant SaaS data model across 8 ordered migrations
  (`migrations/0001` – `0008`), replacing the original single-tenant
  `users` table design:
  - Global `users` identity table (email unique platform-wide)
  - `business_memberships` (many-to-many users ↔ businesses, with role)
  - `roles`, `permissions`, `role_permissions`
  - `platform_admins`, `platform_audit_logs`
  - `plans`, `subscriptions`, `subscription_events`, `usage_records`
  - `categories`, `materials`, `material_rates` (overlap-protected via
    GiST exclusion constraint), `workers` (with separate
    payable/advance balances), `customers`, `suppliers`,
    `payment_methods`
  - `purchases`/`purchase_items`, `sales`/`sale_items`, `payments`
    (with `is_advance` flag), `worker_advance_applications`,
    `expense_categories`, `expenses`
  - `stock_movements` (with `NOT NULL`, type-validated `unit_cost`),
    `current_stock` view
  - `accounts`, `journal_entries`, `journal_entry_lines` (with
    denormalized, trigger-synced `business_id`),
    `validate_journal_entry_balance()`, `seed_default_accounts()`
  - `daily_closings`, `audit_logs`, `attachments`, `notifications`
  - Row-Level Security enabled and forced on every tenant table, with
    a custom dual-clause policy for `business_memberships`
- Versioned Mermaid ERD source (`docs/ERD.mermaid`), regenerated PNG
- Dependency-free password hashing (`src/lib/password.ts`, scrypt) and
  JWT (`src/lib/jwt.ts`, HMAC-SHA256)
- RLS-aware transaction helpers (`src/db/tenantContext.ts`):
  `withTenantContext`, `withUserContext`, `withPlatformAdminContext`,
  `withGlobalContext`
- Migration runner (`src/db/migrate.ts`)
- Authentication service: signup, login, list-my-businesses,
  select-active-business (`src/modules/auth/auth.service.ts`)
- Backend permission checking (`src/middleware/authorize.ts`)
- Safe error handling, never leaking raw errors to clients
  (`src/lib/httpError.ts`)
- Minimal HTTP server wiring the above (`src/server.ts`)
- Unit test suite: 15 tests across password/JWT/authorize, all passing
- Full documentation set: `README.md`, `ARCHITECTURE.md`,
  `DATABASE.md`, `TESTING.md`, `ENVIRONMENT.md`, `API.md`,
  `DEPLOYMENT.md`

### Changed
- N/A (first implementation phase)

### Fixed
- N/A

## [Phase 0] — Architecture Analysis
- Cross-checked the Master Build Prompt, ERD, and `schema.sql` against
  each other; identified 11 inconsistencies (see `ARCHITECTURE.md`);
  proposed and got sign-off on the corrected architecture before any
  code was written.
