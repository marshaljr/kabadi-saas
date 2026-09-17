/**
 * Backend authorization. Master Build Prompt section 32 is explicit:
 * "Do not hardcode role checks only into frontend components. Backend
 * authorization is mandatory." This checks the role_permissions table
 * directly — never a role *name* string compared with `===` — so
 * granting/revoking a permission for a role takes effect everywhere
 * immediately, and a business owner can customize what each role can
 * do without a code change.
 */

import type { PoolClient } from "pg";

export class ForbiddenError extends Error {
  constructor(public readonly permissionKey: string) {
    super(`Missing required permission: ${permissionKey}`);
    this.name = "ForbiddenError";
  }
}

/**
 * Call this at the top of any tenant-scoped service function that
 * requires a specific permission, using the `client` already inside
 * an active withTenantContext(...) transaction (so RLS also scopes
 * this lookup to the caller's own business's roles).
 */
export async function requirePermission(client: PoolClient, roleId: string, permissionKey: string): Promise<void> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = $1 AND p.key = $2
     ) AS exists`,
    [roleId, permissionKey],
  );

  if (!result.rows[0]?.exists) {
    throw new ForbiddenError(permissionKey);
  }
}

export async function hasPermission(client: PoolClient, roleId: string, permissionKey: string): Promise<boolean> {
  try {
    await requirePermission(client, roleId, permissionKey);
    return true;
  } catch (err) {
    if (err instanceof ForbiddenError) return false;
    throw err;
  }
}
