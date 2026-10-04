/**
 * Default system roles and their starting permission grants.
 *
 * Master Build Prompt section 32 defines four roles (Owner, Manager,
 * Data Entry, Collector) with a rough description of scope:
 *   Owner:      full access
 *   Manager:    operations + reports according to permissions
 *   Data Entry: create/edit permitted operational transactions,
 *               limited financial controls
 *   Collector:  restricted access if implemented
 *
 * These are STARTING GRANTS only, seeded once at business creation.
 * A business owner can rearrange what each role can do afterward
 * (Settings → Users & Roles, a later phase's UI) by editing
 * role_permissions directly — this module is not consulted again
 * after onboarding, and nothing re-reads it. Getting the exact
 * starting set slightly wrong is low-stakes and easy to correct
 * later; getting the *mechanism* wrong (hardcoding role-name checks
 * instead of real permission rows) would not be.
 *
 * OWNER is intentionally not listed here as a fixed key array: at the
 * moment a NEW business is onboarded, its Owner role receives every
 * permission that exists in the `permissions` catalog AT THAT TIME
 * (see business.service.ts's assignDefaultPermissions). This is a
 * one-time grant, not a live subscription — it means a newly-created
 * business's Owner role never misses out on whatever permissions
 * happen to exist on the day it's created, without this file needing
 * to be updated every time a permission key is added elsewhere.
 *
 * It does NOT mean existing businesses' Owner roles automatically
 * receive permission keys added by later migrations after they were
 * created — role_permissions is a snapshot taken at onboarding time,
 * with no ongoing sync mechanism. A business created before some new
 * permission key existed will not have it granted to Owner until some
 * future re-seed/repair operation is built (not part of Phase 2).
 */

export const SYSTEM_ROLE_NAMES = ["Owner", "Manager", "Data Entry", "Collector"] as const;
export type SystemRoleName = (typeof SYSTEM_ROLE_NAMES)[number];

/**
 * Permission keys for the three non-Owner roles. Owner is handled
 * specially (see module doc comment above) and is not listed here.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Exclude<SystemRoleName, "Owner">, readonly string[]> = {
  Manager: [
    "workers.view",
    "workers.create",
    "workers.edit",
    "workers.archive",
    "collections.create",
    "purchases.view",
    "purchases.create",
    "purchases.cancel",
    "sales.view",
    "sales.create",
    "sales.cancel",
    "payments.view",
    "payments.create",
    "payments.reverse",
    "expenses.view",
    "expenses.create",
    "inventory.view",
    "inventory.adjust",
    "materials.manage",
    "customers.manage",
    "suppliers.manage",
    "accounting.view",
    "reports.view",
    "reports.export",
    // Deliberately excluded: accounting.manage, settings.business.manage,
    // settings.users.manage, subscription.manage, audit_logs.view —
    // these are business-critical/administrative and stay Owner-only
    // by default.
  ],
  "Data Entry": [
    "workers.view",
    "collections.create",
    "purchases.view",
    "purchases.create",
    "sales.view",
    "sales.create",
    "payments.view",
    "payments.create",
    "expenses.view",
    "expenses.create",
    "inventory.view",
    // Deliberately excluded: anything with .cancel/.reverse/.archive
    // (reversals are a bigger deal than initial entry), materials/
    // customers/suppliers management, and all Manager-and-above keys.
  ],
  Collector: [
    "collections.create",
    "workers.view",
    // Intentionally minimal — "restricted access if implemented" per
    // the Master Build Prompt. A Collector's job is bringing in
    // material, not managing the business.
  ],
} as const;
