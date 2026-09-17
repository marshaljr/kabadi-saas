# Kabadi SaaS

Multi-tenant SaaS platform for Kabadi/Khabar scrap-collection businesses in
Nepal. Core workflow: **Worker/Collector → Material Collection → Weight →
Rate/kg → Amount → Worker Payment/Payable → Stock → Sale → COGS →
Profit/Loss.**

See `CLAUDE_MASTER_BUILD_PROMPT.md` for the full product spec and
`ARCHITECTURE.md` for how the SaaS/multi-tenant data model was corrected
against that spec before implementation began.

## Status

**Phase 1 (project foundation + authentication foundation) is complete.**
See `DEVELOPMENT_STATUS.md` for exactly what that does and does not include,
and `NEXT_STEPS.md` for what Phase 2 covers next.

## Stack (Phase 1)

- **Language:** TypeScript (strict mode), Node.js 20+, ES modules
- **Database:** PostgreSQL 15+ with Row-Level Security
- **Auth:** Node's built-in `crypto` for password hashing (scrypt) and JWT
  signing (HMAC-SHA256) — zero external auth dependencies
- **HTTP:** Node's built-in `http` module for now (see note below)

> **Why not Express/pg installed yet?** This project was authored in a
> network-isolated sandbox that could not reach the npm registry. Every
> file that would normally depend on `pg` is written against the real `pg`
> API and will work unchanged once you run `npm install` on a machine with
> network access — see "Getting a real environment running" below. The
> HTTP layer currently uses Node's built-in `http` module rather than
> Express/Fastify (section 56 of the master prompt) for the same reason;
> swapping it in is a mechanical change since route handlers are already
> small, framework-agnostic async functions (`src/server.ts`).

## Project layout

```
migrations/           Numbered, ordered SQL migrations (0001-0008)
docs/ERD.mermaid       Versioned ERD source (regenerate PNG with mmdc)
src/
  config/env.ts        Centralized environment variable loading
  db/                   pool.ts, migrate.ts, tenantContext.ts (RLS-aware
                         transaction helpers), seed.ts (stub, Phase 3+)
  lib/                  password.ts, jwt.ts, httpError.ts — dependency-free
  middleware/authorize.ts   Backend permission checks (never trust the
                             frontend for authorization — section 32)
  modules/auth/auth.service.ts   signup / login / list businesses /
                                   select active business
  server.ts             Wires auth endpoints over plain node:http
tests/                 node:test unit tests (run with `npm test`)
```

## Getting a real environment running

1. **Install dependencies** (needs network access this sandbox didn't have):
   ```
   npm install
   ```
   Then **delete `src/types/pg-shim.d.ts`** — it's a temporary ambient type
   declaration that let this code typecheck without `@types/pg` installed;
   once the real package is present it would conflict with it.

2. **Provision PostgreSQL 15+** and create two roles: a migration-owner
   role (DDL rights) and a restricted app role (`kabadi_app` by default —
   see `.env.example`). **The app role must not be a superuser or a table
   owner**, or Row-Level Security (migration 0008) is silently bypassed.

   ```sql
   CREATE ROLE kabadi_migrator WITH LOGIN PASSWORD '...' CREATEDB;
   CREATE ROLE kabadi_app WITH LOGIN PASSWORD '...';
   CREATE DATABASE kabadi_saas OWNER kabadi_migrator;
   -- after migrations run:
   GRANT USAGE ON SCHEMA public TO kabadi_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kabadi_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kabadi_app;
   ```

3. **Copy `.env.example` to `.env`** and fill in real values, in particular
   a long random `JWT_SECRET`.

4. **Run migrations:**
   ```
   npm run migrate
   ```

5. **Typecheck, test, run:**
   ```
   npm run typecheck
   npm test
   npm run dev
   ```

## Documentation

- `ARCHITECTURE.md` — the Phase 0 architecture analysis and the SaaS
  corrections applied to the original ERD/schema
- `DATABASE.md` — schema walkthrough, RLS contract, migration workflow
- `TESTING.md` — how to run tests, and what's covered vs. not yet
- `DEVELOPMENT_STATUS.md` / `CHANGELOG.md` / `NEXT_STEPS.md` — living
  checkpoint documents, updated at the end of every phase
