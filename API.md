# API

The API includes SaaS onboarding, tenant-scoped operations, inventory,
accounting, reports, and billing foundation endpoints.

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

## Accounting endpoints

All accounting endpoints require a business-scoped bearer token.

### `POST /api/accounting/journal-entries`

Creates an atomic, posted double-entry journal entry. It requires at least
two lines, tenant-owned active accounts, exactly one positive debit or credit
per line, and equal positive totals.

```json
{
  "entryNo": "JE-001",
  "description": "Cash received",
  "lines": [
    { "accountId": "<cash-account>", "debit": 100, "credit": 0 },
    { "accountId": "<revenue-account>", "debit": 0, "credit": 100 }
  ]
}
```

### `POST /api/accounting/income`

Records non-sales income as a journal entry without changing sales or stock.
The request supplies the debit account, income account, amount, and entry
number.

### `POST /api/accounting/expenses`

Creates a posted operating expense and its balanced journal entry atomically.
The request supplies an existing expense category, debit expense account,
credit payment/liability account, amount, and expense number.

### `GET /api/accounting/ledger`

Returns posted journal lines for the authenticated business.

### `GET /api/accounting/trial-balance`

Returns posted debit and credit totals aggregated per account.

## Error shape

Every error response is `{ "error": "human-readable message" }`, never a
raw stack trace or database error (section 68) — see
`src/lib/httpError.ts`.

## Reports

### `GET /api/reports/profit-loss`

Requires `reports.view`. Optional `from` and `to` query parameters use
inclusive `YYYY-MM-DD` dates. The report reads only `POSTED` journal entries.
`salesRevenue` is revenue from `SALE` journals, `cogs` is posted COGS,
`grossProfit = salesRevenue - cogs`, and
`netProfit = grossProfit - operatingExpenses`. `otherIncome` contains
non-sale revenue separately and is not included in `netProfit`, preserving the
project's documented definition.

The response includes `dateRange`, monetary totals as fixed two-decimal
strings, and `breakdown` rows by revenue, COGS, and expense account.

### `GET /api/reports/dashboard`

Requires `reports.view`. It accepts the same inclusive `from` and `to`
filters. Purchases, sales, and financial metrics are period-based; inventory
quantity/value and low-stock count are current snapshots; worker count is a
current active-worker snapshot. Existing `purchases`, `sales`, `inventory`,
and `workers` fields are preserved, with `financial` providing revenue, COGS,
gross profit, operating expenses, and net profit.

## Related operational endpoints

Implemented tenant-scoped endpoints include `/api/materials`, `/api/purchases`,
`/api/sales`, `/api/inventory`, `/api/reports/dashboard`,
`/api/reports/profit-loss`, and
`/api/billing/subscription`.
