/**
 * Business onboarding (Phase 2 scope).
 *
 * Implements the lifecycle from the Phase 2 brief:
 *   create business → default roles → default permissions →
 *   owner membership → default accounting setup → trial
 *   subscription → return summary
 *
 * All of it happens inside ONE database transaction (via
 * withTenantContext), so a failure at any step — bad plan code,
 * constraint violation, anything — rolls back everything: there is
 * never a partially-created tenant (Master Build Prompt section 12).
 *
 * DESIGN NOTE — why this is split into createBusinessTx + createBusiness:
 * withTenantContext manages its own transaction (BEGIN...COMMIT/
 * ROLLBACK) and needs the new business's id set as the RLS context
 * *before* the business row itself is inserted (see the businesses
 * table's INSERT policy note in migrations/0008_rls_policies.sql —
 * INSERT is application-gated, not RLS-gated, which is exactly what
 * makes this "insert the id you're about to become" pattern safe).
 * createBusinessTx contains the actual step sequence and takes an
 * already-scoped `client`; createBusiness is the thin public wrapper
 * that generates the id and opens the transaction. This split also
 * lets tests exercise the real step sequence inside their own
 * transaction (see tests/integration/business-onboarding.test.ts)
 * without permanently writing test businesses into the database.
 */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { recordUsage } from "../usage/usage.service.js";
import { DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLE_NAMES, type SystemRoleName } from "./roleDefaults.js";

export class BusinessError extends Error {
  constructor(
    message: string,
    public readonly code: "NAME_REQUIRED" | "INVALID_PLAN",
  ) {
    super(message);
    this.name = "BusinessError";
  }
}

/**
 * Validates and normalizes a business name, throwing BusinessError
 * (NAME_REQUIRED) for anything missing/blank/non-string. Extracted so
 * it can run BEFORE createBusiness's dynamic import of
 * db/tenantContext.js (see createBusiness below) — a request with an
 * invalid name is rejected without ever touching the database or
 * attempting to load the `pg`-dependent module graph, which is also
 * what makes it possible to test this specific validation path (see
 * tests/business.validation.test.ts and the HTTP-level test in
 * tests/integration/http-routes.test.ts) independently of whether a
 * database is reachable at all.
 */
function validateBusinessName(rawName: unknown): string {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) {
    throw new BusinessError("Business name is required", "NAME_REQUIRED");
  }
  return name;
}

export interface CreateBusinessInput {
  name: string;
  currencyCode?: string;
  languageCode?: string;
  timezone?: string;
  /** Defaults to 'FREE'. Must reference an active row in `plans`. */
  planCode?: string;
}

export interface CreateBusinessResult {
  business: {
    id: string;
    name: string;
    currencyCode: string;
    languageCode: string;
    timezone: string;
  };
  membership: {
    roleId: string;
    roleName: "Owner";
  };
  subscription: {
    id: string;
    planCode: string;
    status: string;
    trialEndsAt: string;
  };
}

/**
 * Seeds the four system roles for a business, idempotently: safe to
 * call more than once for the same business (e.g. a future "repair
 * defaults" operation, or a retried onboarding step) without creating
 * duplicate role rows, because it relies on roles' existing
 * UNIQUE (business_id, name) constraint via ON CONFLICT DO NOTHING,
 * then re-reads canonical ids regardless of whether this call
 * inserted them or they already existed. Exported so this idempotency
 * can be tested directly (see
 * tests/integration/business-onboarding.test.ts) without going
 * through the full createBusiness transaction.
 */
export async function seedDefaultRoles(client: PoolClient, businessId: string): Promise<Map<SystemRoleName, string>> {
  await client.query(
    `INSERT INTO roles (business_id, name, is_system_role)
     SELECT $1, name, TRUE FROM unnest($2::text[]) AS name
     ON CONFLICT (business_id, name) DO NOTHING`,
    [businessId, SYSTEM_ROLE_NAMES],
  );

  const result = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM roles WHERE business_id = $1 AND name = ANY($2)`,
    [businessId, SYSTEM_ROLE_NAMES],
  );

  const map = new Map<SystemRoleName, string>();
  for (const row of result.rows) {
    map.set(row.name as SystemRoleName, row.id);
  }
  return map;
}

/**
 * Grants each seeded role its starting permission set (roleDefaults.ts).
 * Owner receives every permission that exists in the catalog AT THE
 * MOMENT THIS FUNCTION RUNS (i.e. once, when this specific business is
 * onboarded) — not a fixed hardcoded list, but also not a live
 * subscription: it does not retroactively grant permissions added by
 * later migrations to businesses that were already onboarded before
 * those permissions existed (see the correction note in
 * roleDefaults.ts's module doc comment). Idempotent via
 * ON CONFLICT DO NOTHING on role_permissions' (role_id, permission_id)
 * primary key. Exported for the same direct-testability reason as
 * seedDefaultRoles above.
 */
export async function assignDefaultPermissions(client: PoolClient, roleIdsByName: Map<SystemRoleName, string>): Promise<void> {
  const ownerRoleId = roleIdsByName.get("Owner");
  if (!ownerRoleId) {
    // seedDefaultRoles always creates all four system roles together;
    // reaching this means it was skipped or its result was tampered
    // with by a caller, not a normal runtime condition.
    throw new Error("Owner role was not found after seeding default roles");
  }

  await client.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT $1, id FROM permissions
     ON CONFLICT DO NOTHING`,
    [ownerRoleId],
  );

  for (const [roleName, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS) as Array<
    [Exclude<SystemRoleName, "Owner">, readonly string[]]
  >) {
    if (keys.length === 0) continue;
    const roleId = roleIdsByName.get(roleName);
    if (!roleId) continue; // defensive; seedDefaultRoles always creates all four

    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, id FROM permissions WHERE key = ANY($2)
       ON CONFLICT DO NOTHING`,
      [roleId, keys],
    );
  }
}

/**
 * The actual onboarding step sequence. `client` must already be
 * inside a transaction whose RLS context (`app.current_business_id`)
 * is set to `businessId` — see createBusiness below for the only
 * sanctioned way to obtain that. Does not commit or roll back
 * anything itself; that's the caller's responsibility.
 */
export async function createBusinessTx(
  client: PoolClient,
  userId: string,
  businessId: string,
  input: CreateBusinessInput,
): Promise<CreateBusinessResult> {
  const name = validateBusinessName(input.name);

  // Defaults duplicated here intentionally match the Master Build
  // Prompt's stated product defaults (section 4: "Default currency:
  // NPR... Default timezone: Asia/Kathmandu") and the DB column
  // defaults in migrations/0001_saas_foundation.sql — written
  // explicitly rather than omitted-and-left-to-the-column-default so
  // the values are visible in one place for anyone reading this
  // function, at the cost of that small duplication.
  const businessResult = await client.query<{
    id: string;
    name: string;
    currency_code: string;
    language_code: string;
    timezone: string;
  }>(
    `INSERT INTO businesses (id, name, currency_code, language_code, timezone)
     VALUES ($1, $2, COALESCE($3, 'NPR'), COALESCE($4, 'en'), COALESCE($5, 'Asia/Kathmandu'))
     RETURNING id, name, currency_code, language_code, timezone`,
    [businessId, name, input.currencyCode ?? null, input.languageCode ?? null, input.timezone ?? null],
  );
  const business = businessResult.rows[0];
  if (!business) {
    throw new Error("Failed to create business");
  }

  const roleIdsByName = await seedDefaultRoles(client, businessId);
  await assignDefaultPermissions(client, roleIdsByName);

  const ownerRoleId = roleIdsByName.get("Owner");
  if (!ownerRoleId) {
    throw new Error("Owner role was not found after seeding default roles");
  }

  await client.query(
    `INSERT INTO business_memberships (user_id, business_id, role_id, status)
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [userId, businessId, ownerRoleId],
  );

  await client.query(`UPDATE users SET last_active_business_id = $1 WHERE id = $2`, [businessId, userId]);

  // Existing DB function (migrations/0006_accounting.sql) — not
  // reimplemented here. Already idempotent via its own
  // ON CONFLICT (business_id, account_code) DO NOTHING.
  await client.query(`SELECT seed_default_accounts($1)`, [businessId]);

  const planCode = input.planCode ?? "FREE";
  const planResult = await client.query<{ id: string; trial_days: number }>(
    `SELECT id, trial_days FROM plans WHERE code = $1 AND is_active = TRUE`,
    [planCode],
  );
  const plan = planResult.rows[0];
  if (!plan) {
    throw new BusinessError(`Unknown or inactive plan code: ${planCode}`, "INVALID_PLAN");
  }

  const subscriptionResult = await client.query<{ id: string; status: string; trial_ends_at: string }>(
    `INSERT INTO subscriptions (business_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
     VALUES (
       $1,
       $2,
       'TRIALING',
       now() + ($3 || ' days')::interval,
       now(),
       now() + ($3 || ' days')::interval
     )
     RETURNING id, status, trial_ends_at`,
    [businessId, plan.id, plan.trial_days],
  );
  const subscription = subscriptionResult.rows[0];
  if (!subscription) {
    throw new Error("Failed to create subscription");
  }

  await client.query(
    `INSERT INTO subscription_events (subscription_id, event_type, payload)
     VALUES ($1, 'TRIAL_STARTED', $2::jsonb)`,
    [subscription.id, JSON.stringify({ planCode, trialDays: plan.trial_days })],
  );

  await recordUsage(client, businessId, "users", 1);

  await client.query(`UPDATE businesses SET onboarding_completed_at = now() WHERE id = $1`, [businessId]);

  return {
    business: {
      id: business.id,
      name: business.name,
      currencyCode: business.currency_code,
      languageCode: business.language_code,
      timezone: business.timezone,
    },
    membership: { roleId: ownerRoleId, roleName: "Owner" },
    subscription: { id: subscription.id, planCode, status: subscription.status, trialEndsAt: subscription.trial_ends_at },
  };
}

/**
 * Public entry point: creates a new business owned by `userId`.
 * Generates the business id itself (same pattern as
 * auth.service.ts's signup generating a user id) and runs the whole
 * onboarding sequence in one committed-or-rolled-back-together
 * transaction via withTenantContext.
 *
 * `userId` must come from a verified identity token (see
 * verifyIdentityToken in auth.service.ts) — never from a request
 * body (section 30).
 *
 * withTenantContext is imported lazily (dynamic import) rather than
 * at the top of this file so that createBusinessTx — and its input
 * validation in particular — can be imported and exercised in
 * isolation (see tests/business.validation.test.ts) without pulling
 * in db/tenantContext.js's transitive dependency on the real `pg`
 * package at module-load time. This has no behavioral effect in
 * production: Node caches a dynamic import exactly like a static one,
 * so it is not re-resolved or re-executed on subsequent calls.
 */
export async function createBusiness(userId: string, input: CreateBusinessInput): Promise<CreateBusinessResult> {
  // Validated here too (not just inside createBusinessTx) so that an
  // invalid name is rejected before ever attempting the dynamic
  // import below — see validateBusinessName's doc comment for why
  // that ordering matters.
  validateBusinessName(input.name);

  const { withTenantContext } = await import("../../db/tenantContext.js");
  const businessId = randomUUID();
  return withTenantContext(userId, businessId, (client) => createBusinessTx(client, userId, businessId, input));
}
