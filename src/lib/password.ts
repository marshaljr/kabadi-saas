/**
 * Password hashing built entirely on Node's built-in `crypto` module.
 *
 * We deliberately avoid a dependency like `bcrypt`/`argon2` here so this
 * module has zero install-time requirements — it works identically in any
 * Node 20+ environment. scrypt is a NIST/IETF-recognized, memory-hard KDF
 * and is an accepted choice for password storage (RFC 7914).
 *
 * Format stored in users.password_hash:
 *   scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
 * Encoding the cost parameters alongside the hash lets them be increased
 * later without invalidating already-stored hashes (old hashes keep
 * verifying against the parameters they were created with).
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Wrapped by hand rather than via util.promisify: promisify only
// resolves to the 3-arg (no options) overload of scrypt, and this
// module always needs to pass cost parameters.
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const ALGO_TAG = "scrypt";
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// scrypt cost parameters. N must be a power of two. These values target
// roughly 100-250ms per hash on typical server hardware — deliberately
// expensive enough to slow down offline brute-forcing without making
// login latency noticeable.
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 };

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

function encode(params: ScryptParams, salt: Buffer, hash: Buffer): string {
  return [ALGO_TAG, params.N, params.r, params.p, salt.toString("hex"), hash.toString("hex")].join("$");
}

function decode(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== ALGO_TAG) {
    throw new Error("Unrecognized password hash format");
  }
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts as [string, string, string, string, string, string];
  return {
    params: { N: Number(nStr), r: Number(rStr), p: Number(pStr) },
    salt: Buffer.from(saltHex, "hex"),
    hash: Buffer.from(hashHex, "hex"),
  };
}

export async function hashPassword(plainPassword: string, params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  if (plainPassword.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = (await scrypt(plainPassword, salt, KEY_LENGTH, {
    N: params.N,
    r: params.r,
    p: params.p,
  })) as Buffer;
  return encode(params, salt, derived);
}

export async function verifyPassword(plainPassword: string, storedHash: string): Promise<boolean> {
  let decoded: ReturnType<typeof decode>;
  try {
    decoded = decode(storedHash);
  } catch {
    return false;
  }
  const { params, salt, hash } = decoded;
  const derived = (await scrypt(plainPassword, salt, hash.length, {
    N: params.N,
    r: params.r,
    p: params.p,
  })) as Buffer;

  // timingSafeEqual throws if lengths differ, which would leak timing
  // information about the stored hash length — guard explicitly.
  if (derived.length !== hash.length) return false;
  return timingSafeEqual(derived, hash);
}
