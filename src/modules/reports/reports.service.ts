import { withTenantContext } from "../../db/tenantContext.js";
import { requirePermission } from "../../middleware/authorize.js";
import { HttpError } from "../../lib/httpError.js";

type Args = { userId: string; businessId: string; roleId: string };
export type ReportDateRange = { from?: string; to?: string };

function validateDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${field} must use YYYY-MM-DD format`, "INVALID_DATE");
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${field} is not a valid calendar date`, "INVALID_DATE");
  }
}

export function validateDateRange(range: ReportDateRange): ReportDateRange {
  if (range.from) validateDate(range.from, "from");
  if (range.to) validateDate(range.to, "to");
  if (range.from && range.to && range.from > range.to) {
    throw new HttpError(400, "from must be on or before to", "INVALID_DATE_RANGE");
  }
  return range;
}

function datePredicate(column: string, range: ReportDateRange, startIndex: number): { sql: string; values: string[] } {
  const clauses: string[] = [];
  const values: string[] = [];
  if (range.from) {
    clauses.push(`${column} >= $${startIndex + values.length}::date`);
    values.push(range.from);
  }
  if (range.to) {
    clauses.push(`${column} <= $${startIndex + values.length}::date`);
    values.push(range.to);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", values };
}

export async function getProfitAndLoss(args: Args, requestedRange: ReportDateRange = {}) {
  const range = validateDateRange(requestedRange);
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "reports.view");
    const date = datePredicate("je.date", range, 2);
    const result = await client.query<{
      sales_revenue: string;
      cogs: string;
      operating_expenses: string;
      other_income: string;
    }>(
      `SELECT
         COALESCE(SUM(jel.credit) FILTER (WHERE a.type = 'REVENUE' AND je.reference_type = 'SALE'), 0)::text AS sales_revenue,
         COALESCE(SUM(jel.debit) FILTER (WHERE a.type = 'COGS'), 0)::text AS cogs,
         COALESCE(SUM(jel.debit) FILTER (WHERE a.type = 'EXPENSE'), 0)::text AS operating_expenses,
         COALESCE(SUM(jel.credit) FILTER (WHERE a.type = 'REVENUE' AND je.reference_type IS DISTINCT FROM 'SALE'), 0)::text AS other_income
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       JOIN accounts a ON a.id = jel.account_id
       WHERE je.business_id = $1 AND je.status = 'POSTED'::journal_status${date.sql}`,
      [args.businessId, ...date.values],
    );
    const breakdown = await client.query(
      `SELECT a.id AS "accountId", a.account_code AS "accountCode", a.name,
              a.type, COALESCE(SUM(jel.debit), 0)::text AS debit,
              COALESCE(SUM(jel.credit), 0)::text AS credit
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       JOIN accounts a ON a.id = jel.account_id
       WHERE je.business_id = $1 AND je.status = 'POSTED'::journal_status
         AND a.type IN ('REVENUE', 'COGS', 'EXPENSE')${date.sql}
       GROUP BY a.id, a.account_code, a.name, a.type
       ORDER BY a.account_code`,
      [args.businessId, ...date.values],
    );
    const totals = result.rows[0]!;
    const grossProfit = (Number(totals.sales_revenue) - Number(totals.cogs)).toFixed(2);
    const netProfit = (Number(grossProfit) - Number(totals.operating_expenses)).toFixed(2);
    return {
      dateRange: { from: range.from ?? null, to: range.to ?? null },
      salesRevenue: Number(totals.sales_revenue).toFixed(2),
      cogs: Number(totals.cogs).toFixed(2),
      grossProfit,
      operatingExpenses: Number(totals.operating_expenses).toFixed(2),
      otherIncome: Number(totals.other_income).toFixed(2),
      netProfit,
      breakdown: breakdown.rows,
    };
  });
}

export async function getDashboard(args: Args, requestedRange: ReportDateRange = {}) {
  const range = validateDateRange(requestedRange);
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "reports.view");
    const purchaseDate = datePredicate("p.date", range, 2);
    const saleDate = datePredicate("s.date", range, 2);
    const journalDate = datePredicate("je.date", range, 2);
    const [purchases, sales, financials, stock, workers] = await Promise.all([
      client.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0)::text AS total
         FROM purchases p WHERE p.business_id = $1${purchaseDate.sql}`,
        [args.businessId, ...purchaseDate.values],
      ),
      client.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0)::text AS total
         FROM sales s WHERE s.business_id = $1${saleDate.sql}`,
        [args.businessId, ...saleDate.values],
      ),
      client.query<{
        revenue: string; cogs: string; expenses: string;
      }>(
        `SELECT
           COALESCE(SUM(jel.credit) FILTER (WHERE a.type = 'REVENUE' AND je.reference_type = 'SALE'), 0)::text AS revenue,
           COALESCE(SUM(jel.debit) FILTER (WHERE a.type = 'COGS'), 0)::text AS cogs,
           COALESCE(SUM(jel.debit) FILTER (WHERE a.type = 'EXPENSE'), 0)::text AS expenses
         FROM journal_entries je
         JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
         JOIN accounts a ON a.id = jel.account_id
         WHERE je.business_id = $1 AND je.status = 'POSTED'::journal_status${journalDate.sql}`,
        [args.businessId, ...journalDate.values],
      ),
      client.query(
        `SELECT COALESCE(SUM(cs.quantity_on_hand), 0)::text AS quantity,
                COALESCE(SUM(cs.quantity_on_hand * cs.average_cost), 0)::text AS value,
                COUNT(*) FILTER (WHERE cs.quantity_on_hand < m.minimum_stock)::int AS low_stock
         FROM (
           SELECT material_id, business_id, SUM(quantity_in) - SUM(quantity_out) AS quantity_on_hand,
                  COALESCE(SUM(quantity_in * unit_cost) / NULLIF(SUM(quantity_in), 0), 0) AS average_cost
           FROM stock_movements
           WHERE business_id = $1
           GROUP BY material_id, business_id
         ) cs JOIN materials m ON m.id = cs.material_id
         WHERE cs.business_id = $1`,
        [args.businessId],
      ),
      client.query(
        "SELECT COUNT(*)::int AS count FROM workers WHERE business_id = $1 AND deleted_at IS NULL",
        [args.businessId],
      ),
    ]);
    const financial = financials.rows[0]!;
    const grossProfit = (Number(financial.revenue) - Number(financial.cogs)).toFixed(2);
    return {
      dateRange: { from: range.from ?? null, to: range.to ?? null },
      purchases: purchases.rows[0],
      sales: { ...sales.rows[0], revenue: sales.rows[0].total },
      financial: {
        revenue: Number(financial.revenue).toFixed(2),
        cogs: Number(financial.cogs).toFixed(2),
        grossProfit,
        operatingExpenses: Number(financial.expenses).toFixed(2),
        netProfit: (Number(grossProfit) - Number(financial.expenses)).toFixed(2),
      },
      inventory: stock.rows[0],
      workers: workers.rows[0],
    };
  });
}
