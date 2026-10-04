/**
 * Usage tracking foundation (Phase 2 scope — Master Build Prompt
 * section 36). Deliberately minimal: record a metric delta as SaaS
 * resources are created, and report the current period's usage
 * against the business's plan limits. No enforcement/blocking logic
 * yet (the prompt itself says "block or warn according to plan
 * behavior" is plan behavior to design later) — this phase is the
 * reliable counting foundation later phases increment and act on.
 */

import type { PoolClient } from "pg";

/** First-of-month, as a YYYY-MM-DD string — matches usage_records.period_start's
 * "point-in-time metrics use the first-of-month convention" design note
 * in migration 0002. */
export function currentPeriodStart(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/**
 * Increments (or creates) a usage counter for the current period.
 * `delta` may be negative (e.g. a worker archived) — callers are
 * responsible for passing a sensible value; this function just
 * upserts it atomically at the database level via ON CONFLICT, so
 * concurrent increments from different requests never race-overwrite
 * each other.
 */
export async function recordUsage(client: PoolClient, businessId: string, metric: string, delta: number): Promise<void> {
  const periodStart = currentPeriodStart();
  await client.query(
    `INSERT INTO usage_records (business_id, period_start, metric, value)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, period_start, metric)
     DO UPDATE SET value = usage_records.value + EXCLUDED.value, updated_at = now()`,
    [businessId, periodStart, metric, delta],
  );
}

export interface UsageSummary {
  plan: { code: string; name: string; trialDays: number };
  subscription: { status: string; trialEndsAt: string | null; currentPeriodEnd: string | null };
  periodStart: string;
  usage: Array<{ metric: string; value: number }>;
  limits: {
    maxUsers: number | null;
    maxWorkers: number | null;
    maxMonthlyTransactions: number | null;
    maxBranches: number | null;
    maxStorageMb: number | null;
  };
}

/**
 * Reads the current period's usage for `businessId` and the plan
 * limits it's measured against. Assumes `client` is already inside a
 * withTenantContext(...) transaction scoped to that business — RLS on
 * `subscriptions`/`usage_records` does the tenant-scoping, this
 * function does not add its own business_id filter as a security
 * boundary (defense-in-depth: it's included in the WHERE clauses
 * below anyway, but RLS is what actually enforces it even if that
 * were omitted by mistake).
 */
export async function getUsageSummary(client: PoolClient, businessId: string): Promise<UsageSummary> {
  const periodStart = currentPeriodStart();

  const subResult = await client.query<{
    status: string;
    trial_ends_at: string | null;
    current_period_end: string | null;
    plan_code: string;
    plan_name: string;
    trial_days: number;
    max_users: number | null;
    max_workers: number | null;
    max_monthly_transactions: number | null;
    max_branches: number | null;
    max_storage_mb: number | null;
  }>(
    `SELECT
       s.status,
       s.trial_ends_at,
       s.current_period_end,
       p.code AS plan_code,
       p.name AS plan_name,
       p.trial_days,
       p.max_users,
       p.max_workers,
       p.max_monthly_transactions,
       p.max_branches,
       p.max_storage_mb
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.business_id = $1`,
    [businessId],
  );

  const sub = subResult.rows[0];
  if (!sub) {
    throw new Error("This business has no subscription. Onboarding may not have completed correctly.");
  }

  const usageResult = await client.query<{ metric: string; value: string }>(
    `SELECT metric, value FROM usage_records WHERE business_id = $1 AND period_start = $2 ORDER BY metric`,
    [businessId, periodStart],
  );

  return {
    plan: { code: sub.plan_code, name: sub.plan_name, trialDays: sub.trial_days },
    subscription: { status: sub.status, trialEndsAt: sub.trial_ends_at, currentPeriodEnd: sub.current_period_end },
    periodStart,
    // usage_records.value is NUMERIC, which node-pg returns as a string
    // to avoid silent float precision loss — parsed back to a number
    // here since usage counts are always safe-integer-range in
    // practice and the API response is plain JSON, not a financial
    // amount subject to the NUMERIC-everywhere rule.
    usage: usageResult.rows.map((r) => ({ metric: r.metric, value: Number(r.value) })),
    limits: {
      maxUsers: sub.max_users,
      maxWorkers: sub.max_workers,
      maxMonthlyTransactions: sub.max_monthly_transactions,
      maxBranches: sub.max_branches,
      maxStorageMb: sub.max_storage_mb,
    },
  };
}
