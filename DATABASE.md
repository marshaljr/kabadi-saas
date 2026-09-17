# Database

PostgreSQL 15+ (uses `gen_random_uuid()` from `pgcrypto` and a `GiST`
exclusion constraint from `btree_gist`, both enabled in migration 0001).

## Migrations

Located in `migrations/`, applied in filename order by `src/db/migrate.ts`
(`npm run migrate`). Each file runs in its own transaction; a
`schema_migrations` table tracks what's already applied so re-running the
command is a no-op for files already recorded.

| File | Contents |
|---|---|
| `0001_saas_foundation.sql` | Global `users`, `businesses`, `roles`, `permissions`/`role_permissions`, `business_memberships`, `platform_admins`, `platform_audit_logs` |
| `0002_plans_subscriptions.sql` | `plans`, `subscriptions`, `subscription_events`, `usage_records` |
| `0003_business_core.sql` | `categories`, `materials`, `material_rates` (overlap-protected), `workers`, `customers`, `suppliers`, `payment_methods` |
| `0004_transactions.sql` | `purchases`/`purchase_items`, `sales`/`sale_items`, `payments`, `worker_advance_applications`, `expense_categories`, `expenses` |
| `0005_inventory.sql` | `stock_movements`, `current_stock` view |
| `0006_accounting.sql` | `accounts`, `journal_entries`, `journal_entry_lines`, `validate_journal_entry_balance()`, `seed_default_accounts()` |
| `0007_operations.sql` | `daily_closings`, `audit_logs`, `attachments`, `notifications` |
| `0008_rls_policies.sql` | Row-Level Security on every tenant table |

Never edit an already-applied migration file. A schema change ships as a
new numbered file (`0009_...sql`), per the project's change-management
rule — see the "ARCHITECTURE CHANGE & DATABASE MIGRATION RULE" the product
owner specified: preserve data, never destructive raw SQL against
production, always a versioned migration.

## Multi-tenancy at a glance

- `users` — global identity, not tenant-scoped
- `business_memberships` — the only path from a user to a business, with
  a role scoped to that specific business
- Every business-owned table carries `business_id` and has RLS enforcing
  it — see `ARCHITECTURE.md`'s "Tenant isolation contract" section for the
  full mechanism and the session-variable contract the app must uphold

## Financial data types

Every money and quantity column is `NUMERIC`, never `FLOAT`/`REAL` — this
was already correct in the original schema and preserved throughout.
Money columns use `NUMERIC(20,2)`; rates and quantities that need finer
precision (per-kg pricing, fractional weights) use `NUMERIC(20,4)` /
`NUMERIC(20,6)`.

## Key integrity mechanisms worth knowing about

- **`material_rates`** has a `GiST` exclusion constraint on
  `(material_id, effective_range)` — inserting a rate whose effective
  window overlaps an existing one for the same material fails at the
  database level, not just in application validation.
- **`stock_movements`** requires `unit_cost` on every row (`NOT NULL`) and
  a `CHECK` that ties `quantity_in`/`quantity_out` to the declared
  `movement_type`, so a row can't claim to be a `SALE_OUT` while actually
  carrying stock in.
- **`purchases`/`sales`** have `CHECK (due_amount = total_amount -
  paid_amount)` and `CHECK (paid_amount <= total_amount)` — a service
  can't persist an inconsistent balance even via a bug.
- **`journal_entry_lines`** requires exactly one of `debit`/`credit` to be
  positive per line; `validate_journal_entry_balance(journal_entry_id)`
  should be called by any service before considering a posting complete
  (total debits must equal total credits — section 18).
- **`business_memberships`** has a trigger
  (`enforce_membership_role_business_match`) rejecting any row whose
  `role_id` belongs to a different business than `business_id` — this
  can't be expressed as a plain `CHECK` since it needs to read another
  table.

## Local development without a real Postgres

This project was authored in a sandbox with no network access, so the
migrations above have been **syntax-validated** (balanced-parens check,
careful manual review) but never executed against a live PostgreSQL
instance. Before trusting this in any real environment:

```
npm run migrate   # against a real, empty database
```

and watch for the first-run output listing each file as `apply`. If
anything fails, the transaction wrapping that file rolls back cleanly and
the error will point at the exact statement.
