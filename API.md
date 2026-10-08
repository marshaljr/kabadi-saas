# API

Phase 2 adds SaaS onboarding, plan visibility, usage, and platform-admin
foundation. The operational API surface (workers, purchases, sales,
inventory, reports, etc.) lands progressively in Phases 3-8.

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

### `POST /api/auth/switch-business`

Same request and response as `select-business`; this alias supports a
business-switcher UX without requiring the user to sign in again.

### `POST /api/businesses`

Header: `Authorization: Bearer <identity token>`

```json
{ "name": "Kathmandu Kabadi", "address": "...", "phone": "...", "planCode": "FREE" }
```

Creates a business and atomically seeds its Owner, Manager, Data Entry, and
Collector roles, default role permissions, chart of accounts, trial
subscription, subscription event, owner membership, and initial user usage
record. The response includes a business-scoped access token.

### `GET /api/plans`

Returns active platform plan definitions and their centralized limits.

### `GET /api/usage`

Header: `Authorization: Bearer <business-scoped token>`

Returns the current business period's usage records and the selected plan's
limit columns. Requires the `reports.view` permission.

### `GET /api/platform/businesses`

Header: `Authorization: Bearer <identity token>`

Returns businesses and subscription summaries only when the authenticated
user has a row in `platform_admins`; ordinary users receive `403`.

### `GET /health`
→ `200` `{ "status": "ok" }`

## Error shape

Every error response is `{ "error": "human-readable message" }`, never a
raw stack trace or database error (section 68) — see
`src/lib/httpError.ts`.

## Not yet implemented

Everything else listed in Master Build Prompt section 54
(`/api/workers`, `/api/collections`, `/api/purchases`,
`/api/sales`, `/api/payments`, `/api/inventory`, `/api/materials`,
`/api/reports/*`, `/api/subscription`) is
Phase 3+ scope. This file will be updated as each lands, per the
project's documentation-sync rule.
