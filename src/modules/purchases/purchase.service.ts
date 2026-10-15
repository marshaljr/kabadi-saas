import { randomUUID } from "node:crypto";
import { withTenantContext } from "../../db/tenantContext.js";
import { requirePermission } from "../../middleware/authorize.js";
import { getSystemAccountId, insertJournalEntry } from "../accounting/accounting.service.js";

export interface PurchaseItemInput {
  materialId: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  notes?: string;
}

export async function createPurchase(
  args: { userId: string; businessId: string; roleId: string },
  input: {
    purchaseNo: string;
    workerId?: string;
    supplierId?: string;
    date?: string;
    discount?: number;
    taxAmount?: number;
    paidAmount?: number;
    notes?: string;
    items: PurchaseItemInput[];
  },
) {
  if ((input.workerId ? 1 : 0) + (input.supplierId ? 1 : 0) !== 1) {
    throw new Error("Exactly one workerId or supplierId is required");
  }
  if (!input.items.length) throw new Error("At least one purchase item is required");

  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "purchases.create");
    const subtotal = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    const discount = input.discount ?? 0;
    const taxAmount = input.taxAmount ?? 0;
    const totalAmount = subtotal - discount + taxAmount;
    const paidAmount = input.paidAmount ?? 0;
    if (discount < 0 || taxAmount < 0 || paidAmount < 0 || paidAmount > totalAmount) {
      throw new Error("Invalid purchase totals");
    }
    const purchaseId = randomUUID();
    const header = await client.query(
      `INSERT INTO purchases
       (id, business_id, purchase_no, worker_id, supplier_id, date, subtotal, discount, tax_amount, total_amount, paid_amount, due_amount, status, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8, $9, $10, $11, $10::numeric - $11::numeric, 'POSTED'::purchase_status, $12, $13, $13)
       RETURNING *`,
      [purchaseId, args.businessId, input.purchaseNo.trim(), input.workerId ?? null, input.supplierId ?? null,
        input.date ?? null, subtotal, discount, taxAmount, totalAmount, paidAmount, input.notes?.trim() || null, args.userId],
    );
    for (const item of input.items) {
      await client.query(
        `INSERT INTO purchase_items (id, business_id, purchase_id, material_id, quantity, unit, unit_price, amount, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [randomUUID(), args.businessId, purchaseId, item.materialId, item.quantity, item.unit, item.unitPrice,
          item.quantity * item.unitPrice, item.notes?.trim() || null],
      );
      await client.query(
        `INSERT INTO stock_movements
         (id, business_id, material_id, movement_type, reference_type, reference_id, quantity_in, unit, unit_cost, created_by)
         VALUES ($1, $2, $3, 'PURCHASE_IN'::stock_movement_type, 'PURCHASE'::reference_type, $4, $5, $6, $7, $8)`,
        [randomUUID(), args.businessId, item.materialId, purchaseId, item.quantity, item.unit, item.unitPrice, args.userId],
      );
    }
    await client.query(
      `INSERT INTO usage_records (business_id, period_start, metric, value)
       VALUES ($1, date_trunc('month', current_date)::date, 'transactions', 1)
       ON CONFLICT (business_id, period_start, metric)
       DO UPDATE SET value = usage_records.value + 1, updated_at = now()`,
      [args.businessId],
    );
    const inventoryAccount = await getSystemAccountId(client, args.businessId, "1200");
    const cashAccount = await getSystemAccountId(client, args.businessId, "1000");
    const payableAccount = await getSystemAccountId(client, args.businessId, input.workerId ? "2000" : "2010");
    const paymentLines = paidAmount > 0
      ? [{ accountId: cashAccount, debit: 0, credit: paidAmount }]
      : [];
    const payableLines = totalAmount - paidAmount > 0
      ? [{ accountId: payableAccount, debit: 0, credit: totalAmount - paidAmount }]
      : [];
    await insertJournalEntry(client, args.businessId, args.userId, {
      entryNo: `PUR-${purchaseId}`,
      date: input.date,
      referenceType: "PURCHASE",
      referenceId: purchaseId,
      description: `Purchase ${input.purchaseNo.trim()}`,
      lines: [
        { accountId: inventoryAccount, debit: totalAmount, credit: 0 },
        ...paymentLines,
        ...payableLines,
      ],
    });
    return { purchase: header.rows[0], items: input.items };
  });
}

export async function listPurchases(args: { userId: string; businessId: string; roleId: string }) {
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "purchases.view");
    const result = await client.query(
      `SELECT p.*, COALESCE(json_agg(pi ORDER BY pi.created_at) FILTER (WHERE pi.id IS NOT NULL), '[]') AS items
       FROM purchases p LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
       WHERE p.business_id = $1 GROUP BY p.id ORDER BY p.date DESC, p.created_at DESC`,
      [args.businessId],
    );
    return result.rows;
  });
}
