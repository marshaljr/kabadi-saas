/**
 * Platform-admin foundation (Phase 2 scope — Master Build Prompt
 * section 37). Deliberately minimal: a way to check whether a caller
 * is a platform admin, and one read-only cross-tenant listing to
 * prove the withPlatformAdminContext path works end-to-end. No admin
 * dashboard, no business mutation, no user management here — later
 * phases build on this foundation as needed.
 *
 * This is intentionally NOT reachable through any business-scoped
 * route or token. A platform admin's authority comes from a row in
 * `platform_admins` (checked here via withGlobalContext, since that
 * table has no RLS — see migration 0008's note on why), never from a
 * business_memberships role, so it can never be granted accidentally
 * through normal business role management.
 */

import { withGlobalContext, withPlatformAdminContext } from "../../db/tenantContext.js";

export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError"; // reuses authorize.ts's existing 403 mapping in httpError.ts
  }
}

export async function isPlatformAdmin(userId: string): Promise<boolean> {
  return withGlobalContext(async (client) => {
    const result = await client.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = $1) AS exists`, [
      userId,
    ]);
    return Boolean(result.rows[0]?.exists);
  });
}

export async function requirePlatformAdmin(userId: string): Promise<void> {
  if (!(await isPlatformAdmin(userId))) {
    throw new AdminError("Platform admin access required");
  }
}

export interface AdminBusinessSummary {
  id: string;
  name: string;
  createdAt: string;
  onboardingCompletedAt: string | null;
  subscriptionStatus: string | null;
  planCode: string | null;
}

/**
 * Lists every business on the platform, regardless of tenant. Caller
 * must already be a verified platform admin (call requirePlatformAdmin
 * first — this function does not check itself, to keep the RLS
 * context switch and the authorization check independently visible
 * at the call site rather than silently coupled).
 */
export async function listAllBusinesses(adminUserId: string): Promise<AdminBusinessSummary[]> {
  return withPlatformAdminContext(adminUserId, async (client) => {
    const result = await client.query<{
      id: string;
      name: string;
      created_at: string;
      onboarding_completed_at: string | null;
      subscription_status: string | null;
      plan_code: string | null;
    }>(
      `SELECT
         b.id,
         b.name,
         b.created_at,
         b.onboarding_completed_at,
         s.status AS subscription_status,
         p.code AS plan_code
       FROM businesses b
       LEFT JOIN subscriptions s ON s.business_id = b.id
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE b.deleted_at IS NULL
       ORDER BY b.created_at DESC`,
    );

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      onboardingCompletedAt: row.onboarding_completed_at,
      subscriptionStatus: row.subscription_status,
      planCode: row.plan_code,
    }));
  });
}
