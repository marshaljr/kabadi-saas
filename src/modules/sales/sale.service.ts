import { randomUUID } from "node:crypto";
import { withTenantContext } from "../../db/tenantContext.js";
import { requirePermission } from "../../middleware/authorize.js";
import { getSystemAccountId, insertJournalEntry } from "../accounting/accounting.service.js";

export interface SaleItemInput {
  materialId: string;
  quantity: number;
  unit: string;
  unitPrice: number;
}

export async function createSale(
  args: { userId: string; businessId: string; roleId: string },
  input: { saleNo: string; customerId?: string; date?: string; discount?: number; taxAmount?: number; paidAmount?: number; notes?: string; items: SaleItemInput[] },
) {
  if (!input.items.length) throw new Error("At least one sale item is required");
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "sales.create");
    const subtotal = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    const discount = input.discount ?? 0;
    const taxAmount = input.taxAmount ?? 0;
    const totalAmount = subtotal - discount + taxAmount;
    const paidAmount = input.paidAmount ?? 0;
    if (discount < 0 || taxAmount < 0 || paidAmount < 0 || paidAmount > totalAmount) throw new Error("Invalid sale totals");

    const saleId = randomUUID();
    const costing: Array<{ item: SaleItemInput; averageCost: number; cogs: number }> = [];
    for (const item of input.items) {
      const stock = await client.query<{ on_hand: string; average_cost: string }>(
        `SELECT COALESCE(SUM(quantity_in) - SUM(quantity_out), 0)::text AS on_hand,
                COALESCE(SUM(quantity_in * unit_cost) / NULLIF(SUM(quantity_in), 0), 0)::text AS average_cost
         FROM stock_movements WHERE business_id = $1 AND material_id = $2`,
        [args.businessId, item.materialId],
      );
      const row = stock.rows[0]!;
      const onHand = Number(row.on_hand);
      if (onHand < item.quantity) throw new Error(`Insufficient stock for material ${item.materialId}`);
      const averageCost = Number(row.average_cost);
      costing.push({ item, averageCost, cogs: item.quantity * averageCost });
    }

    const sale = await client.query(
      `INSERT INTO sales
       (id, business_id, sale_no, customer_id, date, subtotal, discount, tax_amount, total_amount, paid_amount, due_amount, status, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7, $8, $9, $10, $9::numeric - $10::numeric, 'POSTED'::sale_status, $11, $12, $12)
       RETURNING *`,
      [saleId, args.businessId, input.saleNo.trim(), input.customerId ?? null, input.date ?? null,
        subtotal, discount, taxAmount, totalAmount, paidAmount, input.notes?.trim() || null, args.userId],
    );
    for (const { item, averageCost, cogs } of costing) {
      await client.query(
        `INSERT INTO sale_items
         (id, business_id, sale_id, material_id, quantity, unit, unit_price, amount, cost_per_unit, cogs_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [randomUUID(), args.businessId, saleId, item.materialId, item.quantity, item.unit, item.unitPrice,
          item.quantity * item.unitPrice, averageCost, cogs],
      );
      await client.query(
        `INSERT INTO stock_movements
         (id, business_id, material_id, movement_type, reference_type, reference_id, quantity_out, unit, unit_cost, created_by)
         VALUES ($1, $2, $3, 'SALE_OUT'::stock_movement_type, 'SALE'::reference_type, $4, $5, $6, $7, $8)`,
        [randomUUID(), args.businessId, item.materialId, saleId, item.quantity, item.unit, averageCost, args.userId],
      );
    }
    await client.query(
      `INSERT INTO usage_records (business_id, period_start, metric, value)
       VALUES ($1, date_trunc('month', current_date)::date, 'transactions', 1)
       ON CONFLICT (business_id, period_start, metric)
       DO UPDATE SET value = usage_records.value + 1, updated_at = now()`,
      [args.businessId],
    );
    const cogs = costing.reduce((sum, item) => sum + item.cogs, 0);
    const cashAccount = await getSystemAccountId(client, args.businessId, "1000");
    const receivableAccount = await getSystemAccountId(client, args.businessId, "1100");
    const revenueAccount = await getSystemAccountId(client, args.businessId, "4000");
    const cogsAccount = await getSystemAccountId(client, args.businessId, "5000");
    const inventoryAccount = await getSystemAccountId(client, args.businessId, "1200");
    const saleLines = [
      ...(paidAmount > 0 ? [{ accountId: cashAccount, debit: paidAmount, credit: 0 }] : []),
      ...(totalAmount - paidAmount > 0 ? [{ accountId: receivableAccount, debit: totalAmount - paidAmount, credit: 0 }] : []),
      { accountId: revenueAccount, debit: 0, credit: totalAmount },
      ...(cogs > 0 ? [
        { accountId: cogsAccount, debit: cogs, credit: 0 },
        { accountId: inventoryAccount, debit: 0, credit: cogs },
      ] : []),
    ];
    await insertJournalEntry(client, args.businessId, args.userId, {
      entryNo: `SAL-${saleId}`,
      date: input.date,
      referenceType: "SALE",
      referenceId: saleId,
      description: `Sale ${input.saleNo.trim()}`,
      lines: saleLines,
    });
    return { sale: sale.rows[0], grossProfit: totalAmount - cogs, cogs };
  });
}

export async function listSales(args: { userId: string; businessId: string; roleId: string }) {
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "sales.view");
    const result = await client.query(
      `SELECT s.*, COALESCE(json_agg(si ORDER BY si.created_at) FILTER (WHERE si.id IS NOT NULL), '[]') AS items
       FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE s.business_id = $1 GROUP BY s.id ORDER BY s.date DESC, s.created_at DESC`,
      [args.businessId],
    );
    return result.rows;
  });
}
