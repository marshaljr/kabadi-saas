# Development Status

_Last updated: end of Phase 1._

## Phase 0 — Analysis ✅ Complete
Architecture analysis delivered and approved. See `ARCHITECTURE.md` for
the corrected SaaS data model and the full list of gaps found in the
original ERD/schema.

## Phase 1 — Project Foundation ✅ Complete

**Implemented:**
- TypeScript project setup (strict mode, ES modules, Node 20+)
- Centralized environment configuration (`src/config/env.ts`)
- PostgreSQL connection pool (`src/db/pool.ts`) and migration runner
  (`src/db/migrate.ts`)
- Full corrected migration set, `0001` through `0008` (see `DATABASE.md`)
- Versioned ERD source (`docs/ERD.mermaid`), rendered and visually
  verified to `docs/ERD.png`
- Row-Level Security on every tenant table, with the
  `business_memberships` dual-clause policy solving the "list my
  businesses before selecting one" bootstrap problem
- Error handling that never leaks raw errors to clients
  (`src/lib/httpError.ts`)
- Authentication foundation: signup, login, list-my-businesses,
  select-active-business, JWT issuance/verification
  (`src/modules/auth/auth.service.ts`)
- Backend permission-checking against `role_permissions`
  (`src/middleware/authorize.ts`) — not a frontend-only check
- A minimal HTTP server wiring all of the above end-to-end
  (`src/server.ts`)
- Unit tests for password hashing, JWT, and permission checks (15 tests,
  all passing, zero database dependency)
- Documentation: `README.md`, `ARCHITECTURE.md`, `DATABASE.md`,
  `TESTING.md`, `ENVIRONMENT.md`, `API.md`, `DEPLOYMENT.md`

**Commands run and their results:**
```
npm run typecheck   → 0 errors
npm test            → 15 passed, 0 failed
```
(Both run inside the sandbox using a locally-vendored copy of
`@types/node` and the globally-installed `tsx`/`typescript` — see
"Known limitations" below.)

**Known limitations (environment, not design):**
- This entire phase was built in a network-isolated sandbox. `npm install`
  could not be run — `pg`, `@types/pg`, and `tsx`/`typescript` as *local*
  project dependencies are declared in `package.json` but not present in
  `node_modules` yet. A temporary ambient type shim
  (`src/types/pg-shim.d.ts`) lets `tsc` succeed without `@types/pg`; **it
  must be deleted after running `npm install`** (see README).
- No migration has ever been run against a real PostgreSQL instance. The
  SQL has been syntax-checked (balanced parentheses, careful manual
  review) but not executed. Run `npm run migrate` against a real database
  before trusting it.
- No git push to GitHub could be performed (no network access). Work is
  committed locally; pushing to a remote is a manual step for the person
  who has network access — see the commit hash reported in this session's
  final message.

**Not implemented in Phase 1 (by design, deferred to later phases):**
- Business creation / onboarding flow
- Any of workers, materials, purchases, sales, inventory, accounting,
  expenses *service logic* (schema exists; services don't yet)
- Frontend (React/Vite) — no scaffolding created yet
- A real HTTP framework (Express/Fastify) in place of `node:http`

## Phase 2 — SaaS Foundation — Not started
See `NEXT_STEPS.md`.

## Phases 3-10
Not started.
