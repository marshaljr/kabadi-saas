import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { env } from "../../src/config/env.js";
import { signJwt } from "../../src/lib/jwt.js";
import { server } from "../../src/server.js";

/**
 * Lightweight HTTP-level tests for the Phase 2 routes: a real
 * node:http server (the actual `server` exported by src/server.ts,
 * not a stand-in), real requests, real status codes observed over the
 * wire. They complement — they do not replace — the service-level
 * real-DB tests in business-onboarding.test.ts, which own the full
 * onboarding/RLS/rollback/usage/business-switching behavior.
 *
 * Identity tokens are signed with the same secret the server verifies
 * against (env.jwtSecret). JWT verification is purely cryptographic —
 * no user row needs to exist for a token to be accepted — so these
 * tests use random UUIDs as the subject.
 *
 * This file imports src/server.ts, which statically imports the Phase
 * 1 auth module and therefore (transitively) the real `pg` package,
 * so it needs `pg` installed just to load. Once loaded, the first test
 * (name validation -> 400) needs no working database: the name is
 * rejected before any query runs. The second test runs one real query
 * against `platform_admins`, so it needs a reachable database with the
 * migrations applied.
 *
 * Note this file checks the observable HTTP behavior (status + body).
 * It cannot by itself prove that validation happens *before* the
 * database layer is touched — tests/business.validation.test.ts does
 * that, and is verified to fail if the early check is removed.
 *
 * The shared application pool is deliberately NOT closed here; see the
 * note at the end of the business-switching test in
 * business-onboarding.test.ts.
 */

let baseUrl = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  // Kill any keep-alive connections fetch left open so close() can finish.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function identityToken(userId: string = randomUUID()): string {
  return signJwt({ sub: userId }, env.jwtSecret, 300);
}

/**
 * Minimal HTTP client on node:http (rather than global fetch) so this
 * file does not depend on how a given @types/node version types
 * fetch's Response.
 */
function send(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: { error?: string } }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      `${baseUrl}${path}`,
      {
        method,
        agent: false, // no keep-alive: nothing left open for server.close()
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

test("POST /api/businesses with a missing, blank, or non-string name returns 400 (not 401)", async () => {
  const token = identityToken();

  for (const body of [{}, { name: "" }, { name: "   " }, { name: 42 }]) {
    const res = await send("POST", "/api/businesses", token, body);
    assert.equal(res.status, 400, `expected 400 for body ${JSON.stringify(body)}, got ${res.status}`);
    assert.equal(res.json.error, "Business name is required");
  }
});

test("GET /api/admin/businesses as a non-platform-admin returns 403", async () => {
  // A random UUID is by construction not present in platform_admins.
  const res = await send("GET", "/api/admin/businesses", identityToken());

  assert.equal(res.status, 403);
  assert.equal(res.json.error, "Platform admin access required");
});
