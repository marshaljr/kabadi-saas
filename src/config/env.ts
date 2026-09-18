/**
 * Centralized environment configuration.
 *
 * Every environment variable the app depends on is read exactly once,
 * here, and validated eagerly so misconfiguration fails at startup
 * rather than deep inside a request handler. Nothing else in the
 * codebase should call `process.env` directly.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

export interface AppEnv {
  nodeEnv: "development" | "test" | "production";
  port: number;

  databaseUrl: string;
  databaseMigrationUrl: string;
  // the role the app pool connects as. Must NOT be a superuser or the
  // table owner, or Row-Level Security (migration 0008) is silently
  // bypassed for every query.
  databaseAppRole: string;

  jwtSecret: string;
  jwtAccessTokenTtlSeconds: number;

  trialDays: number;
}

function loadEnv(): AppEnv {
  const nodeEnv = optional("NODE_ENV", "development") as AppEnv["nodeEnv"];

  return {
    nodeEnv,
    port: Number(optional("PORT", "3000")),

    databaseUrl: nodeEnv === "test" ? optional("DATABASE_URL", "") : required("DATABASE_URL"),
    databaseMigrationUrl: nodeEnv === "test" ? optional("DATABASE_MIGRATION_URL", "") : required("DATABASE_MIGRATION_URL"),
    databaseAppRole: optional("DATABASE_APP_ROLE", "kabadi_app"),

    jwtSecret: nodeEnv === "test" ? optional("JWT_SECRET", "test-secret-not-for-production") : required("JWT_SECRET"),
    jwtAccessTokenTtlSeconds: Number(optional("JWT_ACCESS_TOKEN_TTL_SECONDS", String(60 * 60 * 8))), // 8h

    trialDays: Number(optional("DEFAULT_TRIAL_DAYS", "14")),
  };
}

export const env = loadEnv();
