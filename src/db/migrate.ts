/**
 * Migration runner.
 *
 * Applies every .sql file in /migrations, in filename order, that has
 * not already been recorded in schema_migrations. Each file runs
 * inside its own transaction so a failing migration never leaves the
 * schema half-applied.
 *
 * This connects as whatever DATABASE_URL specifies. In practice that
 * should be a migration-owner role with DDL rights — NOT the RLS
 * -restricted app role that src/db/pool.ts uses for request handling
 * (see the note in db/tenantContext.ts about superusers/owners
 * bypassing RLS: it's fine, even necessary, for *this* script, since
 * granting the app role DDL rights would be a much bigger risk).
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run migrate
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { env } from "../config/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  return new Set(result.rows.map((r) => r.filename));
}

export async function runMigrations(): Promise<void> {
  const pool = new Pool({ connectionString: env.databaseUrl });

  try {
    await ensureMigrationsTable(pool);
    const applied = await getAppliedMigrations(pool);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort(); // numeric filename prefixes (0001_, 0002_, ...) sort correctly as strings

    let appliedCount = 0;

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip   ${file} (already applied)`);
        continue;
      }

      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`  apply  ${file}`);
        appliedCount++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  FAILED ${file}`);
        throw err;
      } finally {
        client.release();
      }
    }

    console.log(`\nMigrations complete. ${appliedCount} applied, ${files.length - appliedCount} already up to date.`);
  } finally {
    await pool.end();
  }
}

// Run directly when invoked as a script (`npm run migrate`), but stay
// importable for tests that want to run migrations against a
// throwaway test database.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runMigrations().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
