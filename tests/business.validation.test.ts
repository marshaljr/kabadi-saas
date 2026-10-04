import assert from "node:assert/strict";
import { test } from "node:test";
import { createBusinessTx, BusinessError } from "../src/modules/business/business.service.js";

/**
 * A PoolClient stand-in that throws if `.query()` is ever called. Used
 * to prove that invalid-name rejection happens before createBusinessTx
 * touches the database at all — these tests need no real Postgres
 * connection and genuinely run in any environment.
 */
function unusablePoolClient() {
  return {
    query: async () => {
      throw new Error("client.query must not be called: name validation should reject before any database access");
    },
    release: () => {},
  } as any;
}

test("createBusinessTx rejects a missing name with BusinessError NAME_REQUIRED, without touching the database", async () => {
  const client = unusablePoolClient();
  await assert.rejects(
    () => createBusinessTx(client, "user-1", "biz-1", { name: undefined as unknown as string }),
    (err: unknown) => err instanceof BusinessError && err.code === "NAME_REQUIRED",
  );
});

test("createBusinessTx rejects an empty string name with BusinessError NAME_REQUIRED", async () => {
  const client = unusablePoolClient();
  await assert.rejects(
    () => createBusinessTx(client, "user-1", "biz-1", { name: "" }),
    (err: unknown) => err instanceof BusinessError && err.code === "NAME_REQUIRED",
  );
});

test("createBusinessTx rejects a whitespace-only name with BusinessError NAME_REQUIRED", async () => {
  const client = unusablePoolClient();
  await assert.rejects(
    () => createBusinessTx(client, "user-1", "biz-1", { name: "   " }),
    (err: unknown) => err instanceof BusinessError && err.code === "NAME_REQUIRED",
  );
});

test("createBusinessTx rejects a non-string name without throwing an unrelated TypeError", async () => {
  const client = unusablePoolClient();
  // Simulates a malformed request body (e.g. { "name": 42 }) reaching
  // this far — the HTTP boundary in server.ts already coerces
  // non-strings to "", but this test guards the service function
  // itself against ever regressing to a raw `.trim()`-on-non-string
  // crash (which would previously have surfaced as an opaque 500
  // instead of a clean 400).
  await assert.rejects(
    () => createBusinessTx(client, "user-1", "biz-1", { name: 42 as unknown as string }),
    (err: unknown) => err instanceof BusinessError && err.code === "NAME_REQUIRED",
  );
});

test("createBusiness rejects an invalid name before loading the database layer at all", async () => {
  // createBusiness dynamically imports db/tenantContext.js (and through it
  // the real `pg` package) only AFTER validating the name. So an invalid
  // name must reject with BusinessError even where that import cannot
  // succeed. If the early validateBusinessName() call were removed, this
  // would instead reject with the import failure (or, where pg is
  // installed, would acquire a connection first), not BusinessError.
  const { createBusiness } = await import("../src/modules/business/business.service.js");
  for (const name of ["", "   ", undefined as unknown as string, 42 as unknown as string]) {
    await assert.rejects(
      () => createBusiness("user-1", { name }),
      (err: unknown) => err instanceof BusinessError && err.code === "NAME_REQUIRED",
    );
  }
});
