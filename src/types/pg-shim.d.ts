/**
 * TEMPORARY SHIM — DELETE THIS FILE after running `npm install`.
 *
 * This project's real dependency is the `pg` package (declared in
 * package.json) plus `@types/pg` for its types. The sandbox this code
 * was authored in has no network access, so `node_modules` cannot be
 * populated here. This file provides just enough of `pg`'s shape for
 * `tsc --noEmit` to succeed against src/db/*.ts without those packages
 * installed.
 *
 * Once you run `npm install` on a machine with network access, delete
 * this file — the real `@types/pg` package takes over and this shim
 * would otherwise cause duplicate-declaration conflicts.
 */

declare module "pg" {
  export interface QueryResultRow {
    [column: string]: unknown;
  }

  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    rows: R[];
    rowCount: number | null;
  }

  export interface PoolClient {
    query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values?: unknown[],
    ): Promise<QueryResult<R>>;
    release(err?: Error | boolean): void;
  }

  export interface PoolConfig {
    connectionString?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values?: unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
}
