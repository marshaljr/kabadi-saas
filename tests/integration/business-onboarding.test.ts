import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../../src/db/pool.js";
import { withTenantContext } from "../../src/db/tenantContext.js";
import { createBusinessTx, seedDefaultRoles, assignDefaultPermissions } from "../../src/modules/business/business.service.js";
import { selectActiveBusiness } from "../../src/modules/auth/auth.service.js";
import { requirePermission, hasPermission } from "../../src/middleware/authorize.js";
import { DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLE_NAMES } from "../../src/modules/business/roleDefaults.js";

/** Matches the setContext helper in tests/integration/tenant-isolation.test.ts. */
async function setContext(client: PoolClient, userId: string, businessId: string | null, isPlatformAdmin: boolean) {
  await client.query("SELECT set_config($1, $2, true)", ["app.current_user_id", userId]);
  await client.query("SELECT set_config($1, $2, true)", ["app.current_business_id", businessId ?? ""]);
  await client.query("SELECT set_config($1, $2, true)", ["app.is_platform_admin", String(isPlatformAdmin)]);
}

async function assertRlsBlocked(client: PoolClient, query: string, values: unknown[]) {
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

// ================================================================
// TEST 1 — full success path, every onboarding piece present
// ================================================================
test("createBusinessTx performs a complete, atomic onboarding", async () => {
  const client = await pool.connect();
  const userId = randomUUID();
  const businessId = randomUUID();

  try {
    await client.query("BEGIN");

    // users has no RLS (intentionally global — see migration 0008),
    // so this insert needs no special context, but we still need a
    // real row to satisfy business_memberships' FK on user_id.
    await client.query(`INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`, [
      userId,
      "Onboarding Test Owner",
      `onboarding-test-${userId}@example.com`,
      "not-a-real-hash",
    ]);

    // Set the RLS context to the business id BEFORE it exists as a
    // row — this is exactly what withTenantContext does in
    // production (see business.service.ts's design note); the
    // businesses table's INSERT policy is application-gated
    // (WITH CHECK (TRUE)), not RLS-gated, which is what makes this
    // safe.
    await setContext(client, userId, businessId, false);

    const result = await createBusinessTx(client, userId, businessId, { name: "Onboarding Test Kabadi Yard" });

    // --- returned summary shape ---
    assert.equal(result.business.name, "Onboarding Test Kabadi Yard");
    assert.equal(result.business.currencyCode, "NPR");
    assert.equal(result.business.languageCode, "en");
    assert.equal(result.business.timezone, "Asia/Kathmandu");
    assert.equal(result.membership.roleName, "Owner");
    assert.equal(result.subscription.planCode, "FREE");
    assert.equal(result.subscription.status, "TRIALING");
    assert.ok(new Date(result.subscription.trialEndsAt).getTime() > Date.now());

    // --- default roles: all four, exactly once each ---
    const roles = await client.query<{ name: string }>(`SELECT name FROM roles WHERE business_id = $1 ORDER BY name`, [businessId]);
    assert.deepEqual(
      roles.rows.map((r) => r.name).sort(),
      [...SYSTEM_ROLE_NAMES].sort(),
    );

    // --- default permissions: Owner has every catalog permission ---
    const permCount = await client.query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM permissions`);
    const ownerPermCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.business_id = $1 AND r.name = 'Owner'`,
      [businessId],
    );
    assert.equal(Number(ownerPermCount.rows[0]!.count), Number(permCount.rows[0]!.count));
    assert.ok(Number(ownerPermCount.rows[0]!.count) > 0);

    // --- default permissions: Manager/Data Entry/Collector match roleDefaults.ts exactly ---
    for (const [roleName, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      const roleCount = await client.query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.business_id = $1 AND r.name = $2`,
        [businessId, roleName],
      );
      assert.equal(Number(roleCount.rows[0]!.count), keys.length, `expected ${roleName} to have exactly ${keys.length} permissions`);
    }

    // --- owner membership ---
    const membership = await client.query<{ status: string; role_name: string }>(
      `SELECT bm.status, r.name AS role_name FROM business_memberships bm JOIN roles r ON r.id = bm.role_id WHERE bm.user_id = $1 AND bm.business_id = $2`,
      [userId, businessId],
    );
    assert.equal(membership.rowCount, 1);
    assert.equal(membership.rows[0]!.status, "ACTIVE");
    assert.equal(membership.rows[0]!.role_name, "Owner");

    // --- default accounting setup (existing seed_default_accounts(), not duplicated) ---
    const accounts = await client.query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM accounts WHERE business_id = $1`, [
      businessId,
    ]);
    assert.equal(Number(accounts.rows[0]!.count), 18);
    const cashAccount = await client.query(`SELECT id FROM accounts WHERE business_id = $1 AND account_code = '1000'`, [businessId]);
    assert.equal(cashAccount.rowCount, 1);

    // --- trial subscription + event ---
    const subscription = await client.query<{ id: string; status: string }>(`SELECT id, status FROM subscriptions WHERE business_id = $1`, [
      businessId,
    ]);
    assert.equal(subscription.rowCount, 1);
    assert.equal(subscription.rows[0]!.status, "TRIALING");
    const events = await client.query(`SELECT event_type FROM subscription_events WHERE subscription_id = $1`, [
      subscription.rows[0]!.id,
    ]);
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0]!.event_type, "TRIAL_STARTED");

    // --- usage tracking initialized ---
    const usage = await client.query<{ metric: string; value: string }>(`SELECT metric, value FROM usage_records WHERE business_id = $1`, [
      businessId,
    ]);
    assert.equal(usage.rowCount, 1);
    assert.equal(usage.rows[0]!.metric, "users");
    assert.equal(Number(usage.rows[0]!.value), 1);

    // --- active business set, onboarding marked complete ---
    const user = await client.query<{ last_active_business_id: string }>(`SELECT last_active_business_id FROM users WHERE id = $1`, [
      userId,
    ]);
    assert.equal(user.rows[0]!.last_active_business_id, businessId);
    const business = await client.query<{ onboarding_completed_at: string | null }>(
      `SELECT onboarding_completed_at FROM businesses WHERE id = $1`,
      [businessId],
    );
    assert.ok(business.rows[0]!.onboarding_completed_at !== null);

    // --- permission enforcement reflects the freshly seeded roles (reuses existing authorize.ts, not reimplemented) ---
    const ownerRoleRow = await client.query<{ id: string }>(`SELECT id FROM roles WHERE business_id=$1 AND name='Owner'`, [businessId]);
    const collectorRoleRow = await client.query<{ id: string }>(`SELECT id FROM roles WHERE business_id=$1 AND name='Collector'`, [
      businessId,
    ]);
    const ownerRoleId = ownerRoleRow.rows[0]!.id;
    const collectorRoleId = collectorRoleRow.rows[0]!.id;
    await assert.doesNotReject(() => requirePermission(client, ownerRoleId, "settings.users.manage"));
    assert.equal(await hasPermission(client, collectorRoleId, "settings.users.manage"), false);
    assert.equal(await hasPermission(client, collectorRoleId, "collections.create"), true);

    await client.query("ROLLBACK"); // nothing persists
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

// ================================================================
// TEST 2 — atomic rollback proof (explicit requirement)
// ================================================================
test("createBusiness rolls back the ENTIRE onboarding when a later step fails", async () => {
  const setupClient = await pool.connect();
  const userId = randomUUID();
  const businessId = randomUUID();

  // A real, committed user row is required so the failure happens
  // *after* several real writes (business, roles, permissions,
  // membership, accounts) rather than failing before anything was
  // written — otherwise this wouldn't actually prove rollback
  // behavior, just early validation.
  try {
    await setupClient.query(`INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`, [
      userId,
      "Rollback Test Owner",
      `rollback-test-${userId}@example.com`,
      "not-a-real-hash",
    ]);
  } finally {
    setupClient.release();
  }

  try {
    // Calling withTenantContext + createBusinessTx directly (rather
    // than the public createBusiness()) so this test knows the
    // businessId in advance and can verify nothing persisted for it —
    // this is the exact same code path createBusiness() uses
    // internally, not a reimplementation.
    await assert.rejects(
      () =>
        withTenantContext(userId, businessId, (client) =>
          createBusinessTx(client, userId, businessId, { name: "Should Not Persist", planCode: "NONEXISTENT_PLAN_CODE" }),
        ),
      /Unknown or inactive plan code/,
    );

    // Verify via a fresh platform-admin-context connection (a
    // different connection than the one createBusinessTx used, so
    // this is a genuine post-rollback check, not a same-transaction
    // "uncommitted writes are still visible to themselves" artifact).
    const verifyClient = await pool.connect();
    try {
      await verifyClient.query("BEGIN");
      await setContext(verifyClient, userId, null, true); // platform admin: sees across all businesses

      const business = await verifyClient.query(`SELECT id FROM businesses WHERE id = $1`, [businessId]);
      assert.equal(business.rowCount, 0, "business row must not exist after rollback");

      const roles = await verifyClient.query(`SELECT id FROM roles WHERE business_id = $1`, [businessId]);
      assert.equal(roles.rowCount, 0, "no roles must exist after rollback");

      const memberships = await verifyClient.query(`SELECT id FROM business_memberships WHERE business_id = $1`, [businessId]);
      assert.equal(memberships.rowCount, 0, "no membership must exist after rollback");

      const accounts = await verifyClient.query(`SELECT id FROM accounts WHERE business_id = $1`, [businessId]);
      assert.equal(accounts.rowCount, 0, "no accounts must exist after rollback");

      const subscriptions = await verifyClient.query(`SELECT id FROM subscriptions WHERE business_id = $1`, [businessId]);
      assert.equal(subscriptions.rowCount, 0, "no subscription must exist after rollback");

      const usage = await verifyClient.query(`SELECT id FROM usage_records WHERE business_id = $1`, [businessId]);
      assert.equal(usage.rowCount, 0, "no usage record must exist after rollback");

      await verifyClient.query("ROLLBACK");
    } finally {
      verifyClient.release();
    }
  } finally {
    // The only thing that actually committed was the setup user —
    // clean it up. users has no RLS, so a plain DELETE works from any
    // context.
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query(`DELETE FROM users WHERE id = $1`, [userId]);
    } finally {
      cleanupClient.release();
    }
  }
});

// ================================================================
// TEST 3 — idempotent seeding (not full onboarding retry-safety —
// see the module doc comments for why full request-level idempotency
// is out of scope for this phase)
// ================================================================
test("seedDefaultRoles and assignDefaultPermissions are idempotent when called twice", async () => {
  const client = await pool.connect();
  const userId = randomUUID();
  const businessId = randomUUID();

  try {
    await client.query("BEGIN");
    await setContext(client, userId, businessId, false);
    await client.query(`INSERT INTO businesses (id, name) VALUES ($1, $2)`, [businessId, "Idempotency Test Business"]);

    const firstPass = await seedDefaultRoles(client, businessId);
    await assignDefaultPermissions(client, firstPass);

    const secondPass = await seedDefaultRoles(client, businessId);
    await assignDefaultPermissions(client, secondPass);

    // same role ids both times — no duplicates were created
    assert.deepEqual([...firstPass.entries()].sort(), [...secondPass.entries()].sort());

    const roleCount = await client.query(`SELECT COUNT(*)::int AS count FROM roles WHERE business_id = $1`, [businessId]);
    assert.equal((roleCount.rows[0] as any).count, 4);

    const ownerRoleId = firstPass.get("Owner")!;
    const permCount = await client.query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM permissions`);
    const ownerPermCount = await client.query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM role_permissions WHERE role_id = $1`, [
      ownerRoleId,
    ]);
    // still exactly one row per permission, not two, after calling
    // assignDefaultPermissions twice
    assert.equal(Number(ownerPermCount.rows[0]!.count), Number(permCount.rows[0]!.count));

    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

// ================================================================
// TEST 4 — RLS tenant isolation for the new Phase 2 tables
// ================================================================
test("RLS prevents cross-tenant usage_records and subscriptions access", async () => {
  const client = await pool.connect();
  const businessA = randomUUID();
  const businessB = randomUUID();
  const userId = randomUUID();

  try {
    await client.query("BEGIN");
    await setContext(client, userId, null, true); // platform admin to seed fixtures

    await client.query(`INSERT INTO businesses (id, name) VALUES ($1, $2), ($3, $4)`, [
      businessA,
      `Usage RLS Test A ${businessA.slice(0, 8)}`,
      businessB,
      `Usage RLS Test B ${businessB.slice(0, 8)}`,
    ]);

    const freePlan = await client.query<{ id: string }>(`SELECT id FROM plans WHERE code = 'FREE'`);
    const planId = freePlan.rows[0]!.id;

    await client.query(
      `INSERT INTO subscriptions (business_id, plan_id, status) VALUES ($1, $2, 'TRIALING'), ($3, $2, 'TRIALING')`,
      [businessA, planId, businessB],
    );

    await client.query(
      `INSERT INTO usage_records (business_id, period_start, metric, value)
       VALUES ($1, date_trunc('month', now())::date, 'users', 1), ($2, date_trunc('month', now())::date, 'users', 1)`,
      [businessA, businessB],
    );

    // ---- Business A context ----
    await setContext(client, userId, businessA, false);

    const aUsage = await client.query(`SELECT business_id FROM usage_records ORDER BY business_id`);
    assert.equal(aUsage.rowCount, 1);
    assert.equal(aUsage.rows[0]!.business_id, businessA);

    const aSubs = await client.query(`SELECT business_id FROM subscriptions ORDER BY business_id`);
    assert.equal(aSubs.rowCount, 1);
    assert.equal(aSubs.rows[0]!.business_id, businessA);

    const hiddenBUsage = await client.query(`SELECT id FROM usage_records WHERE business_id = $1`, [businessB]);
    assert.equal(hiddenBUsage.rowCount, 0);

    await assertRlsBlocked(
      client,
      `INSERT INTO usage_records (business_id, period_start, metric, value) VALUES ($1, date_trunc('month', now())::date, 'illegal', 1)`,
      [businessB],
    );

    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

// ================================================================
// TEST 5 — business switching, using a minimal fixture
//
// This deliberately does NOT go through the full createBusiness()
// onboarding (roles x4, ~29 role_permissions, 18 accounts,
// subscription, event, usage record) — this test is about
// selectActiveBusiness, not about onboarding correctness (Test 1
// already covers that in full). Using a minimal business + one role +
// one membership means cleanup only has to deal with a handful of
// rows instead of an entire tenant's worth of data.
//
// CLEANUP STRATEGY: business_memberships and roles both support real
// DELETE under platform-admin RLS context (the generic tenant_isolation
// policy created in migrations/0008_rls_policies.sql has no explicit
// FOR clause, so it defaults to FOR ALL — SELECT/INSERT/UPDATE/DELETE
// alike). `businesses` is the one exception: it was deliberately given
// separate SELECT/UPDATE/INSERT-only policies with no DELETE policy at
// all, because deleted_at soft-delete is the table's intended pattern
// (see DATABASE.md) — production behavior that this test does NOT
// weaken or work around. So: hard-delete the membership and role rows
// for real, and soft-delete (archive) the business row itself, exactly
// as a real "close this business" operation would have to. That
// leaves exactly one soft-deleted, empty business row behind per test
// run instead of a full tenant's worth of live-looking data.
// ================================================================
test("business switching: owner can select, non-member cannot, inactive membership cannot", async () => {
  const ownerId = randomUUID();
  const outsiderId = randomUUID();
  const businessId = randomUUID();
  const roleId = randomUUID();

  const setupClient = await pool.connect();
  try {
    await setupClient.query("BEGIN");
    await setContext(setupClient, ownerId, null, true); // platform admin, to freely construct the fixture

    await setupClient.query(`INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`, [
      ownerId,
      "Switch Test Owner",
      `switch-test-owner-${ownerId}@example.com`,
      "not-a-real-hash",
      outsiderId,
      "Switch Test Outsider",
      `switch-test-outsider-${outsiderId}@example.com`,
      "not-a-real-hash",
    ]);
    await setupClient.query(`INSERT INTO businesses (id, name) VALUES ($1, $2)`, [
      businessId,
      `Switch Test Business ${businessId.slice(0, 8)}`,
    ]);
    await setupClient.query(`INSERT INTO roles (id, business_id, name, is_system_role) VALUES ($1, $2, 'Owner', TRUE)`, [
      roleId,
      businessId,
    ]);
    await setupClient.query(`INSERT INTO business_memberships (user_id, business_id, role_id, status) VALUES ($1, $2, $3, 'ACTIVE')`, [
      ownerId,
      businessId,
      roleId,
    ]);

    await setupClient.query("COMMIT");
  } catch (error) {
    await setupClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    setupClient.release();
  }

  try {
    // owner CAN select their own business
    const ownerSession = await selectActiveBusiness(ownerId, businessId);
    assert.ok(ownerSession.accessToken);
    assert.equal(ownerSession.roleName, "Owner");

    // a non-member CANNOT select it
    await assert.rejects(() => selectActiveBusiness(outsiderId, businessId), /not a member/);

    // an inactive membership CANNOT select it
    const adminClient = await pool.connect();
    try {
      await adminClient.query("BEGIN");
      await setContext(adminClient, ownerId, null, true);
      await adminClient.query(`UPDATE business_memberships SET status = 'SUSPENDED' WHERE user_id = $1 AND business_id = $2`, [
        ownerId,
        businessId,
      ]);
      await adminClient.query("COMMIT");
    } catch (e) {
      await adminClient.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      adminClient.release();
    }

    await assert.rejects(() => selectActiveBusiness(ownerId, businessId), /not active/);
  } finally {
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query("BEGIN");
      await setContext(cleanupClient, ownerId, null, true);

      // Real hard deletes — both tables support DELETE under
      // platform-admin RLS context (see comment above the test).
      await cleanupClient.query(`DELETE FROM business_memberships WHERE business_id = $1`, [businessId]);
      await cleanupClient.query(`DELETE FROM roles WHERE business_id = $1`, [businessId]);

      // businesses cannot be hard-deleted by design (no DELETE
      // policy exists for this table at all) — soft-delete is the
      // correct and only available cleanup here, matching exactly
      // what a real "archive this business" operation would do.
      await cleanupClient.query(`UPDATE businesses SET deleted_at = now() WHERE id = $1`, [businessId]);

      await cleanupClient.query("COMMIT");
    } catch {
      await cleanupClient.query("ROLLBACK").catch(() => {});
    } finally {
      cleanupClient.release();
    }

    const finalClient = await pool.connect();
    try {
      // users has no RLS — a plain DELETE from any context is fine,
      // and fully removes these two rows, no residue at all.
      await finalClient.query(`DELETE FROM users WHERE id = ANY($1)`, [[ownerId, outsiderId]]);
    } finally {
      finalClient.release();
    }

    // Deliberately NOT calling pool.end() here: `pool` is the shared
    // application connection pool (src/db/pool.ts), not a resource
    // this individual test owns. Closing it would break any other
    // test that happens to run in the same process after this one, or
    // — in a context where `pool` is reused beyond test runs — the
    // application itself. Each test in this file releases its own
    // client(s) back to the pool; the pool as a whole is left open for
    // whoever else needs it.
  }
});
