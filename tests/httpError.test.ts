import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError, toSafeErrorResponse } from "../src/lib/httpError.js";

/** Minimal stand-ins for AuthError/ForbiddenError, matching them by
 * `.name` (and `.code` for AuthError) the same way toSafeErrorResponse
 * does — this avoids importing modules/auth from a lib/ test, mirroring
 * the intentional no-cycle design of httpError.ts itself. */
function fakeAuthError(code: string, message = "auth error"): Error {
  const err = new Error(message) as Error & { code: string };
  err.name = "AuthError";
  err.code = code;
  return err;
}

function fakeForbiddenError(message = "forbidden"): Error {
  const err = new Error(message);
  err.name = "ForbiddenError";
  return err;
}

test("HttpError is passed through with its own status code and public code", () => {
  const err = new HttpError(418, "I'm a teapot", "TEAPOT");
  const { statusCode, body } = toSafeErrorResponse(err);
  assert.equal(statusCode, 418);
  assert.deepEqual(body, { error: "I'm a teapot", code: "TEAPOT" });
});

test("AuthError with NOT_A_MEMBER maps to 403", () => {
  const { statusCode, body } = toSafeErrorResponse(fakeAuthError("NOT_A_MEMBER", "You are not a member of this business"));
  assert.equal(statusCode, 403);
  assert.equal(body.error, "You are not a member of this business");
});

test("AuthError with MEMBERSHIP_INACTIVE maps to 403", () => {
  const { statusCode } = toSafeErrorResponse(fakeAuthError("MEMBERSHIP_INACTIVE"));
  assert.equal(statusCode, 403);
});

test("AuthError with INVALID_CREDENTIALS maps to 401", () => {
  const { statusCode } = toSafeErrorResponse(fakeAuthError("INVALID_CREDENTIALS"));
  assert.equal(statusCode, 401);
});

test("AuthError with ACCOUNT_INACTIVE maps to 401", () => {
  const { statusCode } = toSafeErrorResponse(fakeAuthError("ACCOUNT_INACTIVE"));
  assert.equal(statusCode, 401);
});

test("AuthError with EMAIL_TAKEN maps to 401", () => {
  const { statusCode } = toSafeErrorResponse(fakeAuthError("EMAIL_TAKEN"));
  assert.equal(statusCode, 401);
});

test("ForbiddenError always maps to 403 regardless of any code", () => {
  const { statusCode } = toSafeErrorResponse(fakeForbiddenError());
  assert.equal(statusCode, 403);
});

test("BusinessError with NAME_REQUIRED maps to 400", () => {
  const err = new Error("Business name is required") as Error & { code: string };
  err.name = "BusinessError";
  err.code = "NAME_REQUIRED";
  const { statusCode, body } = toSafeErrorResponse(err);
  assert.equal(statusCode, 400);
  assert.equal(body.error, "Business name is required");
});

test("BusinessError with INVALID_PLAN maps to 400", () => {
  const err = new Error("Unknown or inactive plan code: BOGUS") as Error & { code: string };
  err.name = "BusinessError";
  err.code = "INVALID_PLAN";
  const { statusCode } = toSafeErrorResponse(err);
  assert.equal(statusCode, 400);
});

test("an unrecognized error maps to 500 with a generic message (no leakage)", () => {
  const { statusCode, body } = toSafeErrorResponse(new Error("some raw internal detail"));
  assert.equal(statusCode, 500);
  assert.equal(body.error, "Something went wrong. Please try again.");
});
