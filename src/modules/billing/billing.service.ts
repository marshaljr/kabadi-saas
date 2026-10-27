import type { PoolClient } from "pg";
import { withTenantContext } from "../../db/tenantContext.js";
import { requirePermission } from "../../middleware/authorize.js";
import { HttpError } from "../../lib/httpError.js";
type Args = { userId: string; businessId: string; roleId: string };

type QuotaMetric = "workers" | "transactions";

export async function reserveQuota(client: PoolClient, businessId: string, metric: QuotaMetric): Promise<void> {
  const plan = await client.query<{
    max_workers: number | null;
    max_monthly_transactions: number | null;
  }>(
    `SELECT p.max_workers, p.max_monthly_transactions
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.business_id = $1
     FOR UPDATE OF s`,
    [businessId],
  );
  if (plan.rowCount !== 1) {
    throw new HttpError(403, "This business does not have an active subscription", "SUBSCRIPTION_REQUIRED");
  }
  const limit = metric === "workers" ? plan.rows[0]!.max_workers : plan.rows[0]!.max_monthly_transactions;
  if (limit === null) return;

  const period = "date_trunc('month', current_date)::date";
  const usage = await client.query<{ value: string }>(
    `INSERT INTO usage_records (business_id, period_start, metric, value)
     VALUES ($1, ${period}, $2, 0)
     ON CONFLICT (business_id, period_start, metric)
     DO UPDATE SET updated_at = usage_records.updated_at
     RETURNING value::text`,
    [businessId, metric],
  );
  const current = Number(usage.rows[0]!.value);
  const actual = metric === "workers"
    ? Number((await client.query(
      "SELECT COUNT(*)::int AS count FROM workers WHERE business_id = $1 AND deleted_at IS NULL",
      [businessId],
    )).rows[0]!.count)
    : current;
  if (actual >= limit) {
    throw new HttpError(409, `${metric === "workers" ? "Worker" : "Monthly transaction"} limit reached (${limit})`, "PLAN_LIMIT_EXCEEDED");
  }
}

export async function recordQuotaUsage(client: PoolClient, businessId: string, metric: QuotaMetric): Promise<void> {
  await client.query(
    `INSERT INTO usage_records (business_id, period_start, metric, value)
     VALUES ($1, date_trunc('month', current_date)::date, $2, 1)
     ON CONFLICT (business_id, period_start, metric)
     DO UPDATE SET value = usage_records.value + 1, updated_at = now()`,
    [businessId, metric],
  );
}
export async function getSubscription(args: Args) {
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "business.manage");
    const result = await client.query(
      `SELECT s.*, p.code, p.name, p.max_users, p.max_workers, p.max_monthly_transactions,
              p.allow_advanced_reports, p.allow_advanced_accounting
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.business_id = $1`, [args.businessId],
    );
    return result.rows[0] ?? null;
  });
}
