import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withGlobalContext, withOnboardingContext, withPlatformAdminContext, withTenantContext, setBusinessContext } from "../../db/tenantContext.js";
import { requirePermission } from "../../middleware/authorize.js";
import { AuthError } from "../auth/auth.service.js";
import { signJwt } from "../../lib/jwt.js";
import { env } from "../../config/env.js";

export interface CreateBusinessInput {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  planCode?: string;
}

export interface BusinessSummary {
  id: string;
  name: string;
  roleId: string;
  roleName: string;
  membershipStatus: string;
}

const DEFAULT_ROLES = [
  { name: "Owner", description: "Full access to the business" },
  { name: "Manager", description: "Operational and reporting access" },
  { name: "Data Entry", description: "Data entry access" },
  { name: "Collector", description: "Collection access" },
] as const;

const ROLE_PERMISSIONS: Record<string, string[]> = {
  Owner: ["settings.business.manage", "settings.users.manage", "subscription.manage", "audit_logs.view"],
  Manager: [
    "workers.view", "workers.create", "workers.edit", "collections.create",
    "purchases.view", "purchases.create", "sales.view", "sales.create",
    "payments.view", "payments.create", "inventory.view", "materials.manage",
    "customers.manage", "suppliers.manage", "accounting.view", "reports.view",
  ],
  "Data Entry": ["workers.view", "collections.create", "purchases.view", "purchases.create", "sales.view", "sales.create", "payments.view", "payments.create"],
  Collector: ["workers.view", "collections.create"],
};

export async function createBusiness(userId: string, input: CreateBusinessInput): Promise<{
  business: { id: string; name: string };
  roleName: string;
  accessToken: string;
}> {
  const name = input.name.trim();
  if (!name) throw new AuthError("Business name is required", "INVALID_CREDENTIALS");

  return withOnboardingContext(userId, async (client) => {
    const plan = await client.query<{ id: string; code: string; trial_days: number }>(
      "SELECT id, code, trial_days FROM plans WHERE code = $1 AND is_active = TRUE",
      [(input.planCode ?? "FREE").trim().toUpperCase()],
    );
    const selectedPlan = plan.rows[0];
    if (!selectedPlan) throw new AuthError("The selected plan is not available", "INVALID_CREDENTIALS");

    const businessId = randomUUID();
    await client.query(
      `INSERT INTO businesses (id, name, address, phone, email)
       VALUES ($1, $2, $3, $4, $5)`,
      [businessId, name, input.address?.trim() || null, input.phone?.trim() || null, input.email?.trim().toLowerCase() || null],
    );
    await setBusinessContext(client, businessId);

    const permissions = await client.query<{ id: string; key: string }>("SELECT id, key FROM permissions");
    const permissionIds = new Map(permissions.rows.map((row) => [row.key, row.id]));
    const roleIds = new Map<string, string>();
    for (const role of DEFAULT_ROLES) {
      const roleId = randomUUID();
      roleIds.set(role.name, roleId);
      await client.query(
        `INSERT INTO roles (id, business_id, name, description, is_system_role)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [roleId, businessId, role.name, role.description],
      );
      for (const permissionKey of ROLE_PERMISSIONS[role.name] ?? []) {
        const permissionId = permissionIds.get(permissionKey);
        if (!permissionId) throw new Error(`Missing permission catalog entry: ${permissionKey}`);
        await client.query(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)",
          [roleId, permissionId],
        );
      }
      if (role.name === "Owner") {
        for (const permission of permissions.rows) {
          await client.query(
            `INSERT INTO role_permissions (role_id, permission_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [roleId, permission.id],
          );
        }
      }
    }

    const ownerRoleId = roleIds.get("Owner");
    if (!ownerRoleId) throw new Error("Owner role was not seeded");
    await client.query(
      `INSERT INTO business_memberships (user_id, business_id, role_id)
       VALUES ($1, $2, $3)`,
      [userId, businessId, ownerRoleId],
    );
    await client.query(
      `INSERT INTO subscriptions (business_id, plan_id, status, trial_ends_at)
       VALUES ($1, $2, 'TRIALING', now() + ($3::integer * interval '1 day'))`,
      [businessId, selectedPlan.id, selectedPlan.trial_days],
    );
    await client.query(
      `INSERT INTO subscription_events (subscription_id, event_type, payload)
       SELECT id, 'CREATED', jsonb_build_object('planCode', $2::text)
       FROM subscriptions WHERE business_id = $1`,
      [businessId, selectedPlan.code],
    );
    await client.query("SELECT seed_default_accounts($1)", [businessId]);
    await client.query(
      `INSERT INTO usage_records (business_id, period_start, metric, value)
       VALUES ($1, date_trunc('month', current_date)::date, 'users', 1)
       ON CONFLICT (business_id, period_start, metric)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [businessId],
    );

    const row = { id: businessId, name };
    const accessToken = await issueBusinessToken(client, userId, businessId, ownerRoleId, "Owner");
    return { business: row, roleName: "Owner", accessToken };
  });
}

async function issueBusinessToken(
  client: PoolClient,
  userId: string,
  businessId: string,
  roleId: string,
  roleName: string,
): Promise<string> {
  await client.query("UPDATE users SET last_active_business_id = $1 WHERE id = $2", [businessId, userId]);
  return signJwt({ sub: userId, businessId, roleId, roleName }, env.jwtSecret, env.jwtAccessTokenTtlSeconds);
}

export async function getUsage(userId: string, businessId: string, roleId: string) {
  return withTenantContext(userId, businessId, async (client) => {
    await requirePermission(client, roleId, "reports.view");
    const result = await client.query(
      `SELECT ur.metric, ur.value, p.max_users, p.max_workers, p.max_monthly_transactions, p.max_branches, p.max_storage_mb
       FROM usage_records ur
       JOIN subscriptions s ON s.business_id = ur.business_id
       JOIN plans p ON p.id = s.plan_id
       WHERE ur.business_id = $1 AND ur.period_start = date_trunc('month', current_date)::date
       ORDER BY ur.metric`,
      [businessId],
    );
    return result.rows;
  });
}

export async function listPlans() {
  return withGlobalContext(async (client) => {
    const result = await client.query(
      `SELECT code, name, price_monthly AS "priceMonthly", currency_code AS "currencyCode",
              trial_days AS "trialDays", max_users AS "maxUsers", max_workers AS "maxWorkers",
              max_monthly_transactions AS "maxMonthlyTransactions", max_branches AS "maxBranches",
              max_storage_mb AS "maxStorageMb", allow_exports AS "allowExports",
              allow_advanced_reports AS "allowAdvancedReports", allow_advanced_accounting AS "allowAdvancedAccounting",
              allow_api_access AS "allowApiAccess"
       FROM plans WHERE is_active = TRUE ORDER BY sort_order`,
    );
    return result.rows;
  });
}

export async function listPlatformBusinesses(userId: string) {
  return withPlatformAdminContext(userId, async (client) => {
    const admin = await client.query("SELECT 1 FROM platform_admins WHERE user_id = $1", [userId]);
    if (admin.rowCount !== 1) throw new AuthError("Platform administrator access is required", "NOT_A_MEMBER");
    const result = await client.query(
      `SELECT b.id, b.name, b.created_at AS "createdAt", s.status AS "subscriptionStatus",
              p.code AS "planCode"
       FROM businesses b
       LEFT JOIN subscriptions s ON s.business_id = b.id
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE b.deleted_at IS NULL
       ORDER BY b.created_at DESC`,
    );
    return result.rows;
  });
}
