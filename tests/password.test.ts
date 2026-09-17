import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "../src/lib/password.js";

test("hashPassword produces a hash that verifyPassword accepts", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assert.equal(await verifyPassword("correct-horse-battery-staple", hash), true);
});

test("verifyPassword rejects a wrong password", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assert.equal(await verifyPassword("wrong-password", hash), false);
});

test("hashPassword rejects passwords under 8 characters", async () => {
  await assert.rejects(() => hashPassword("short"));
});

test("two hashes of the same password are different (random salt)", async () => {
  const a = await hashPassword("correct-horse-battery-staple");
  const b = await hashPassword("correct-horse-battery-staple");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("correct-horse-battery-staple", a), true);
  assert.equal(await verifyPassword("correct-horse-battery-staple", b), true);
});

test("verifyPassword returns false (not throw) for a malformed stored hash", async () => {
  assert.equal(await verifyPassword("anything", "not-a-real-hash"), false);
});

test("verifyPassword returns false for an empty stored hash", async () => {
  assert.equal(await verifyPassword("anything", ""), false);
});
