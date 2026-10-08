import { withTenantContext } from "../../db/tenantContext.js";
import { requirePermission } from "../../middleware/authorize.js";
type Args = { userId: string; businessId: string; roleId: string };
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
