import { randomUUID } from "node:crypto";
import { withTenantContext } from "../../db/tenantContext.js";
import { requirePermission } from "../../middleware/authorize.js";
import { HttpError } from "../../lib/httpError.js";

type Args = { userId: string; businessId: string; roleId: string };
const units = new Set(["KG", "GRAM", "TON", "PIECE", "DOZEN", "BAG", "CUSTOM"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  input: { materialId: string; quantity: number; unit: string; unitCost: number; direction: string; notes?: string },
) {
  if (!uuidPattern.test(input.materialId)) throw new HttpError(400, "A valid materialId is required", "INVALID_MATERIAL_ID");
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new HttpError(400, "Quantity must be a finite number greater than zero", "INVALID_QUANTITY");
  }
  if (!Number.isFinite(input.unitCost) || input.unitCost < 0) {
    throw new HttpError(400, "Unit cost must be a finite non-negative number", "INVALID_UNIT_COST");
  }
  if (!units.has(input.unit)) throw new HttpError(400, "Unsupported inventory unit", "INVALID_UNIT");
  if (input.direction !== "IN" && input.direction !== "OUT") {
    throw new HttpError(400, "Direction must be IN or OUT", "INVALID_DIRECTION");
  }
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, "inventory.adjust");
    const material = await client.query(
      "SELECT id FROM materials WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL FOR UPDATE",
      [input.materialId, args.businessId],
    );
    if (material.rowCount !== 1) throw new HttpError(404, "Material not found", "MATERIAL_NOT_FOUND");

    const movementType = input.direction === "IN" ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT";
    if (input.direction === "OUT") {
      const stock = await client.query<{ quantity_on_hand: string }>(
        "SELECT quantity_on_hand FROM current_stock WHERE business_id = $1 AND material_id = $2",
        [args.businessId, input.materialId],
      );
      if (Number(stock.rows[0]?.quantity_on_hand ?? 0) < input.quantity) {
        throw new HttpError(409, "Insufficient stock for adjustment", "INSUFFICIENT_STOCK");
      }
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
