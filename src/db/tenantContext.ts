import type { PoolClient } from "pg";
import { pool } from "./pool.js";

/**
 * PostgreSQL's SET/SET LOCAL statements do not accept bind parameters
 * ($1) — they are parsed as utility statements, not queries. We use
 * `set_config(name, value, is_local)` instead, which is a normal
 * function call and therefore parameterizable (and injection-safe).
 * `is_local = true` gives the same "reset at COMMIT/ROLLBACK, never
 * leaks onto a reused pooled connection" behavior as SET LOCAL.
 */
async function setSessionVar(client: PoolClient, name: string, value: string): Promise<void> {
  await client.query("SELECT set_config($1, $2, true)", [name, value]);
}

async function runInTransaction<T>(
  configure: (client: PoolClient) => Promise<void>,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await configure(client);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* connection may already be broken; nothing more to do */
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` inside a single Postgres transaction with the RLS session
 * variables set that migration 0008's policies check:
 *
 *   app.current_user_id      — the authenticated caller (also lets
 *                               the business_memberships "is this my
 *                               own row" clause work)
 *   app.current_business_id  — the caller's authenticated + authorized
 *                               active business (never taken from a
 *                               request body/query param — see
 *                               resolveActiveMembership in
 *                               auth.service.ts)
 *   app.is_platform_admin    — always 'false' here; platform-admin
 *                               routes use withPlatformAdminContext
 *                               instead
 *
 * This is the ONLY sanctioned way application code should talk to the
 * database for tenant-scoped work. Every purchase/sale/payment/etc.
 * service function should be written as a callback passed to this
 * helper, never by calling pool.query directly — that would skip both
 * the transaction boundary (section 55: dependent writes must be
 * atomic) and the RLS context (section 30/73: tenant isolation).
 */
export async function withTenantContext<T>(
  userId: string,
  businessId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return runInTransaction(async (client) => {
    await setSessionVar(client, "app.current_user_id", userId);
    await setSessionVar(client, "app.current_business_id", businessId);
    await setSessionVar(client, "app.is_platform_admin", "false");
  }, fn);
}

/**
 * Runs `fn` with only the authenticated user's identity set (no
 * business selected yet). This is exactly the context the
 * "list my businesses" call after login needs — see the
 * business_memberships RLS policy note in migration 0008.
 */
export async function withUserContext<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTransaction(async (client) => {
    await setSessionVar(client, "app.current_user_id", userId);
    await setSessionVar(client, "app.is_platform_admin", "false");
  }, fn);
}

/**
 * Runs `fn` with platform-admin RLS context — visible across every
 * tenant. Must only ever be invoked from routes that have already
 * verified the caller has a row in `platform_admins` (section 37:
 * never exposed to ordinary business owners).
 */
export async function withPlatformAdminContext<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return runInTransaction(async (client) => {
    await setSessionVar(client, "app.current_user_id", userId);
    await setSessionVar(client, "app.is_platform_admin", "true");
  }, fn);
}

/**
 * Runs `fn` with NO identity/business context at all — for genuinely
 * pre-authentication operations (looking up a user by email during
 * signup/login, before any session exists). Because RLS on every
 * tenant table defaults to deny-all when app.current_business_id is
 * unset, this is safe: such a connection can read/write `users`
 * (which has no RLS policy — it is intentionally global, see
 * migration 0008) but nothing tenant-owned.
 */
export async function withGlobalContext<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTransaction(async () => {
    /* no session variables to set */
  }, fn);
}
