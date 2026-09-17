# API

Phase 1 implements only the authentication foundation. Full API surface
(workers, purchases, sales, inventory, reports, etc. — section 54 of the
Master Build Prompt) lands progressively in Phases 3-8.

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

## Error shape

Every error response is `{ "error": "human-readable message" }`, never a
raw stack trace or database error (section 68) — see
`src/lib/httpError.ts`.

## Not yet implemented

Everything else listed in Master Build Prompt section 54
(`/api/businesses`, `/api/workers`, `/api/collections`, `/api/purchases`,
`/api/sales`, `/api/payments`, `/api/inventory`, `/api/materials`,
`/api/reports/*`, `/api/subscription`, `/api/usage`, `/api/plans`) is
Phase 2+ scope. This file will be updated as each lands, per the
project's documentation-sync rule.
