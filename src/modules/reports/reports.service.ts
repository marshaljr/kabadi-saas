import { withTenantContext } from "../../db/tenantContext.js";
import { requirePermission } from "../../middleware/authorize.js";

type Args = { userId: string; businessId: string; roleId: string };
export async function getDashboard(args: Args) {
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "reports.view");
    const [purchases, sales, stock, workers] = await Promise.all([
      client.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0) AS total FROM purchases WHERE business_id = $1", [args.businessId]),
      client.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0) AS total FROM sales WHERE business_id = $1", [args.businessId]),
      client.query("SELECT COUNT(*) FILTER (WHERE quantity_on_hand < minimum_stock)::int AS low_stock FROM current_stock WHERE business_id = $1", [args.businessId]),
      client.query("SELECT COUNT(*)::int AS count FROM workers WHERE business_id = $1 AND deleted_at IS NULL", [args.businessId]),
    ]);
    return { purchases: purchases.rows[0], sales: sales.rows[0], inventory: stock.rows[0], workers: workers.rows[0] };
  });
}
