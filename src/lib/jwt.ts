/**
 * Minimal HMAC-SHA256 JSON Web Token implementation using only Node's
 * built-in `crypto` module — no `jsonwebtoken` dependency required.
 *
 * Implements exactly the subset of the JWT spec this project needs:
 * HS256 signing/verification, `exp`/`iat` claims, and constant-time
 * signature comparison. If broader JWT/JWKS support (RS256, rotating
 * keys, etc.) is needed later, swap this for `jsonwebtoken` or `jose`
 * without changing the call sites in auth.service.ts.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtPayload {
  sub: string; // user id
  [key: string]: unknown;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

export class JwtError extends Error {}
export class JwtExpiredError extends JwtError {}
export class JwtInvalidSignatureError extends JwtError {}
export class JwtMalformedError extends JwtError {}

export function signJwt(payload: JwtPayload, secret: string, expiresInSeconds: number): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(fullPayload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${base64url(signature)}`;
}

export function verifyJwt<T extends JwtPayload = JwtPayload>(token: string, secret: string): T {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JwtMalformedError("Token must have exactly three segments");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac("sha256", secret).update(signingInput).digest();
  const providedSignature = base64urlDecode(encodedSignature);

  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    throw new JwtInvalidSignatureError("Signature verification failed");
  }

  let payload: T;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload).toString("utf8")) as T;
  } catch {
    throw new JwtMalformedError("Payload is not valid JSON");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now >= payload.exp) {
    throw new JwtExpiredError("Token has expired");
  }

  return payload;
}
