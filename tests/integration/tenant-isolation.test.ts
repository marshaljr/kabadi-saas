import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../../src/db/pool.js";
import { createBusiness, getUsage } from "../../src/modules/business/business.service.js";
import { hashPassword } from "../../src/lib/password.js";
import { createCategory, createMaterial, createWorker, listMaterials } from "../../src/modules/people/people.service.js";
import { createPurchase } from "../../src/modules/purchases/purchase.service.js";
import { createSale } from "../../src/modules/sales/sale.service.js";
import { withTenantContext } from "../../src/db/tenantContext.js";
import { createAdjustment, getInventory } from "../../src/modules/inventory/inventory.service.js";
import { createExpense, createIncome, createJournalEntry, getLedger, getTrialBalance } from "../../src/modules/accounting/accounting.service.js";
import { getDashboard, getProfitAndLoss } from "../../src/modules/reports/reports.service.js";
import { server } from "../../src/server.js";
import { signJwt } from "../../src/lib/jwt.js";
import { env } from "../../src/config/env.js";

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

test("accounting journals stay balanced, tenant-scoped, and atomic", async () => {
  const client = await pool.connect();
  const userId = randomUUID();
  let businessId: string | undefined;
  let otherBusinessId: string | undefined;
  try {
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    await client.query(
      `INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [userId, "Accounting Owner", `accounting-${userId}@example.test`, await hashPassword("accounting-password")],
    );
    await client.query("COMMIT");
    businessId = (await createBusiness(userId, { name: `Accounting ${userId.slice(0, 8)}` })).business.id;
    otherBusinessId = (await createBusiness(userId, { name: `Other Accounting ${userId.slice(0, 8)}` })).business.id;
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    const roleId = (await client.query(
      "SELECT role_id FROM business_memberships WHERE user_id = $1 AND business_id = $2", [userId, businessId],
    )).rows[0]!.role_id as string;
    const accounts = (await client.query(
      "SELECT id, account_code FROM accounts WHERE business_id = $1 AND account_code IN ('1000', '4000', '6000') ORDER BY account_code",
      [businessId],
    )).rows as Array<{ id: string; account_code: string }>;
    const cash = accounts.find((account) => account.account_code === "1000")!.id;
    const revenue = accounts.find((account) => account.account_code === "4000")!.id;
    const expenseAccount = accounts.find((account) => account.account_code === "6000")!.id;
    await client.query("COMMIT");
    const otherAccount = await withTenantContext(userId, otherBusinessId, (tenantClient) => tenantClient.query(
      "SELECT id FROM accounts WHERE business_id = $1 AND account_code = '1000'", [otherBusinessId],
    ));
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    await client.query("INSERT INTO expense_categories (business_id, name) VALUES ($1, $2)", [businessId, "Utilities"]);
    const categoryId = (await client.query(
      "SELECT id FROM expense_categories WHERE business_id = $1 AND name = 'Utilities'", [businessId],
    )).rows[0]!.id as string;
    await client.query("COMMIT");

    const args = { userId, businessId, roleId };
    const balanced = await createJournalEntry(args, {
      entryNo: "JE-001", description: "Initial balanced entry",
      lines: [{ accountId: cash, debit: 100, credit: 0 }, { accountId: revenue, debit: 0, credit: 100 }],
    });

    await (async () => {
      const userId = randomUUID();
      const onboarding = await (async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await setContext(client, userId, null, true);
          await client.query(
            `INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
            [userId, "Reports Owner", `reports-${userId}@example.test`, await hashPassword("reports-password")],
          );
          await client.query("COMMIT");
        } finally {
          client.release();
        }
        return createBusiness(userId, { name: `Reports ${userId.slice(0, 8)}` });
      })();
      const businessId = onboarding.business.id;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await setContext(client, userId, null, true);
        const roleId = (await client.query(
          "SELECT role_id FROM business_memberships WHERE user_id = $1 AND business_id = $2", [userId, businessId],
        )).rows[0]!.role_id as string;
        const accounts = (await client.query(
          "SELECT id, account_code FROM accounts WHERE business_id = $1 AND account_code IN ('1000', '1200', '4000', '5000', '6000')",
          [businessId],
        )).rows as Array<{ id: string; account_code: string }>;
        await client.query("COMMIT");
        const account = (code: string) => accounts.find((row) => row.account_code === code)!.id;
        const args = { userId, businessId, roleId };

        await createJournalEntry(args, {
          entryNo: "REPORT-SALE", date: "2026-01-10", referenceType: "SALE",
          lines: [
            { accountId: account("1000"), debit: 200, credit: 0 },
            { accountId: account("5000"), debit: 80, credit: 0 },
            { accountId: account("4000"), debit: 0, credit: 200 },
            { accountId: account("1200"), debit: 0, credit: 80 },
          ],
        });
        await createIncome(args, {
          entryNo: "REPORT-OTHER-INCOME", date: "2026-01-11", amount: 30,
          debitAccountId: account("1000"), incomeAccountId: account("4000"), description: "Recycling rebate",
        });
        await createJournalEntry(args, {
          entryNo: "REPORT-EXPENSE", date: "2026-01-12", referenceType: "EXPENSE",
          lines: [
            { accountId: account("6000"), debit: 40, credit: 0 },
            { accountId: account("1000"), debit: 0, credit: 40 },
          ],
        });

        const report = await getProfitAndLoss(args, { from: "2026-01-01", to: "2026-01-31" });
        assert.equal(report.salesRevenue, "200.00");
        assert.equal(report.cogs, "80.00");
        assert.equal(report.grossProfit, "120.00");
        assert.equal(report.operatingExpenses, "40.00");
        assert.equal(report.otherIncome, "30.00");
        assert.equal(report.netProfit, "80.00");

        const filtered = await getProfitAndLoss(args, { from: "2026-01-10", to: "2026-01-10" });
        assert.equal(filtered.salesRevenue, "200.00");
        assert.equal(filtered.otherIncome, "0.00");
        await assert.rejects(
          () => getProfitAndLoss(args, { from: "2026-02-01", to: "2026-01-01" }),
          (error: { publicCode?: string }) => error.publicCode === "INVALID_DATE_RANGE",
        );

        await withTenantContext(userId, businessId, async (tenantClient) => {
          await tenantClient.query(
            "UPDATE journal_entries SET status = 'REVERSED'::journal_status WHERE entry_no = 'REPORT-EXPENSE'",
          );
        });
        const afterReverse = await getProfitAndLoss(args, { from: "2026-01-01", to: "2026-01-31" });
        assert.equal(afterReverse.operatingExpenses, "0.00");

        const dashboard = await getDashboard(args, { from: "2026-01-01", to: "2026-01-31" });
        assert.equal(dashboard.financial.revenue, "200.00");
        assert.equal(dashboard.financial.cogs, "80.00");
        assert.equal(dashboard.financial.grossProfit, "120.00");
        assert.equal(dashboard.financial.netProfit, "120.00");
        assert.equal(dashboard.purchases.count, 0);
        assert.equal(dashboard.sales.count, 0);
        assert.equal(dashboard.inventory.quantity, "0");
      } finally {
        await client.query("BEGIN").catch(() => {});
        await setContext(client, userId, null, true).catch(() => {});
        await client.query("DELETE FROM businesses WHERE id = $1", [businessId]);
        await client.query("DELETE FROM users WHERE id = $1", [userId]);
        await client.query("COMMIT").catch(() => client.query("ROLLBACK"));
        client.release();
      }
    })();
    assert.equal(balanced.lines.length, 2);
    await assert.rejects(
      () => createJournalEntry(args, {
        entryNo: "JE-UNBALANCED", lines: [{ accountId: cash, debit: 100, credit: 0 }, { accountId: revenue, debit: 0, credit: 90 }],
      }),
      (error: { publicCode?: string }) => error.publicCode === "UNBALANCED_JOURNAL",
    );
    await assert.rejects(
      () => createJournalEntry(args, { entryNo: "JE-MISSING-LINE", lines: [{ accountId: cash, debit: 1, credit: 0 }] }),
      (error: { publicCode?: string }) => error.publicCode === "INVALID_JOURNAL_LINES",
    );
    await assert.rejects(
      () => createJournalEntry(args, {
        entryNo: "JE-INVALID-AMOUNT", lines: [
          { accountId: cash, debit: Number.NaN, credit: 0 },
          { accountId: revenue, debit: 0, credit: 1 },
        ],
      }),
      (error: { publicCode?: string }) => error.publicCode === "INVALID_AMOUNT",
    );
    await assert.rejects(
      () => createJournalEntry(args, {
        entryNo: "JE-BOTH-SIDES", lines: [
          { accountId: cash, debit: 1, credit: 1 },
          { accountId: revenue, debit: 0, credit: 2 },
        ],
      }),
      (error: { publicCode?: string }) => error.publicCode === "INVALID_JOURNAL_LINE",
    );
    await assert.rejects(
      () => createJournalEntry(args, {
        entryNo: "JE-INVALID", lines: [{ accountId: randomUUID(), debit: 1, credit: 0 }, { accountId: revenue, debit: 0, credit: 1 }],
      }),
      (error: { publicCode?: string }) => error.publicCode === "INVALID_ACCOUNT",
    );
    await assert.rejects(
      () => createJournalEntry(args, {
        entryNo: "JE-CROSS-TENANT", lines: [{ accountId: otherAccount.rows[0]!.id, debit: 1, credit: 0 }, { accountId: revenue, debit: 0, credit: 1 }],
      }),
      (error: { publicCode?: string }) => error.publicCode === "INVALID_ACCOUNT",
    );
    const income = await createIncome(args, {
      entryNo: "INC-001", amount: 50, debitAccountId: cash, incomeAccountId: revenue, description: "Scrap consulting",
    });
    assert.equal(income.lines.length, 2);
    const expense = await createExpense(args, {
      expenseNo: "EXP-001", expenseCategoryId: categoryId, amount: 25, description: "Power",
      debitAccountId: expenseAccount, creditAccountId: cash,
    });
    assert.equal(expense.journal.lines.length, 2);
    const ledger = await getLedger(args);
    assert.equal(ledger.length, 6);
    const trialBalance = await getTrialBalance(args);
    assert.equal(trialBalance.reduce((sum, row) => sum + Number(row.debit), 0), trialBalance.reduce((sum, row) => sum + Number(row.credit), 0));
    const failedEntry = await withTenantContext(userId, businessId, (tenantClient) => tenantClient.query(
      "SELECT COUNT(*)::int AS count FROM journal_entries WHERE business_id = $1 AND entry_no IN ('JE-UNBALANCED', 'JE-MISSING-LINE', 'JE-INVALID', 'JE-CROSS-TENANT')",
      [businessId],
    ));
    assert.equal(failedEntry.rows[0]!.count, 0);
    await assert.rejects(
      () => createJournalEntry({ ...args, roleId: randomUUID() }, {
        entryNo: "JE-FORBIDDEN", lines: [{ accountId: cash, debit: 1, credit: 0 }, { accountId: revenue, debit: 0, credit: 1 }],
      }),
      (error: { name?: string }) => error.name === "ForbiddenError",
    );
  } finally {
    await client.query("BEGIN").catch(() => {});
    await setContext(client, userId, null, true).catch(() => {});
    if (businessId) await client.query("DELETE FROM businesses WHERE id = $1", [businessId]);
    if (otherBusinessId) await client.query("DELETE FROM businesses WHERE id = $1", [otherBusinessId]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT").catch(() => client.query("ROLLBACK"));
    client.release();
  }
});

test("inventory reports average cost and low-stock state", async () => {
  const client = await pool.connect();
  const userId = randomUUID();
  let businessId: string | undefined;
  try {
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    await client.query(
      `INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [userId, "Phase 6 Owner", `phase6-${userId}@example.test`, await hashPassword("phase6-password")],
    );
    await client.query("COMMIT");
    businessId = (await createBusiness(userId, { name: `Phase 6 Business ${userId.slice(0, 8)}` })).business.id;
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    const roleId = (await client.query(
      "SELECT role_id FROM business_memberships WHERE user_id = $1 AND business_id = $2", [userId, businessId],
    )).rows[0]!.role_id as string;
    await client.query("COMMIT");
    const args = { userId, businessId, roleId };
    const category = await createCategory(args, "Glass");
    const material = await createMaterial(args, { categoryId: category.id, name: "Bottle", minimumStock: 10 });
    await createAdjustment(args, { materialId: material.id, quantity: 6, unit: "KG", unitCost: 12, direction: "IN" });
    const inventory = await getInventory(args);
    assert.equal(Number(inventory[0]!.quantity_on_hand), 6);
    assert.equal(Number(inventory[0]!.average_cost), 12);
    assert.equal(inventory[0]!.low_stock, true);
  } finally {
    await client.query("BEGIN").catch(() => {});
    await setContext(client, userId, null, true).catch(() => {});
    if (businessId) await client.query("DELETE FROM businesses WHERE id = $1", [businessId]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT").catch(() => client.query("ROLLBACK"));
    client.release();
  }
});

test("inventory adjustments validate inputs, preserve stock, and enforce permissions", async () => {
  const client = await pool.connect();
  const userId = randomUUID();
  let businessId: string | undefined;
  try {
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    await client.query(
      `INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [userId, "Phase 6 Validation", `phase6-validation-${userId}@example.test`, await hashPassword("phase6-password")],
    );
    await client.query("COMMIT");
    businessId = (await createBusiness(userId, { name: `Phase 6 Validation ${userId.slice(0, 8)}` })).business.id;
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    const roleId = (await client.query(
      "SELECT role_id FROM business_memberships WHERE user_id = $1 AND business_id = $2", [userId, businessId],
    )).rows[0]!.role_id as string;
    await client.query("COMMIT");
    const args = { userId, businessId, roleId };
    const category = await createCategory(args, "Validation");
    const material = await createMaterial(args, { categoryId: category.id, name: "Copper" });
    await createAdjustment(args, { materialId: material.id, quantity: 5, unit: "KG", unitCost: 10, direction: "IN" });
    await createAdjustment(args, { materialId: material.id, quantity: 2, unit: "KG", unitCost: 10, direction: "OUT" });
    const concurrentResults = await Promise.allSettled([
      createAdjustment(args, { materialId: material.id, quantity: 2, unit: "KG", unitCost: 10, direction: "OUT" }),
      createAdjustment(args, { materialId: material.id, quantity: 2, unit: "KG", unitCost: 10, direction: "OUT" }),
    ]);
    assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
    await assert.rejects(
      () => createAdjustment(args, { materialId: material.id, quantity: 2, unit: "KG", unitCost: 10, direction: "OUT" }),
      (error: { publicCode?: string; statusCode?: number }) => error.publicCode === "INSUFFICIENT_STOCK" && error.statusCode === 409,
    );
    await assert.rejects(
      () => createAdjustment({ ...args, roleId: randomUUID() }, { materialId: material.id, quantity: 1, unit: "KG", unitCost: 10, direction: "IN" }),
      (error: { name?: string }) => error.name === "ForbiddenError",
    );
    for (const input of [
      { materialId: material.id, quantity: Number.NaN, unit: "KG", unitCost: 1, direction: "IN" },
      { materialId: material.id, quantity: 1, unit: "KG", unitCost: Number.POSITIVE_INFINITY, direction: "IN" },
      { materialId: material.id, quantity: 1, unit: "LITRE", unitCost: 1, direction: "IN" },
      { materialId: material.id, quantity: 1, unit: "KG", unitCost: 1, direction: "SIDEWAYS" },
      { materialId: "not-a-uuid", quantity: 1, unit: "KG", unitCost: 1, direction: "IN" },
    ]) {
      await assert.rejects(() => createAdjustment(args, input), (error: { statusCode?: number }) => error.statusCode === 400);
    }
    const movementCount = await withTenantContext(userId, businessId, (tenantClient) => tenantClient.query(
      "SELECT COUNT(*)::int AS count FROM stock_movements WHERE business_id = $1 AND material_id = $2",
      [businessId, material.id],
    ));
    assert.equal(movementCount.rows[0]!.count, 3);

    const listener = await new Promise<ReturnType<typeof server.listen>>((resolve) => {
      const active = server.listen(0, () => resolve(active));
    });

    try {
      const token = signJwt({ sub: userId, businessId, roleId }, env.jwtSecret, 3600);
      const response = await fetch(`http://127.0.0.1:${(listener.address() as { port: number }).port}/api/inventory`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ materialId: material.id, quantity: 1, unit: "KG", unitCost: 10, direction: "SIDEWAYS" }),
      });
      assert.equal(response.status, 400);
      const responseBody = await response.json() as { code?: string };
      assert.equal(responseBody.code, "INVALID_DIRECTION");
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await client.query("BEGIN").catch(() => {});
    await setContext(client, userId, null, true).catch(() => {});
    if (businessId) await client.query("DELETE FROM businesses WHERE id = $1", [businessId]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT").catch(() => client.query("ROLLBACK"));
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

test("purchase creation calculates totals atomically and tracks transactions", async () => {
  const client = await pool.connect();
  const userId = randomUUID();
  let businessId: string | undefined;
  try {
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    await client.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [userId, "Phase 4 Owner", `phase4-${userId}@example.test`, await hashPassword("phase4-password")],
    );
    await client.query("COMMIT");
    businessId = (await createBusiness(userId, { name: `Phase 4 Business ${userId.slice(0, 8)}` })).business.id;
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    const roleId = (await client.query(
      "SELECT role_id FROM business_memberships WHERE user_id = $1 AND business_id = $2",
      [userId, businessId],
    )).rows[0]!.role_id as string;
    await client.query("COMMIT");
    const args = { userId, businessId, roleId };
    const category = await createCategory(args, "Paper");
    const material = await createMaterial(args, { categoryId: category.id, name: "Cardboard" });
    const worker = await createWorker(args, { name: "Sita", workerCode: "W-004" });
    const result = await createPurchase(args, {
      purchaseNo: `P-${userId.slice(0, 8)}`, workerId: worker.id,
      discount: 10, taxAmount: 5, paidAmount: 20,
      items: [{ materialId: material.id, quantity: 5, unit: "KG", unitPrice: 25 }],
    });

    assert.equal(Number(result.purchase.subtotal), 125);
    assert.equal(Number(result.purchase.total_amount), 120);
    assert.equal(Number(result.purchase.due_amount), 100);
    const usage = await getUsage(userId, businessId, roleId);
    assert.equal(Number(usage.find((row) => row.metric === "transactions")?.value), 1);
  } finally {
    await client.query("BEGIN").catch(() => {});
    await setContext(client, userId, null, true).catch(() => {});
    if (businessId) await client.query("DELETE FROM businesses WHERE id = $1", [businessId]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT").catch(() => client.query("ROLLBACK"));
    client.release();
  }
});

test("sale creation deducts stock and returns gross profit", async () => {
  const client = await pool.connect();
  const userId = randomUUID();
  let businessId: string | undefined;
  try {
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    await client.query(
      `INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [userId, "Phase 5 Owner", `phase5-${userId}@example.test`, await hashPassword("phase5-password")],
    );
    await client.query("COMMIT");
    businessId = (await createBusiness(userId, { name: `Phase 5 Business ${userId.slice(0, 8)}` })).business.id;
    await client.query("BEGIN");
    await setContext(client, userId, null, true);
    const roleId = (await client.query(
      "SELECT role_id FROM business_memberships WHERE user_id = $1 AND business_id = $2", [userId, businessId],
    )).rows[0]!.role_id as string;
    await client.query("COMMIT");
    const args = { userId, businessId, roleId };
    const category = await createCategory(args, "Plastic");
    const material = await createMaterial(args, { categoryId: category.id, name: "PET" });
    const worker = await createWorker(args, { name: "Hari", workerCode: "W-005" });
    await createPurchase(args, {
      purchaseNo: `P-${userId.slice(0, 8)}`, workerId: worker.id,
      items: [{ materialId: material.id, quantity: 10, unit: "KG", unitPrice: 20 }],
    });

    const sale = await createSale(args, {
      saleNo: `S-${userId.slice(0, 8)}`,
      items: [{ materialId: material.id, quantity: 4, unit: "KG", unitPrice: 35 }],
    });

    assert.equal(Number(sale.cogs), 80);
    assert.equal(Number(sale.grossProfit), 60);
    const stock = await withTenantContext(userId, businessId, (tenantClient) => tenantClient.query(
      "SELECT quantity_on_hand FROM current_stock WHERE business_id = $1 AND material_id = $2",
      [businessId, material.id],
    ));
    assert.equal(Number(stock.rows[0]!.quantity_on_hand), 6);
  } finally {
    await client.query("BEGIN").catch(() => {});
    await setContext(client, userId, null, true).catch(() => {});
    if (businessId) await client.query("DELETE FROM businesses WHERE id = $1", [businessId]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT").catch(() => client.query("ROLLBACK"));
    client.release();
  }
});
