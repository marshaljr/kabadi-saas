import { randomUUID } from "node:crypto";
import { withTenantContext } from "../../db/tenantContext.js";
import { requirePermission } from "../../middleware/authorize.js";

type Args = { userId: string; businessId: string; roleId: string };

export async function createExpense(args: Args, input: { expenseNo: string; expenseCategoryId: string; amount: number; description: string }) {
  if (input.amount <= 0) throw new Error("Expense amount must be positive");
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "accounting.manage");
    const result = await client.query(
      `INSERT INTO expenses (id, business_id, expense_no, expense_category_id, amount, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [randomUUID(), args.businessId, input.expenseNo, input.expenseCategoryId, input.amount, input.description.trim(), args.userId],
    );
    return result.rows[0];
  });
}

export async function getLedger(args: Args) {
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "accounting.view");
    const result = await client.query(
      `SELECT je.id, je.entry_date, je.description, jl.account_id, a.code, a.name,
              jl.debit, jl.credit
       FROM journal_entries je
       JOIN journal_lines jl ON jl.journal_entry_id = je.id
       JOIN accounts a ON a.id = jl.account_id
       WHERE je.business_id = $1 ORDER BY je.entry_date, je.created_at`,
      [args.businessId],
    );
    return result.rows;
  });
}

export async function getTrialBalance(args: Args) {
  const ledger = await getLedger(args);
  return Object.values(ledger.reduce<Record<string, { accountId: string; code: string; name: string; debit: number; credit: number }>>((out, row) => {
    const current = out[row.account_id] ?? { accountId: row.account_id, code: row.code, name: row.name, debit: 0, credit: 0 };
    current.debit += Number(row.debit);
    current.credit += Number(row.credit);
    out[row.account_id] = current;
    return out;
  }, {}));
}
