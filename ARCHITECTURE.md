# Architecture

## Phase 0 analysis (summary)

The original three inputs — the Master Build Prompt, the ERD, and
`schema.sql` — were not in sync. The prompt fully specified SaaS
multi-tenancy (a user belonging to multiple businesses, platform admin,
plans/subscriptions, permission-based authorization). The ERD partially
reflected this. `schema.sql` did not: it locked every user to exactly one
business via a `business_id`/`role_id` pair directly on `users`, which
cannot express "Marshal is Owner of Business A and Manager of Business B."

Full corrected schema is in `migrations/0001-0008`, and the corrected ERD
source is `docs/ERD.mermaid`. The corrections applied:

1. **`users` became a global identity table.** One row per human, `email`
   unique platform-wide. No `business_id`/`role_id` columns on `users`.
2. **`business_memberships`** is now the only path from a user to a
   business — `(user_id, business_id) → role_id`, with a trigger ensuring
   the role actually belongs to that business.
3. **`platform_admins`** is a separate table, not a role. It's checked
   explicitly by platform-admin-only routes and is never touched by normal
   business role management.
4. **`permissions` / `role_permissions`** replace hardcoded role-name
   checks. Authorization is "does this role have permission X", checked in
   `src/middleware/authorize.ts` against the database, not
   `if (role === 'manager')` scattered through the code.
5. **`plans` / `subscriptions` / `subscription_events` / `usage_records`**
   implement the SaaS billing/limits architecture (section 33-36 of the
   Master Build Prompt), with `subscription_events.provider_event_id`
   unique so webhook replays are naturally idempotent.
6. **`platform_audit_logs`** is distinct from the tenant-scoped
   `audit_logs` (migration 0007) — one covers platform-admin actions across
   tenants, the other covers in-business activity.
7. **Worker advance tracking**: `payments.is_advance` plus a new
   `worker_advance_applications` table records exactly how much of which
   advance was applied against which later purchase, so the worker ledger
   can show "Advance issued → Advance applied → Remaining payable" as
   distinct rows instead of an implicit balance.
8. **`material_rates` overlap protection**: a `GiST` exclusion constraint
   on `(material_id, effective_range)` makes it structurally impossible to
   have two ambiguous rate periods for the same material.
9. **`stock_movements.unit_cost` is `NOT NULL`**, with a `CHECK` tying
   movement direction (`quantity_in` vs `quantity_out`) to `movement_type`,
   since this is exactly where COGS is computed from (sections 17/19).
10. **`journal_entry_lines.business_id`** is denormalized (kept correct by
    trigger) so RLS and per-business account queries don't need a join.
11. **Row-Level Security** (migration 0008) is a second, independent
    tenant-isolation layer beneath the application-layer scoping — see
    "Tenant isolation contract" below.

### A naming note

"Worker" (a Kabadi collector, tracked in `workers`) and "user with role
Collector" (a login account, tracked in `users`/`business_memberships`)
are two different concepts that happen to share a name. The Stitch UI
screens confirm this — "Ram Kumar" is a collector being paid, not a system
login. Keep these separate; do not merge the tables.

## Tenant isolation contract

Every tenant-scoped table has RLS **enabled and forced** (migration 0008),
with a policy checking `business_id = current_business_id()`, where
`current_business_id()` reads the Postgres session variable
`app.current_business_id`.

The application sets this per-transaction via
`src/db/tenantContext.ts::withTenantContext(userId, businessId, fn)`,
using `SELECT set_config('app.current_business_id', $1, true)` (not
`SET LOCAL app.x = $1` — Postgres does not accept bind parameters in `SET`
statements; `set_config()` does, and is what makes this injection-safe).

**This is the only sanctioned way service code should query the database
for tenant-scoped work.** Calling `pool.query(...)` directly bypasses both
the transaction boundary (needed for atomic multi-table writes, section
55) and the RLS context (needed for tenant isolation, sections 30/73).

`businessId` here must always come from a verified, business-scoped JWT
(`auth.service.ts::selectActiveBusiness`), never from a request body or
query parameter — the whole point of RLS-as-defense-in-depth is that even
if a service function forgets a `WHERE business_id = ...` clause, or a
request handler is tricked into passing the wrong ID from user input, the
database itself still refuses the cross-tenant row.

**Critical operational requirement:** the connection string used by
`src/db/pool.ts` (request-serving connections) must authenticate as a
non-superuser, non-table-owner role. RLS is bypassed entirely for
superusers and table owners in Postgres. `src/db/migrate.ts` is the one
place that's expected to connect with elevated (DDL) privileges.

### The `business_memberships` chicken-and-egg problem

Every other tenant table uses one simple policy: visible only when
`business_id = current_business_id()`. `business_memberships` can't use
only that rule, because the very first thing a client needs after login is
"which businesses can I even select?" — and at that point no business
context has been chosen yet.

The policy for this one table also allows `user_id = current_user_id()`
(migration 0008), so a user can always see their *own* membership rows,
in any business, before selecting one. The `WITH CHECK` clause
deliberately does not include this exception — a user can read their own
membership but cannot write to it; only an existing member with
`settings.users.manage` (checked at the application layer while that
business is the active context) or a platform admin can grant/change a
membership.

## Backend authorization

Section 32 of the Master Build Prompt is explicit that role checks must
not live only in the frontend. `src/middleware/authorize.ts::requirePermission`
queries `role_permissions` directly by permission key
(e.g. `"purchases.create"`) — never a role name compared with `===`. This
means an owner can customize what a role can do from Settings without a
code deployment, and the check is enforced identically regardless of what
the client sends.

## What Phase 1 deliberately does not include

- Business creation / onboarding (seeding roles, default accounts,
  trial subscription) — Phase 2 scope, though the schema already supports
  it (`seed_default_accounts()`, `plans`/`subscriptions` tables exist).
- Materials, workers, purchases, sales, inventory, accounting *services*
  — Phases 3-7. Only the schema for these exists so far.
- A real HTTP framework (Express/Fastify) — see README for why, and how
  to swap it in once `npm install` is possible.
