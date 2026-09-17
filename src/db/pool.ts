import { Pool } from "pg";
import { env } from "../config/env.js";

/**
 * The single shared connection pool for the application.
 *
 * IMPORTANT: DATABASE_URL must authenticate as `env.databaseAppRole` —
 * a non-superuser, non-table-owner role. Row-Level Security policies
 * (migration 0008) are bypassed entirely for superusers and table
 * owners, so connecting as either of those would silently disable
 * tenant isolation at the database layer, leaving only the
 * application-layer checks in tenantContext.ts as protection.
 */
export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
