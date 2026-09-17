# Changelog

All notable changes to this project are recorded here, newest first.

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
