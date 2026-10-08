import { randomUUID } from "node:crypto";
import { withTenantContext } from "../../db/tenantContext.js";
import { requirePermission } from "../../middleware/authorize.js";

type Args = { userId: string; businessId: string; roleId: string };

export async function getInventory(args: Args) {
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "inventory.view");
    const result = await client.query(
      `SELECT m.id, m.name, m.sku, m.minimum_stock,
              COALESCE(SUM(sm.quantity_in) - SUM(sm.quantity_out), 0) AS quantity_on_hand,
              COALESCE(SUM(sm.quantity_in * sm.unit_cost) / NULLIF(SUM(sm.quantity_in), 0), 0) AS average_cost,
              COALESCE(SUM(sm.quantity_in) - SUM(sm.quantity_out), 0) < m.minimum_stock AS low_stock
       FROM materials m
       LEFT JOIN stock_movements sm ON sm.material_id = m.id AND sm.business_id = m.business_id
       WHERE m.business_id = $1 AND m.deleted_at IS NULL
       GROUP BY m.id ORDER BY m.name`,
      [args.businessId],
    );
    return result.rows;
  });
}

export async function createAdjustment(
  args: Args,
  input: { materialId: string; quantity: number; unit: string; unitCost: number; direction: "IN" | "OUT"; notes?: string },
) {
  if (input.quantity <= 0 || input.unitCost < 0) throw new Error("Quantity and unit cost must be valid");
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "inventory.adjust");
    const movementType = input.direction === "IN" ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT";
    if (input.direction === "OUT") {
      const stock = await client.query<{ quantity_on_hand: string }>(
        "SELECT quantity_on_hand FROM current_stock WHERE business_id = $1 AND material_id = $2",
        [args.businessId, input.materialId],
      );
      if (Number(stock.rows[0]?.quantity_on_hand ?? 0) < input.quantity) throw new Error("Insufficient stock for adjustment");
    }
    const result = await client.query(
      `INSERT INTO stock_movements
       (id, business_id, material_id, movement_type, quantity_in, quantity_out, unit, unit_cost, notes, created_by)
       VALUES ($1, $2, $3, $4::stock_movement_type, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [randomUUID(), args.businessId, input.materialId, movementType,
        input.direction === "IN" ? input.quantity : 0, input.direction === "OUT" ? input.quantity : 0,
        input.unit, input.unitCost, input.notes?.trim() || null, args.userId],
    );
    return result.rows[0];
  });
}
