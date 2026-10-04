import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLE_NAMES } from "../src/modules/business/roleDefaults.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The authoritative list of permission keys is the seed data in
 * migrations/0001_saas_foundation.sql, not a value copied into this
 * test file — parsed directly from the migration so this test fails
 * loudly if the two ever drift apart (e.g. a key gets renamed in the
 * migration but roleDefaults.ts isn't updated to match).
 */
function loadSeededPermissionKeys(): string[] {
  const migrationPath = join(__dirname, "..", "migrations", "0001_saas_foundation.sql");
  const sql = readFileSync(migrationPath, "utf8");
  const insertBlock = sql.match(/INSERT INTO permissions[\s\S]*?ON CONFLICT/);
  assert.ok(insertBlock, "expected to find the permissions seed INSERT in migration 0001");
  const keys = [...insertBlock![0].matchAll(/\('([a-z_.]+)',/g)].map((m) => m[1] as string);
  assert.ok(keys.length > 0, "expected to parse at least one permission key from migration 0001");
  return keys;
}

test("SYSTEM_ROLE_NAMES contains exactly the four Master Build Prompt roles", () => {
  assert.deepEqual([...SYSTEM_ROLE_NAMES], ["Owner", "Manager", "Data Entry", "Collector"]);
});

test("DEFAULT_ROLE_PERMISSIONS has an entry for every non-Owner system role", () => {
  const nonOwnerRoles = SYSTEM_ROLE_NAMES.filter((r) => r !== "Owner");
  for (const role of nonOwnerRoles) {
    assert.ok(role in DEFAULT_ROLE_PERMISSIONS, `expected a permission list for role "${role}"`);
  }
});

test("every permission key referenced in DEFAULT_ROLE_PERMISSIONS actually exists in the migration 0001 seed", () => {
  const seededKeys = new Set(loadSeededPermissionKeys());
  for (const [role, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    for (const key of keys) {
      assert.ok(seededKeys.has(key), `role "${role}" references permission key "${key}" which is not seeded in migration 0001`);
    }
  }
});

test("migration 0001 seeds exactly 29 permission keys (sanity check on the parser itself)", () => {
  assert.equal(loadSeededPermissionKeys().length, 29);
});

test("no permission key is duplicated within a single role's list", () => {
  for (const [role, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const unique = new Set(keys);
    assert.equal(unique.size, keys.length, `role "${role}" has a duplicate permission key`);
  }
});

test("Manager has strictly more permissions than Data Entry, which has strictly more than Collector", () => {
  const managerCount = DEFAULT_ROLE_PERMISSIONS["Manager"].length;
  const dataEntryCount = DEFAULT_ROLE_PERMISSIONS["Data Entry"].length;
  const collectorCount = DEFAULT_ROLE_PERMISSIONS["Collector"].length;
  assert.ok(managerCount > dataEntryCount, "expected Manager to have more permissions than Data Entry");
  assert.ok(dataEntryCount > collectorCount, "expected Data Entry to have more permissions than Collector");
});

test("business-critical/administrative permissions are excluded from every non-Owner default role", () => {
  const ownerOnlyKeys = ["settings.business.manage", "settings.users.manage", "subscription.manage", "audit_logs.view", "accounting.manage"];
  for (const [role, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    for (const ownerOnlyKey of ownerOnlyKeys) {
      assert.ok(!keys.includes(ownerOnlyKey), `role "${role}" should not default to owner-only permission "${ownerOnlyKey}"`);
    }
  }
});

test("Collector's default permission set is minimal (at most 3 keys)", () => {
  assert.ok(DEFAULT_ROLE_PERMISSIONS["Collector"].length <= 3);
  assert.ok(DEFAULT_ROLE_PERMISSIONS["Collector"].includes("collections.create"));
});
