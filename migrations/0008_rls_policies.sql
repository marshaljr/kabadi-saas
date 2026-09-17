-- ============================================================
-- MIGRATION 0008: ROW-LEVEL SECURITY
--
-- Correction B10 (RLS as defense-in-depth): application-layer
-- scoping (deriving business_id from the authenticated session,
-- never trusting the client — section 30) is necessary but the
-- Master Build Prompt's zero-trust tenant requirement and the
-- explicit tenant-isolation test (section 73) call for a second,
-- independent enforcement layer. If a service-layer bug ever
-- forgets a WHERE business_id = ... clause, RLS still blocks the
-- cross-tenant read/write at the database itself.
--
-- CONTRACT WITH THE APPLICATION LAYER:
-- Every request handler must, after resolving the caller's active
-- business membership, run:
--
--   SET LOCAL app.current_business_id = '<uuid>';
--   SET LOCAL app.is_platform_admin = 'true' | 'false';
--
-- inside the same transaction as the query (see
-- src/db/tenantContext.ts). Connections must use a non-superuser
-- application role — RLS is bypassed entirely for superusers and
-- table owners, so the app must NOT connect as the migration/owner
-- role in normal request handling.
-- ============================================================

-- Helper: current business id from session context, or NULL if
-- unset. `true` as the second argument means "don't error if the
-- setting was never SET" — absence of a business context should
-- fail closed (no rows visible), not throw.
CREATE OR REPLACE FUNCTION current_business_id()
RETURNS UUID AS $$
    SELECT NULLIF(current_setting('app.current_business_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_platform_admin_session()
RETURNS BOOLEAN AS $$
    SELECT COALESCE(current_setting('app.is_platform_admin', true), 'false') = 'true';
$$ LANGUAGE sql STABLE;

-- The authenticated user's id, independent of which (if any) business
-- context has been selected. Set by the app on every authenticated
-- request, including the "list my businesses" call made *before* a
-- business is chosen (see withUserContext in src/db/tenantContext.ts).
CREATE OR REPLACE FUNCTION current_user_id()
RETURNS UUID AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

-- ------------------------------------------------------------
-- Generic policy application
--
-- For every tenant-scoped table: enable RLS, force it even for the
-- table owner (so an ORM connecting as the owning role doesn't
-- silently bypass it), and allow a row when either:
--   (a) the row's business_id matches the session's current
--       business, or
--   (b) the session is flagged as a platform-admin request
--       (used only by the dedicated platform-admin service, which
--       is never reachable from ordinary tenant-facing routes).
-- ------------------------------------------------------------

DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'roles',
        'categories',
        'materials',
        'material_rates',
        'workers',
        'customers',
        'suppliers',
        'payment_methods',
        'purchases',
        'purchase_items',
        'sales',
        'sale_items',
        'payments',
        'worker_advance_applications',
        'expense_categories',
        'expenses',
        'stock_movements',
        'accounts',
        'journal_entries',
        'journal_entry_lines',
        'daily_closings',
        'audit_logs',
        'attachments',
        'notifications',
        'subscriptions',
        'usage_records'
    ];
BEGIN
    FOREACH t IN ARRAY tenant_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                USING (business_id = current_business_id() OR is_platform_admin_session())
                WITH CHECK (business_id = current_business_id() OR is_platform_admin_session())',
            t
        );
    END LOOP;
END $$;

-- ------------------------------------------------------------
-- BUSINESSES itself has no business_id column (it IS the tenant).
-- A row is visible if it's the caller's current business, or the
-- caller is a platform admin. Business creation (INSERT) happens
-- during onboarding before a business context exists, so INSERT
-- is governed separately by application logic (the onboarding
-- endpoint is the only code path allowed to create a business row)
-- rather than by this policy.
-- ------------------------------------------------------------

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON businesses
    FOR SELECT
    USING (id = current_business_id() OR is_platform_admin_session());

CREATE POLICY tenant_isolation_update ON businesses
    FOR UPDATE
    USING (id = current_business_id() OR is_platform_admin_session())
    WITH CHECK (id = current_business_id() OR is_platform_admin_session());

CREATE POLICY tenant_isolation_insert ON businesses
    FOR INSERT
    WITH CHECK (TRUE); -- gated by application-layer onboarding logic, not RLS

-- ------------------------------------------------------------
-- BUSINESS_MEMBERSHIPS gets a custom policy rather than the generic
-- tenant_isolation one: a row must be visible either when the
-- caller's active business matches (the normal "who's on my team"
-- view within a business) OR when the row belongs to the caller
-- themselves (so "which businesses am I a member of" works *before*
-- any business context has been selected — the very first query
-- after login). Without the second clause this would be an
-- unresolvable chicken-and-egg: you cannot learn which business to
-- select as current without first reading business_memberships, but
-- business_memberships would deny every row until a business is
-- selected.
-- ------------------------------------------------------------

ALTER TABLE business_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON business_memberships
    USING (
        business_id = current_business_id()
        OR user_id = current_user_id()
        OR is_platform_admin_session()
    )
    WITH CHECK (
        business_id = current_business_id()
        OR is_platform_admin_session()
        -- note: intentionally no `user_id = current_user_id()` in the
        -- WITH CHECK clause — a user must never be able to grant or
        -- modify their own membership row; only an existing member
        -- with settings.users.manage permission (enforced at the
        -- application layer, running with that business as the
        -- active context) or a platform admin may write here.
    );

-- ------------------------------------------------------------
-- USERS is a global table by design (migration 0001) — it is
-- intentionally NOT business-scoped, since a user's own account
-- must remain visible to them regardless of which business context
-- is active, and platform admin needs to look users up by email
-- during invitations. Access to *other* users' rows is restricted
-- at the application layer (a user can only look up another user's
-- id/name/email for the purpose of managing a shared business
-- membership), not via RLS, since there is no business_id here to
-- scope on.
-- ------------------------------------------------------------

-- (No RLS policy added for `users` — intentionally global.)

-- ------------------------------------------------------------
-- PLANS is a platform-wide read-only catalog, visible to everyone
-- (needed to render pricing/upgrade screens before a business has
-- even been created). Only platform admins may write to it.
-- ------------------------------------------------------------

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans FORCE ROW LEVEL SECURITY;

CREATE POLICY plans_read_all ON plans
    FOR SELECT
    USING (TRUE);

CREATE POLICY plans_write_admin_only ON plans
    FOR ALL
    USING (is_platform_admin_session())
    WITH CHECK (is_platform_admin_session());

-- ------------------------------------------------------------
-- PLATFORM_ADMINS / PLATFORM_AUDIT_LOGS / SUBSCRIPTION_EVENTS:
-- deliberately NOT given a tenant_isolation policy here because
-- they are platform-admin-only surfaces to begin with, gated at
-- the application layer by requiring a verified platform_admins
-- row for the requesting user before the route is reachable at
-- all. subscription_events is keyed by subscription_id rather than
-- business_id directly; a tenant-facing "billing history" view (if
-- built later) should query through the tenant-scoped
-- `subscriptions` table rather than reading this table straight,
-- to stay inside RLS.
-- ------------------------------------------------------------
