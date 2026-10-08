import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../../src/db/pool.js";
import { createBusiness, getUsage } from "../../src/modules/business/business.service.js";
import { hashPassword } from "../../src/lib/password.js";
import { createCategory, createMaterial, createWorker, listMaterials } from "../../src/modules/people/people.service.js";

async function setContext(
  client: PoolClient,
  userId: string,
  businessId: string | null,
  isPlatformAdmin: boolean,
) {
  await client.query(
    "SELECT set_config($1, $2, true)",
    ["app.current_user_id", userId],
  );

  await client.query(
    "SELECT set_config($1, $2, true)",
    ["app.current_business_id", businessId ?? ""],
  );

  await client.query(
    "SELECT set_config($1, $2, true)",
    ["app.is_platform_admin", String(isPlatformAdmin)],
  );
}


async function assertRlsBlocked(
  client: PoolClient,
  query: string,
  values: unknown[],
) {
  await client.query("SAVEPOINT rls_expected_error");

  try {
    await assert.rejects(
      () => client.query(query, values),
      (error: any) => error?.code === "42501",
    );
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT rls_expected_error");
    await client.query("RELEASE SAVEPOINT rls_expected_error");
  }
}

test("RLS prevents cross-tenant worker and role permission access", async () => {
  const client = await pool.connect();

  const businessA = randomUUID();
  const businessB = randomUUID();
  const roleA = randomUUID();
  const roleB = randomUUID();
  const workerA = randomUUID();
  const workerB = randomUUID();
  const permissionId = randomUUID();
  const userId = randomUUID();

  try {
    await client.query("BEGIN");

    // Create isolated test fixtures using platform-admin context.
    await setContext(client, userId, null, true);

    await client.query(
      `INSERT INTO businesses (id, name)
       VALUES ($1, $2), ($3, $4)`,
      [
        businessA,
        `RLS Test Business A ${businessA.slice(0, 8)}`,
        businessB,
        `RLS Test Business B ${businessB.slice(0, 8)}`,
      ],
    );

    await client.query(
      `INSERT INTO roles (id, business_id, name)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [roleA, businessA, "RLS Test Role A", roleB, businessB, "RLS Test Role B"],
    );

    await client.query(
      `INSERT INTO workers (id, business_id, name)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        workerA,
        businessA,
        "RLS Test Worker A",
        workerB,
        businessB,
        "RLS Test Worker B",
      ],
    );

    await client.query(
      `INSERT INTO permissions (id, key, label, category)
       VALUES ($1, $2, $3, $4)`,
      [permissionId, `rls.test.${permissionId}`, "RLS Test Permission", "Testing"],
    );

    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       VALUES ($1, $2), ($3, $2)`,
      [roleA, permissionId, roleB],
    );

    // ----------------------------------------------------------
    // BUSINESS A CONTEXT
    // ----------------------------------------------------------
    await setContext(client, userId, businessA, false);

    const aWorkers = await client.query(
      `SELECT id, name
       FROM workers
       ORDER BY id`,
    );

    assert.equal(aWorkers.rowCount, 1);
    assert.equal(aWorkers.rows[0]!.id, workerA);
    assert.equal(aWorkers.rows[0]!.name, "RLS Test Worker A");

    const hiddenBWorker = await client.query(
      `SELECT id
       FROM workers
       WHERE id = $1`,
      [workerB],
    );

    assert.equal(hiddenBWorker.rowCount, 0);

    const crossTenantUpdate = await client.query(
      `UPDATE workers
       SET name = 'SHOULD NOT UPDATE'
       WHERE id = $1`,
      [workerB],
    );

    assert.equal(crossTenantUpdate.rowCount, 0);

    await assertRlsBlocked(
      client,
      `INSERT INTO workers (id, business_id, name)
       VALUES ($1, $2, $3)`,
      [randomUUID(), businessB, "Illegal Cross-Tenant Worker"],
    );

    const aRolePermissions = await client.query(
      `SELECT role_id, permission_id
       FROM role_permissions
       ORDER BY role_id`,
    );

    assert.equal(aRolePermissions.rowCount, 1);
    assert.equal(aRolePermissions.rows[0]!.role_id, roleA);
    assert.equal(aRolePermissions.rows[0]!.permission_id, permissionId);

    const hiddenBRolePermission = await client.query(
      `SELECT role_id
       FROM role_permissions
       WHERE role_id = $1`,
      [roleB],
    );

    assert.equal(hiddenBRolePermission.rowCount, 0);

    await assertRlsBlocked(
      client,
      `INSERT INTO role_permissions (role_id, permission_id)
       VALUES ($1, $2)`,
      [roleB, permissionId],
    );

    // ----------------------------------------------------------
    // BUSINESS B CONTEXT
    // ----------------------------------------------------------
    await setContext(client, userId, businessB, false);

    const bWorkers = await client.query(
      `SELECT id, name
       FROM workers
       ORDER BY id`,
    );

    assert.equal(bWorkers.rowCount, 1);
    assert.equal(bWorkers.rows[0]!.id, workerB);
    assert.equal(bWorkers.rows[0]!.name, "RLS Test Worker B");

    assert.notEqual(bWorkers.rows[0]!.id, workerA);

    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

test("business onboarding seeds tenant foundation and usage", async () => {
  const client = await pool.connect();
  const userId = randomUUID();
  let businessId: string | undefined;
  try {
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    await client.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [userId, "Phase 2 Owner", `phase2-${userId}@example.test`, await hashPassword("phase2-password")],
    );
    await client.query("COMMIT");

    const result = await createBusiness(userId, { name: `Phase 2 Business ${userId.slice(0, 8)}` });
    businessId = result.business.id;
    assert.equal(result.roleName, "Owner");
    assert.ok(result.accessToken);

    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    const seeded = await client.query(
      `SELECT
         (SELECT count(*) FROM roles WHERE business_id = $1) AS roles,
         (SELECT count(*) FROM accounts WHERE business_id = $1) AS accounts,
         (SELECT status FROM subscriptions WHERE business_id = $1) AS subscription_status`,
      [businessId],
    );
    assert.equal(Number(seeded.rows[0]!.roles), 4);
    assert.equal(Number(seeded.rows[0]!.accounts), 18);
    assert.equal(seeded.rows[0]!.subscription_status, "TRIALING");
    await client.query("COMMIT");

    await client.query("BEGIN");
    await setContext(client, userId, businessId, false);
    const usage = await getUsage(userId, businessId, (await client.query(
      "SELECT role_id FROM business_memberships WHERE user_id = $1 AND business_id = $2",
      [userId, businessId],
    )).rows[0]!.role_id);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.metric, "users");
    assert.equal(Number(usage[0]!.value), 1);
    await client.query("COMMIT");
  } finally {
    await client.query("BEGIN").catch(() => {});
    await setContext(client, userId, null, true).catch(() => {});
    if (businessId) await client.query("DELETE FROM businesses WHERE id = $1", [businessId]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT").catch(() => client.query("ROLLBACK"));
    client.release();
  }
});

test.after(async () => {
  await pool.end();
});

test("materials and people services stay tenant-scoped and update worker usage", async () => {
  const client = await pool.connect();
  const userId = randomUUID();
  let businessId: string | undefined;
  try {
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    await client.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [userId, "Phase 3 Owner", `phase3-${userId}@example.test`, await hashPassword("phase3-password")],
    );
    await client.query("COMMIT");

    const onboarding = await createBusiness(userId, { name: `Phase 3 Business ${userId.slice(0, 8)}` });
    businessId = onboarding.business.id;
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    const owner = (await client.query(
      "SELECT role_id FROM business_memberships WHERE user_id = $1 AND business_id = $2",
      [userId, businessId],
    )).rows[0]!.role_id as string;
    await client.query("COMMIT");
    const args = { userId, businessId, roleId: owner };
    const category = await createCategory(args, "Metals");
    await createMaterial(args, { categoryId: category.id, name: "Copper", defaultUnit: "KG" });
    await createWorker(args, { name: "Ram Kumar", workerCode: "W-001" });
    assert.equal((await listMaterials(args)).length, 1);

    const usage = await getUsage(userId, businessId, owner);
    const workersUsage = usage.find((row) => row.metric === "workers");
    assert.equal(Number(workersUsage?.value), 1);
  } finally {
    await client.query("BEGIN").catch(() => {});
    await setContext(client, userId, null, true).catch(() => {});
    if (businessId) await client.query("DELETE FROM businesses WHERE id = $1", [businessId]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT").catch(() => client.query("ROLLBACK"));
    client.release();
  }
});
