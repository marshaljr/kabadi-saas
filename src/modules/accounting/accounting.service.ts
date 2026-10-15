import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantContext } from "../../db/tenantContext.js";
import { requirePermission } from "../../middleware/authorize.js";
import { HttpError } from "../../lib/httpError.js";

type Args = { userId: string; businessId: string; roleId: string };
type JournalLineInput = { accountId: string; debit: number; credit: number; description?: string };
const referenceTypes = new Set(["PURCHASE", "SALE", "PAYMENT", "EXPENSE", "STOCK_ADJUSTMENT", "OPENING_BALANCE", "DAILY_CLOSING", "WORKER_ADVANCE"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function badRequest(message: string, code: string): never {
  throw new HttpError(400, message, code);
}

function validateAmount(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) badRequest(`${field} must be a finite non-negative amount`, "INVALID_AMOUNT");
}

export async function getSystemAccountId(client: PoolClient, businessId: string, accountCode: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM accounts WHERE business_id = $1 AND account_code = $2 AND is_active = TRUE",
    [businessId, accountCode],
  );
  if (result.rowCount !== 1) {
    throw new HttpError(500, "Required system account is not configured", "ACCOUNTING_CONFIGURATION_ERROR");
  }
  return result.rows[0]!.id;
}

export async function insertJournalEntry(
  client: PoolClient,
  businessId: string,
  userId: string,
  input: { entryNo: string; date?: string; referenceType?: string; referenceId?: string; description?: string; lines: JournalLineInput[] },
) {
  if (!input.entryNo.trim()) badRequest("Entry number is required", "INVALID_ENTRY_NO");
  if (input.lines.length < 2) badRequest("A journal entry requires at least two lines", "INVALID_JOURNAL_LINES");
  if (input.referenceType && !referenceTypes.has(input.referenceType)) {
    badRequest("Reference type is invalid", "INVALID_REFERENCE_TYPE");
  }

  if (input.referenceId && !uuidPattern.test(input.referenceId)) {
    badRequest("Reference ID is invalid", "INVALID_REFERENCE_ID");
  }

  for (const line of input.lines) {
    if (!line.accountId) badRequest("Every journal line requires an account", "INVALID_ACCOUNT");
    validateAmount(line.debit, "Debit");
    validateAmount(line.credit, "Credit");
    if ((line.debit > 0) === (line.credit > 0)) {
      badRequest("Each journal line must contain exactly one positive side", "INVALID_JOURNAL_LINE");
    }
  }

  if (input.lines.some((line) => !uuidPattern.test(line.accountId))) {
    badRequest("Every journal line account ID must be a valid UUID", "INVALID_ACCOUNT");
  }
  const accountIds = [...new Set(input.lines.map((line) => line.accountId))];
  const accounts = await client.query(
    "SELECT id FROM accounts WHERE business_id = $1 AND id = ANY($2::uuid[]) AND is_active = TRUE",
    [businessId, accountIds],
  );
  if (accounts.rowCount !== accountIds.length) {
    throw new HttpError(400, "Every account must belong to the active business", "INVALID_ACCOUNT");
  }

  const entry = await client.query(
    `INSERT INTO journal_entries
     (id, business_id, entry_no, date, reference_type, reference_id, description, status, created_by)
     VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5::reference_type, $6, $7, 'POSTED'::journal_status, $8)
     RETURNING *`,
    [randomUUID(), businessId, input.entryNo.trim(), input.date ?? null, input.referenceType ?? null,
      input.referenceId ?? null, input.description?.trim() || null, userId],
  );
  const entryId = entry.rows[0].id as string;

  for (const line of input.lines) {
    await client.query(
      `INSERT INTO journal_entry_lines
       (id, business_id, journal_entry_id, account_id, debit, credit, description)
       VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7)`,
      [randomUUID(), businessId, entryId, line.accountId, String(line.debit), String(line.credit), line.description?.trim() || null],
    );
  }

  const balance = await client.query<{ debit: string; credit: string; is_balanced: boolean }>(
    `SELECT COALESCE(SUM(debit), 0)::text AS debit, COALESCE(SUM(credit), 0)::text AS credit,
            COALESCE(SUM(debit), 0) = COALESCE(SUM(credit), 0) AS is_balanced
     FROM journal_entry_lines WHERE journal_entry_id = $1`,
    [entryId],
  );
  const databaseBalance = balance.rows[0]!;
  if (!databaseBalance.is_balanced || databaseBalance.debit === "0") {
    throw new HttpError(400, "Journal entry must have equal positive debit and credit totals", "UNBALANCED_JOURNAL");
  }
  const valid = await client.query<{ validate_journal_entry_balance: boolean }>(
    "SELECT validate_journal_entry_balance($1)", [entryId],
  );
  if (!valid.rows[0]?.validate_journal_entry_balance) {
    throw new HttpError(400, "Journal entry is unbalanced", "UNBALANCED_JOURNAL");
  }
  return { entry: entry.rows[0], lines: input.lines };
}

export async function createJournalEntry(args: Args, input: {
  entryNo: string; date?: string; referenceType?: string; referenceId?: string; description?: string; lines: JournalLineInput[];
}) {
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "accounting.manage");
    return insertJournalEntry(client, args.businessId, args.userId, input);
  });
}

export async function createIncome(args: Args, input: {
  entryNo: string; amount: number; debitAccountId: string; incomeAccountId: string; description: string; date?: string;
}) {
  validateAmount(input.amount, "Income amount");
  if (input.amount <= 0) badRequest("Income amount must be positive", "INVALID_AMOUNT");
  return createJournalEntry(args, {
    entryNo: input.entryNo,
    date: input.date,
    description: input.description,
    lines: [
      { accountId: input.debitAccountId, debit: input.amount, credit: 0 },
      { accountId: input.incomeAccountId, debit: 0, credit: input.amount },
    ],
  });
}

export async function createExpense(args: Args, input: {
  expenseNo: string; expenseCategoryId: string; amount: number; description: string;
  debitAccountId: string; creditAccountId: string; date?: string;
}) {
  if (!input.expenseNo.trim() || !input.expenseCategoryId) badRequest("Expense number and category are required", "INVALID_EXPENSE");
  validateAmount(input.amount, "Expense amount");
  if (input.amount <= 0) badRequest("Expense amount must be positive", "INVALID_AMOUNT");

  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "accounting.manage");
    const category = await client.query(
      "SELECT id FROM expense_categories WHERE id = $1 AND business_id = $2 AND is_active = TRUE",
      [input.expenseCategoryId, args.businessId],
    );
    if (category.rowCount !== 1) throw new HttpError(400, "Expense category is invalid", "INVALID_EXPENSE_CATEGORY");

    const expense = await client.query(
      `INSERT INTO expenses
       (id, business_id, expense_no, expense_category_id, amount, date, status, description, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::numeric, COALESCE($6::date, CURRENT_DATE), 'POSTED'::expense_status, $7, $8, $8)
       RETURNING *`,
      [randomUUID(), args.businessId, input.expenseNo.trim(), input.expenseCategoryId, String(input.amount),
        input.date ?? null, input.description.trim(), args.userId],
    );
    const journal = await insertJournalEntry(client, args.businessId, args.userId, {
      entryNo: `EXP-${input.expenseNo.trim()}`,
      date: input.date,
      referenceType: "EXPENSE",
      referenceId: expense.rows[0].id,
      description: input.description,
      lines: [
        { accountId: input.debitAccountId, debit: input.amount, credit: 0 },
        { accountId: input.creditAccountId, debit: 0, credit: input.amount },
      ],
    });
    return { expense: expense.rows[0], journal };
  });
}

export async function getLedger(args: Args) {
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "accounting.view");
    const result = await client.query(
      `SELECT je.id, je.entry_no, je.date, je.description, je.reference_type, je.reference_id,
              jl.account_id, a.account_code, a.name, jl.debit::text, jl.credit::text
       FROM journal_entries je
       JOIN journal_entry_lines jl ON jl.journal_entry_id = je.id
       JOIN accounts a ON a.id = jl.account_id
       WHERE je.business_id = $1 AND je.status = 'POSTED'
       ORDER BY je.date, je.created_at, jl.created_at`,
      [args.businessId],
    );
    return result.rows;
  });
}

export async function getTrialBalance(args: Args) {
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "accounting.view");
    const result = await client.query(
      `SELECT a.id AS account_id, a.account_code, a.name,
              COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit ELSE 0 END), 0)::text AS debit,
              COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit ELSE 0 END), 0)::text AS credit
       FROM accounts a
       LEFT JOIN journal_entry_lines jl ON jl.account_id = a.id AND jl.business_id = a.business_id
       LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
       WHERE a.business_id = $1
       GROUP BY a.id ORDER BY a.account_code`,
      [args.businessId],
    );
    return result.rows;
  });
}
