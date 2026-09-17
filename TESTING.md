# Testing

## Running tests

```
npm test
```

Runs `tsx --test tests/*.test.ts`, using Node's built-in test runner
(`node:test`) — no test framework dependency required.

## What's covered in Phase 1

- `tests/password.test.ts` — scrypt hashing round-trips, wrong-password
  rejection, minimum-length validation, salt uniqueness, and safe
  (non-throwing) handling of malformed/empty stored hashes.
- `tests/jwt.test.ts` — sign/verify round-trip with custom claims, wrong
  secret rejected, tampered payload rejected, expired token rejected,
  malformed token rejected, non-JSON payload rejected. Each failure mode
  asserts the specific error subclass (`JwtExpiredError`,
  `JwtInvalidSignatureError`, `JwtMalformedError`) rather than just "it
  throws", so a regression that changes *why* verification failed is
  caught.
- `tests/authorize.test.ts` — `requirePermission`/`hasPermission` against
  a fake `PoolClient` double, covering both the granted and denied paths.

All of the above run without a database connection — they test pure logic
(hashing, signing, and the SQL string this project sends, verified against
a fake result) rather than integration behavior.

## What's explicitly NOT covered yet (needs a live Postgres)

Per the Master Build Prompt's own testing requirements (sections 70-74),
these need a running database and are Phase 2+ work as the corresponding
services get built:

- Tenant isolation test (section 73): create Business A + B, attempt
  cross-tenant access by ID, expect denial. This is the most important
  test to add before Phase 3 — it should exercise the actual RLS policies
  in `migrations/0008_rls_policies.sql`, not just application-layer logic.
- Purchase/sale calculation, partial payment, worker payable, weighted
  average cost, COGS, gross/net profit (sections 70-72).
- Role/permission enforcement against real `role_permissions` rows rather
  than the fake client used in `authorize.test.ts`.
- Migration idempotency (`npm run migrate` twice in a row against the same
  database should be a no-op the second time).

## Recommended next addition

A `tests/integration/` suite that spins up a disposable Postgres schema
(or uses `testcontainers`, once installable), runs all migrations, and
exercises `withTenantContext` directly to prove the RLS policies actually
block cross-tenant reads/writes — not just that the SQL is well-formed.
