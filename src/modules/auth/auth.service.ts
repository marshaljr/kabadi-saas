/**
 * Authentication foundation (Phase 1 scope).
 *
 * Deliberately covers only: global signup/login, listing the
 * businesses a user belongs to, and exchanging a chosen business for
 * a business-scoped access token. Creating a *new* business
 * (onboarding: seeding roles/accounts/subscription) is Phase 2 work
 * per the phased build plan and is not implemented here — the
 * migrations already support it (business_memberships,
 * seed_default_accounts(), plans/subscriptions), but the onboarding
 * service itself is out of scope for this phase.
 */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../../config/env.js";
import { withGlobalContext, withUserContext } from "../../db/tenantContext.js";
import { signJwt, verifyJwt, type JwtPayload } from "../../lib/jwt.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: "EMAIL_TAKEN" | "INVALID_CREDENTIALS" | "ACCOUNT_INACTIVE" | "NOT_A_MEMBER" | "MEMBERSHIP_INACTIVE",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  status: string;
}

export interface SignupInput {
  name: string;
  email: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface MembershipSummary {
  businessId: string;
  businessName: string;
  roleId: string;
  roleName: string;
  membershipStatus: string;
}

/** Access-token payload once a business context has been selected. */
export interface BusinessScopedTokenPayload extends JwtPayload {
  sub: string; // user id
  businessId: string;
  roleId: string;
}

/** Access-token payload for an authenticated user with no business selected yet. */
export interface IdentityTokenPayload extends JwtPayload {
  sub: string; // user id
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toPublicUser(row: { id: string; name: string; email: string; status: string }): PublicUser {
  return { id: row.id, name: row.name, email: row.email, status: row.status };
}

export async function signup(input: SignupInput): Promise<{ user: PublicUser; identityToken: string }> {
  const email = normalizeEmail(input.email);

  return withGlobalContext(async (client: PoolClient) => {
    const existing = await client.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rowCount && existing.rowCount > 0) {
      throw new AuthError("An account with this email already exists", "EMAIL_TAKEN");
    }

    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();

    const result = await client.query<{ id: string; name: string; email: string; status: string }>(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, status`,
      [id, input.name.trim(), email, passwordHash],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to create user");
    }
    const user = toPublicUser(row);
    const identityToken = signJwt({ sub: user.id }, env.jwtSecret, env.jwtAccessTokenTtlSeconds);
    return { user, identityToken };
  });
}

export async function login(input: LoginInput): Promise<{ user: PublicUser; identityToken: string }> {
  const email = normalizeEmail(input.email);

  return withGlobalContext(async (client: PoolClient) => {
    const result = await client.query<{
      id: string;
      name: string;
      email: string;
      status: string;
      password_hash: string;
    }>("SELECT id, name, email, status, password_hash FROM users WHERE email = $1", [email]);

    const row = result.rows[0];
    // Deliberately identical error for "no such email" and "wrong
    // password" so login cannot be used to enumerate registered
    // emails.
    if (!row) {
      throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS");
    }

    const passwordOk = await verifyPassword(input.password, row.password_hash);
    if (!passwordOk) {
      throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS");
    }

    if (row.status !== "ACTIVE") {
      throw new AuthError("This account is not active", "ACCOUNT_INACTIVE");
    }

    await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [row.id]);

    const user = toPublicUser(row);
    const identityToken = signJwt({ sub: user.id }, env.jwtSecret, env.jwtAccessTokenTtlSeconds);
    return { user, identityToken };
  });
}

/**
 * Lists the businesses the authenticated user belongs to, so the
 * client can render a business switcher / decide whether onboarding
 * is needed. Uses withUserContext (no business selected) — see the
 * business_memberships RLS policy note in migration 0008 for why
 * this query is allowed to see rows across businesses despite RLS
 * being enabled on that table.
 */
export async function listMyBusinesses(userId: string): Promise<MembershipSummary[]> {
  return withUserContext(userId, async (client) => {
    const result = await client.query<{
      business_id: string;
      business_name: string;
      role_id: string;
      role_name: string;
      status: string;
    }>(
      `SELECT
         bm.business_id,
         b.name AS business_name,
         bm.role_id,
         r.name AS role_name,
         bm.status
       FROM business_memberships bm
       JOIN businesses b ON b.id = bm.business_id
       JOIN roles r ON r.id = bm.role_id
       WHERE bm.user_id = $1
       ORDER BY bm.joined_at ASC`,
      [userId],
    );

    return result.rows.map((row) => ({
      businessId: row.business_id,
      businessName: row.business_name,
      roleId: row.role_id,
      roleName: row.role_name,
      membershipStatus: row.status,
    }));
  });
}

/**
 * Exchanges an authenticated identity for a business-scoped access
 * token, after verifying the user actually holds an ACTIVE
 * membership in that business. This — not anything the client
 * sends in a request body — is the only path by which a
 * business_id ends up trusted for subsequent tenant-scoped requests
 * (section 30: never trust the frontend's business_id).
 */
export async function selectActiveBusiness(
  userId: string,
  businessId: string,
): Promise<{ accessToken: string; roleId: string; roleName: string }> {
  return withUserContext(userId, async (client) => {
    const result = await client.query<{ role_id: string; role_name: string; status: string }>(
      `SELECT bm.role_id, r.name AS role_name, bm.status
       FROM business_memberships bm
       JOIN roles r ON r.id = bm.role_id
       WHERE bm.user_id = $1 AND bm.business_id = $2`,
      [userId, businessId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new AuthError("You are not a member of this business", "NOT_A_MEMBER");
    }
    if (row.status !== "ACTIVE") {
      throw new AuthError("Your membership in this business is not active", "MEMBERSHIP_INACTIVE");
    }

    await client.query("UPDATE users SET last_active_business_id = $1 WHERE id = $2", [businessId, userId]);

    const accessToken = signJwt(
      { sub: userId, businessId, roleId: row.role_id } satisfies BusinessScopedTokenPayload,
      env.jwtSecret,
      env.jwtAccessTokenTtlSeconds,
    );

    return { accessToken, roleId: row.role_id, roleName: row.role_name };
  });
}

export function verifyIdentityToken(token: string): IdentityTokenPayload {
  return verifyJwt<IdentityTokenPayload>(token, env.jwtSecret);
}

export function verifyBusinessScopedToken(token: string): BusinessScopedTokenPayload {
  const payload = verifyJwt<BusinessScopedTokenPayload>(token, env.jwtSecret);
  if (!payload.businessId || !payload.roleId) {
    throw new Error("Token is not business-scoped");
  }
  return payload;
}
