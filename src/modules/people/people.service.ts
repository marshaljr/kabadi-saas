import { randomUUID } from "node:crypto";
import { withTenantContext } from "../../db/tenantContext.js";
import { requirePermission } from "../../middleware/authorize.js";
import { reserveQuota, recordQuotaUsage } from "../billing/billing.service.js";

type TenantArgs = { userId: string; businessId: string; roleId: string };

async function insert(
  args: TenantArgs,
  table: "categories" | "materials" | "workers" | "customers" | "suppliers" | "payment_methods",
  permission: string,
  columns: string[],
  values: unknown[],
) {
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, permission);
    if (table === "workers") await reserveQuota(client, args.businessId, "workers");
    const id = randomUUID();
    const placeholders = columns.map((_, index) => `$${index + 3}`).join(", ");
    const result = await client.query(
      `INSERT INTO ${table} (id, business_id, ${columns.join(", ")})
       VALUES ($1, $2, ${placeholders})
       RETURNING *`,
      [id, args.businessId, ...values],
    );
    if (table === "workers") {
      await recordQuotaUsage(client, args.businessId, "workers");
    }
    return result.rows[0];
  });
}

async function list(args: TenantArgs, table: string, permission: string) {
  return withTenantContext(args.userId, args.businessId, async (client) => {
    await requirePermission(client, args.roleId, permission);
    const result = await client.query(
      `SELECT * FROM ${table} WHERE business_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [args.businessId],
    );
    return result.rows;
  });
}

export const createCategory = (args: TenantArgs, name: string, description?: string) =>
  insert(args, "categories", "materials.manage", ["name", "description"], [name.trim(), description?.trim() || null]);

export const listCategories = (args: TenantArgs) => list(args, "categories", "materials.manage");

export const createMaterial = (
  args: TenantArgs,
  input: { categoryId: string; name: string; sku?: string; defaultUnit?: string; minimumStock?: number; notes?: string },
) => insert(args, "materials", "materials.manage", [
  "category_id", "name", "sku", "default_unit", "minimum_stock", "notes",
], [input.categoryId, input.name.trim(), input.sku?.trim() || null, input.defaultUnit ?? "KG", input.minimumStock ?? 0, input.notes?.trim() || null]);

export const listMaterials = (args: TenantArgs) => list(args, "materials", "materials.manage");

export const createWorker = (
  args: TenantArgs,
  input: { name: string; workerCode?: string; phone?: string; address?: string; joiningDate?: string; notes?: string },
) => insert(args, "workers", "workers.create", [
  "name", "worker_code", "phone", "address", "joining_date", "notes",
], [input.name.trim(), input.workerCode?.trim() || null, input.phone?.trim() || null, input.address?.trim() || null, input.joiningDate || null, input.notes?.trim() || null]);

export const listWorkers = (args: TenantArgs) => list(args, "workers", "workers.view");

export const createCustomer = (args: TenantArgs, input: { name: string; customerCode?: string; phone?: string; address?: string }) =>
  insert(args, "customers", "customers.manage", ["name", "customer_code", "phone", "address"], [input.name.trim(), input.customerCode?.trim() || null, input.phone?.trim() || null, input.address?.trim() || null]);

export const listCustomers = (args: TenantArgs) => list(args, "customers", "customers.manage");

export const createSupplier = (args: TenantArgs, input: { name: string; supplierCode?: string; phone?: string; address?: string }) =>
  insert(args, "suppliers", "suppliers.manage", ["name", "supplier_code", "phone", "address"], [input.name.trim(), input.supplierCode?.trim() || null, input.phone?.trim() || null, input.address?.trim() || null]);

export const listSuppliers = (args: TenantArgs) => list(args, "suppliers", "suppliers.manage");

export const createPaymentMethod = (args: TenantArgs, name: string, isCash = false) =>
  insert(args, "payment_methods", "payments.create", ["name", "is_cash"], [name.trim(), isCash]);

export const listPaymentMethods = (args: TenantArgs) => list(args, "payment_methods", "payments.view");
