-- ============================================================
-- MIGRATION 0001: SaaS FOUNDATION
-- Kabadi SaaS — corrected multi-tenant identity model
--
-- Supersedes the earlier single-tenant `users` table design.
-- users are now GLOBAL identities (one row per human, one email
-- platform-wide). Access to a business is granted exclusively
-- through business_memberships, so one user can belong to many
-- businesses with a different role in each (Master Build Prompt
-- section 31).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------
-- ENUM TYPES (SaaS layer)
-- ------------------------------------------------------------

CREATE TYPE user_status AS ENUM (
    'ACTIVE',
    'INACTIVE',
    'SUSPENDED'
);

CREATE TYPE membership_status AS ENUM (
    'ACTIVE',
    'INVITED',
    'SUSPENDED',
    'REMOVED'
);

-- ------------------------------------------------------------
-- updated_at trigger function (used by every table from here on)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- BUSINESSES (tenants)
-- ------------------------------------------------------------

CREATE TABLE businesses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(200) NOT NULL,
    address TEXT,
    phone VARCHAR(50),
    email VARCHAR(255),

    pan_number VARCHAR(50),
    vat_number VARCHAR(50),

    currency_code CHAR(3) NOT NULL DEFAULT 'NPR',
    language_code VARCHAR(10) NOT NULL DEFAULT 'en',
    timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Kathmandu',
    date_format VARCHAR(50) NOT NULL DEFAULT 'YYYY-MM-DD',

    fiscal_year_start_month SMALLINT NOT NULL DEFAULT 7
        CHECK (fiscal_year_start_month BETWEEN 1 AND 12),

    negative_stock_allowed BOOLEAN NOT NULL DEFAULT FALSE,

    onboarding_completed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    deleted_at TIMESTAMPTZ
);

CREATE TRIGGER trg_businesses_updated_at
BEFORE UPDATE ON businesses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- USERS (global identity — NOT tenant scoped)
-- ------------------------------------------------------------

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    email_verified_at TIMESTAMPTZ,

    password_hash TEXT NOT NULL,
    password_algo VARCHAR(20) NOT NULL DEFAULT 'scrypt',

    phone VARCHAR(50),

    status user_status NOT NULL DEFAULT 'ACTIVE',

    last_login_at TIMESTAMPTZ,

    -- the business the user last worked in; purely a UX convenience
    -- for "resume where you left off" — never used for authorization.
    last_active_business_id UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (email)
);

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_users_status ON users(status);

-- ------------------------------------------------------------
-- ROLES (per business — Owner/Manager/Data Entry/Collector, plus
-- any custom roles a business owner defines)
-- ------------------------------------------------------------

CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    name VARCHAR(100) NOT NULL,
    description TEXT,

    -- system roles (Owner/Manager/Data Entry/Collector) are seeded
    -- per business and cannot be deleted, only have their
    -- permissions adjusted.
    is_system_role BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (business_id, name)
);

CREATE TRIGGER trg_roles_updated_at
BEFORE UPDATE ON roles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- PERMISSIONS (platform-wide catalog of grantable actions)
-- ------------------------------------------------------------

CREATE TABLE permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- machine key, e.g. "purchases.create", "reports.profit_loss.view"
    key VARCHAR(150) NOT NULL,

    label VARCHAR(200) NOT NULL,
    description TEXT,

    -- groups permissions for settings-UI display ("Purchases", "Reports"...)
    category VARCHAR(100) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (key)
);

-- ------------------------------------------------------------
-- ROLE_PERMISSIONS (join table — what a role can do)
-- ------------------------------------------------------------

CREATE TABLE role_permissions (
    role_id UUID NOT NULL
        REFERENCES roles(id) ON DELETE CASCADE,

    permission_id UUID NOT NULL
        REFERENCES permissions(id) ON DELETE CASCADE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX idx_role_permissions_permission
ON role_permissions(permission_id);

-- ------------------------------------------------------------
-- BUSINESS_MEMBERSHIPS (the only path from a user to a business)
-- ------------------------------------------------------------

CREATE TABLE business_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    role_id UUID NOT NULL
        REFERENCES roles(id) ON DELETE RESTRICT,

    status membership_status NOT NULL DEFAULT 'ACTIVE',

    invited_by UUID
        REFERENCES users(id) ON DELETE SET NULL,

    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- a user may hold only one active membership row per business;
    -- role changes update this row rather than inserting a new one.
    UNIQUE (user_id, business_id)
);

CREATE TRIGGER trg_business_memberships_updated_at
BEFORE UPDATE ON business_memberships
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_memberships_user
ON business_memberships(user_id, status);

CREATE INDEX idx_memberships_business
ON business_memberships(business_id, status);

-- a role only ever belongs to one business, and a membership's
-- role_id must belong to the same business_id. Postgres CHECK
-- constraints cannot reference other tables, so this is enforced
-- with a trigger instead:
CREATE OR REPLACE FUNCTION enforce_membership_role_business_match()
RETURNS TRIGGER AS $$
DECLARE
    v_role_business UUID;
BEGIN
    SELECT business_id INTO v_role_business
    FROM roles WHERE id = NEW.role_id;

    IF v_role_business IS NULL OR v_role_business <> NEW.business_id THEN
        RAISE EXCEPTION
            'role % does not belong to business %', NEW.role_id, NEW.business_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_membership_role_business_match
BEFORE INSERT OR UPDATE ON business_memberships
FOR EACH ROW EXECUTE FUNCTION enforce_membership_role_business_match();

-- now that business_memberships exists, users.last_active_business_id
-- can be safely constrained (soft reference; SET NULL on removal
-- rather than blocking deletion of the business):
ALTER TABLE users
ADD CONSTRAINT fk_users_last_active_business
FOREIGN KEY (last_active_business_id)
REFERENCES businesses(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- PLATFORM_ADMINS (separate from business roles entirely —
-- grants cross-tenant access to the platform-admin surface only.
-- Section 37: must never be exposed to ordinary business owners,
-- and must never be grantable through normal business role
-- management.)
-- ------------------------------------------------------------

CREATE TABLE platform_admins (
    user_id UUID PRIMARY KEY
        REFERENCES users(id) ON DELETE CASCADE,

    granted_by UUID
        REFERENCES users(id) ON DELETE SET NULL,

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- PLATFORM_AUDIT_LOGS (platform-level actions: plan changes,
-- suspensions, impersonation, admin grants — distinct from the
-- per-tenant audit_logs table added in migration 0007)
-- ------------------------------------------------------------

CREATE TABLE platform_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    actor_user_id UUID
        REFERENCES users(id) ON DELETE SET NULL,

    target_business_id UUID
        REFERENCES businesses(id) ON DELETE SET NULL,

    target_user_id UUID
        REFERENCES users(id) ON DELETE SET NULL,

    action VARCHAR(100) NOT NULL,

    old_values JSONB,
    new_values JSONB,

    ip_address INET,
    user_agent TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_audit_logs_business
ON platform_audit_logs(target_business_id, created_at DESC);

CREATE INDEX idx_platform_audit_logs_actor
ON platform_audit_logs(actor_user_id, created_at DESC);

-- ------------------------------------------------------------
-- SEED: permission catalog (initial set; more added as features land)
-- ------------------------------------------------------------

INSERT INTO permissions (key, label, category) VALUES
    ('workers.view',            'View workers',              'Workers'),
    ('workers.create',          'Create workers',            'Workers'),
    ('workers.edit',            'Edit workers',               'Workers'),
    ('workers.archive',         'Archive workers',            'Workers'),
    ('collections.create',      'Add collections',            'Transactions'),
    ('purchases.view',          'View purchases',             'Transactions'),
    ('purchases.create',        'Create purchases',           'Transactions'),
    ('purchases.cancel',        'Cancel/reverse purchases',   'Transactions'),
    ('sales.view',               'View sales',                 'Transactions'),
    ('sales.create',             'Create sales',               'Transactions'),
    ('sales.cancel',             'Cancel/reverse sales',       'Transactions'),
    ('payments.view',            'View payments',              'Transactions'),
    ('payments.create',          'Record payments',            'Transactions'),
    ('payments.reverse',         'Reverse payments',           'Transactions'),
    ('expenses.view',            'View expenses',              'Transactions'),
    ('expenses.create',          'Create expenses',            'Transactions'),
    ('inventory.view',           'View inventory',             'Inventory'),
    ('inventory.adjust',         'Adjust stock',               'Inventory'),
    ('materials.manage',         'Manage materials & rates',   'Inventory'),
    ('customers.manage',         'Manage customers',           'People'),
    ('suppliers.manage',         'Manage suppliers',           'People'),
    ('accounting.view',          'View accounting & ledgers',  'Accounting'),
    ('accounting.manage',        'Manage chart of accounts',   'Accounting'),
    ('reports.view',             'View reports',               'Reports'),
    ('reports.export',           'Export reports',             'Reports'),
    ('settings.business.manage', 'Manage business settings',   'Settings'),
    ('settings.users.manage',    'Manage users & roles',       'Settings'),
    ('subscription.manage',      'Manage subscription/billing','Settings'),
    ('audit_logs.view',          'View audit logs',            'Settings')
ON CONFLICT (key) DO NOTHING;
