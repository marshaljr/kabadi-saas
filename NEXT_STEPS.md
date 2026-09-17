# Next Steps

## Immediate (before writing any more feature code)

1. **Get this running for real.** From a machine/CI with network access:
   ```
   npm install
   rm src/types/pg-shim.d.ts   # real @types/pg now covers this
   ```
   Provision Postgres, create the two roles described in `README.md`
   (a DDL-owning migrator role and a restricted `kabadi_app` role — the
   app role must NOT be a superuser or table owner, or RLS is bypassed).
2. **Run migrations against a real database** and fix anything a live
   Postgres catches that manual review didn't (the SQL has been
   syntax-checked but never executed — see `DEVELOPMENT_STATUS.md`).
3. **Add the tenant-isolation integration test** described in
   `TESTING.md` before building Phase 3 — prove RLS actually blocks
   cross-tenant access with real data, not just that the policy SQL
   parses.
4. **Push this repository to GitHub.** No network access was available
   in the sandbox that produced it; the work is committed locally only.
5. Wire up a real HTTP framework (Express or Fastify per section 56) in
   place of the `node:http` server in `src/server.ts`, now that `npm
   install` is possible. Route handlers are already small, framework-
   agnostic async functions — this should be a thin wrapper, not a
   rewrite.

## Phase 2 — SaaS Foundation (next phase of feature work)

Per the phased plan, once the above is done:
- Business creation / onboarding endpoint: create a `businesses` row,
  immediately set that as the RLS context within the same transaction,
  seed system roles (Owner/Manager/Data Entry/Collector) with their
  default `role_permissions`, call `seed_default_accounts()`, create the
  owner's `business_memberships` row, create a `TRIALING` subscription on
  the FREE (or chosen) plan.
- Business switching endpoint (already partially covered by
  `selectActiveBusiness`, but needs a "switch without re-login" UX path).
- Usage tracking: populate `usage_records` as data is created, and a
  `GET /api/usage` endpoint reading it against the business's plan limits.
- Platform-admin route group, gated on a `platform_admins` row, using
  `withPlatformAdminContext`.

## Phases 3-10

Unchanged from the Master Build Prompt's own phased plan (materials &
people → collections/purchases → inventory → sales → accounting → reports
→ UI polish → testing & hardening). Each phase should follow the same
pattern established in Phase 1: schema first (if needed), service logic
with `withTenantContext`, backend permission checks via
`requirePermission`, tests, docs updated, checkpoint commit.

## Documentation debt

- `API.md` needs the full endpoint list from section 54 filled in as each
  lands (currently only the four auth endpoints are documented).
- `DEPLOYMENT.md` has no concrete steps yet — needs a real hosting
  decision first.
