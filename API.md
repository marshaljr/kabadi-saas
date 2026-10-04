# API

Phase 1 implemented the authentication foundation; Phase 2 adds business
onboarding, usage tracking, and a minimal platform-admin foundation
(below). Full API surface (workers, purchases, sales, inventory,
reports, etc. — section 54 of the Master Build Prompt) lands
progressively in Phases 3-8.

## Auth endpoints (implemented)

All bodies are JSON; all responses are JSON.

### `POST /api/auth/signup`
```json
{ "name": "Marshal S.", "email": "marshal@example.com", "password": "at-least-8-chars" }
```
→ `201` `{ "user": { "id", "name", "email", "status" }, "identityToken": "<jwt>" }`

### `POST /api/auth/login`
```json
{ "email": "marshal@example.com", "password": "..." }
```
→ `200` `{ "user": {...}, "identityToken": "<jwt>" }`

Same error message for "no such account" and "wrong password" (prevents
email enumeration).

### `GET /api/auth/businesses`
Header: `Authorization: Bearer <identityToken>`

→ `200` `{ "businesses": [ { "businessId", "businessName", "roleId", "roleName", "membershipStatus" }, ... ] }`

### `POST /api/auth/select-business`
Header: `Authorization: Bearer <identityToken>`
```json
{ "businessId": "<uuid>" }
```
→ `200` `{ "accessToken": "<business-scoped jwt>", "roleId", "roleName" }`

This business-scoped token is what every future tenant-scoped endpoint
(Phase 2+) will require, and is the only trusted source of `business_id`
for those requests — never a request body/query parameter (section 30).

### `GET /health`
→ `200` `{ "status": "ok" }`

## Business & SaaS foundation endpoints (Phase 2, implemented)

### `POST /api/businesses`
Header: `Authorization: Bearer <identityToken>`
```json
{ "name": "My Kabadi Yard", "currencyCode": "NPR", "languageCode": "en", "timezone": "Asia/Kathmandu", "planCode": "FREE" }
```
Only `name` is required; every other field defaults as shown. Runs the
full onboarding sequence in one atomic transaction: creates the
business, seeds the four default system roles (Owner/Manager/Data
Entry/Collector) with their default permission grants, creates the
caller's `Owner` membership, seeds the default chart of accounts
(`seed_default_accounts()`), creates a `TRIALING` subscription on the
given (or `FREE`) plan, and records initial usage. If any step fails,
nothing is created — see `DEVELOPMENT_STATUS.md` for the rollback test
that proves this.

→ `201`
```json
{
  "business": { "id", "name", "currencyCode", "languageCode", "timezone" },
  "membership": { "roleId", "roleName": "Owner" },
  "subscription": { "id", "planCode", "status": "TRIALING", "trialEndsAt" },
  "accessToken": "<business-scoped jwt, via the existing selectActiveBusiness — no separate call needed>"
}
```

Deliberately reuses `GET /api/auth/businesses` (list) and
`POST /api/auth/select-business` (switch) from Phase 1 rather than
adding same-purpose aliases under `/api/businesses` — see
`ARCHITECTURE.md` if you're looking for those and expected them here.

### `GET /api/usage`
Header: `Authorization: Bearer <business-scoped accessToken>`

Tenant-scoped to whichever business the token was issued for (never
a client-supplied business id). Returns the current calendar month's
recorded usage alongside the business's plan limits (`null` = unlimited).

→ `200`
```json
{
  "plan": { "code": "FREE", "name": "Free", "trialDays": 14 },
  "subscription": { "status": "TRIALING", "trialEndsAt", "currentPeriodEnd" },
  "periodStart": "2026-09-01",
  "usage": [ { "metric": "users", "value": 1 } ],
  "limits": { "maxUsers": 1, "maxWorkers": 5, "maxMonthlyTransactions": 100, "maxBranches": 1, "maxStorageMb": 100 }
}
```

No enforcement/blocking behavior yet — this is the counting foundation;
later phases decide what happens when a limit is reached.

## Platform-admin endpoints (Phase 2, minimal foundation only)

### `GET /api/admin/businesses`
Header: `Authorization: Bearer <identityToken>`

Requires the caller to have a row in `platform_admins` — checked
independently of any business membership or role (section 37: never
reachable through ordinary business-owner authorization). Returns every
business on the platform with its subscription status. This is the only
platform-admin endpoint implemented so far; deliberately not a dashboard.

→ `200` `{ "businesses": [ { "id", "name", "createdAt", "onboardingCompletedAt", "subscriptionStatus", "planCode" }, ... ] }`
→ `403` if the caller is not a platform admin

## Error shape

Every error response is `{ "error": "human-readable message" }`, never a
raw stack trace or database error (section 68) — see
`src/lib/httpError.ts`.

## Not yet implemented

Everything else listed in Master Build Prompt section 54
(`/api/workers`, `/api/collections`, `/api/purchases`, `/api/sales`,
`/api/payments`, `/api/inventory`, `/api/materials`, `/api/reports/*`,
`/api/plans` as a standalone listing endpoint) is Phase 3+ scope. This
file will be updated as each lands, per the project's
documentation-sync rule.
