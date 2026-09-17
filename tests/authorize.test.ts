import assert from "node:assert/strict";
import { test } from "node:test";
import { ForbiddenError, hasPermission, requirePermission } from "../src/middleware/authorize.js";

/**
 * A minimal fake matching just the `.query()` shape authorize.ts
 * relies on, so this test exercises the real requirePermission logic
 * (including the ForbiddenError branch) without needing a live
 * Postgres connection.
 */
function fakeClient(grantedPermissionKeys: Set<string>) {
  return {
    query: async (_sql: string, params?: unknown[]) => {
      const permissionKey = params?.[1] as string;
      return { rows: [{ exists: grantedPermissionKeys.has(permissionKey) }], rowCount: 1 };
    },
    release: () => {},
    // biome-ignore lint: test double, not a real PoolClient
  } as any;
}

test("requirePermission resolves when the role has the permission", async () => {
  const client = fakeClient(new Set(["purchases.create"]));
  await assert.doesNotReject(() => requirePermission(client, "role-1", "purchases.create"));
});

test("requirePermission throws ForbiddenError when the role lacks the permission", async () => {
  const client = fakeClient(new Set(["purchases.view"]));
  await assert.rejects(() => requirePermission(client, "role-1", "purchases.create"), ForbiddenError);
});

test("hasPermission returns true/false instead of throwing", async () => {
  const client = fakeClient(new Set(["purchases.create"]));
  assert.equal(await hasPermission(client, "role-1", "purchases.create"), true);
  assert.equal(await hasPermission(client, "role-1", "purchases.cancel"), false);
});
