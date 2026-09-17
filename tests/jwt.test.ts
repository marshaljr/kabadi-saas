import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  JwtExpiredError,
  JwtInvalidSignatureError,
  JwtMalformedError,
  signJwt,
  verifyJwt,
} from "../src/lib/jwt.js";

const SECRET = "test-secret";

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("signJwt/verifyJwt round-trip preserves custom claims", () => {
  const token = signJwt({ sub: "user-1", businessId: "biz-1", roleId: "role-1" }, SECRET, 3600);
  const payload = verifyJwt(token, SECRET);
  assert.equal(payload.sub, "user-1");
  assert.equal(payload["businessId"], "biz-1");
  assert.equal(payload["roleId"], "role-1");
  assert.equal(typeof payload["iat"], "number");
  assert.equal(typeof payload["exp"], "number");
});

test("verifyJwt rejects a token signed with a different secret", () => {
  const token = signJwt({ sub: "user-1" }, SECRET, 3600);
  assert.throws(() => verifyJwt(token, "a-different-secret"), JwtInvalidSignatureError);
});

test("verifyJwt rejects a tampered payload", () => {
  const token = signJwt({ sub: "user-1" }, SECRET, 3600);
  const parts = token.split(".");
  const header = parts[0]!;
  const signature = parts[2]!;
  const tamperedPayload = b64url(JSON.stringify({ sub: "attacker", exp: 9999999999 }));
  const tampered = `${header}.${tamperedPayload}.${signature}`;
  assert.throws(() => verifyJwt(tampered, SECRET), JwtInvalidSignatureError);
});

test("verifyJwt rejects an expired token", () => {
  const token = signJwt({ sub: "user-1" }, SECRET, -1); // already expired
  assert.throws(() => verifyJwt(token, SECRET), JwtExpiredError);
});

test("verifyJwt rejects a malformed token", () => {
  assert.throws(() => verifyJwt("not.a.validtoken.structure", SECRET), JwtMalformedError);
  assert.throws(() => verifyJwt("onlyonepart", SECRET), JwtMalformedError);
});

test("verifyJwt rejects a token whose payload is not valid JSON", () => {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const bogusPayload = b64url("not-json");
  // sign the (garbage) payload correctly so it passes signature
  // verification and reaches the JSON.parse step
  const sig = b64url(createHmac("sha256", SECRET).update(`${header}.${bogusPayload}`).digest());
  assert.throws(() => verifyJwt(`${header}.${bogusPayload}.${sig}`, SECRET), JwtMalformedError);
});
