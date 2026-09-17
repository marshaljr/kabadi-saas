-- ============================================================
-- MIGRATION 0002: PLANS & SUBSCRIPTIONS
-- ============================================================

CREATE TYPE subscription_status AS ENUM (
    'TRIALING',
    'ACTIVE',
    'PAST_DUE',
    'PAUSED',
    'CANCELLED'
);

CREATE TYPE subscription_event_type AS ENUM (
    'CREATED',
    'TRIAL_STARTED',
    'TRIAL_ENDED',
    'ACTIVATED',
    'RENEWED',
    'PAYMENT_FAILED',
    'PLAN_CHANGED',
    'PAUSED',
    'RESUMED',
    'CANCELLED',
    'WEBHOOK_RECEIVED'
);

-- ------------------------------------------------------------
-- PLANS (platform-defined; not editable by tenants)
-- ------------------------------------------------------------

CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    code VARCHAR(50) NOT NULL,        -- 'FREE' | 'STARTER' | 'BUSINESS'
    name VARCHAR(100) NOT NULL,

    price_monthly NUMERIC(20,2) NOT NULL DEFAULT 0,
    currency_code CHAR(3) NOT NULL DEFAULT 'NPR',

    trial_days INTEGER NOT NULL DEFAULT 14
        CHECK (trial_days >= 0),

    -- centralised limits — the application reads these rather than
    -- branching on plan code (Master Build Prompt section 33: "do
    -- not scatter if(plan === 'business') through the codebase").
    -- NULL means "unlimited".
    max_users INTEGER,
    max_workers INTEGER,
    max_monthly_transactions INTEGER,
    max_branches INTEGER,
    max_storage_mb INTEGER,

    allow_exports BOOLEAN NOT NULL DEFAULT TRUE,
    allow_advanced_reports BOOLEAN NOT NULL DEFAULT FALSE,
    allow_advanced_accounting BOOLEAN NOT NULL DEFAULT FALSE,
    allow_api_access BOOLEAN NOT NULL DEFAULT FALSE,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (code)
);

CREATE TRIGGER trg_plans_updated_at
BEFORE UPDATE ON plans
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- SUBSCRIPTIONS (one per business; history kept via subscription_events)
-- ------------------------------------------------------------

CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    plan_id UUID NOT NULL
        REFERENCES plans(id) ON DELETE RESTRICT,

    status subscription_status NOT NULL DEFAULT 'TRIALING',

    -- opaque identifiers for whichever payment provider is wired up
    -- later; no card data is ever stored here.
    billing_provider VARCHAR(50),
    billing_customer_ref VARCHAR(255),
    billing_subscription_ref VARCHAR(255),

    trial_ends_at TIMESTAMPTZ,
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    cancelled_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- one active subscription record per business at a time
    UNIQUE (business_id)
);

CREATE TRIGGER trg_subscriptions_updated_at
BEFORE UPDATE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_subscriptions_status
ON subscriptions(status);

CREATE INDEX idx_subscriptions_plan
ON subscriptions(plan_id);

-- ------------------------------------------------------------
-- SUBSCRIPTION_EVENTS (append-only history + idempotent webhook log)
-- ------------------------------------------------------------

CREATE TABLE subscription_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    subscription_id UUID NOT NULL
        REFERENCES subscriptions(id) ON DELETE CASCADE,

    event_type subscription_event_type NOT NULL,

    -- the payment provider's own event id, when this row originates
    -- from a webhook. Unique so replayed webhooks are safely ignored
    -- (idempotent handling per Master Build Prompt section 34).
    provider_event_id VARCHAR(255),

    payload JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (provider_event_id)
);

CREATE INDEX idx_subscription_events_subscription
ON subscription_events(subscription_id, created_at DESC);

-- ------------------------------------------------------------
-- USAGE_RECORDS (rolling usage counters per business per period,
-- used to enforce plan limits and to render "1,450 / 2,000" style
-- displays — section 36)
-- ------------------------------------------------------------

CREATE TABLE usage_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    -- the calendar period this counter applies to, e.g. '2026-09-01'
    -- for monthly transaction counts. Point-in-time metrics (users,
    -- workers, storage) use the first-of-month convention too, and
    -- are simply re-measured/upserted each time they're recomputed.
    period_start DATE NOT NULL,

    metric VARCHAR(50) NOT NULL,   -- 'users' | 'workers' | 'transactions' | 'storage_mb' | ...
    value NUMERIC(20,4) NOT NULL DEFAULT 0,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (business_id, period_start, metric)
);

CREATE INDEX idx_usage_records_business_period
ON usage_records(business_id, period_start DESC);

-- ------------------------------------------------------------
-- SEED: default plans
-- ------------------------------------------------------------

INSERT INTO plans (
    code, name, price_monthly, trial_days,
    max_users, max_workers, max_monthly_transactions, max_branches, max_storage_mb,
    allow_exports, allow_advanced_reports, allow_advanced_accounting, allow_api_access,
    sort_order
) VALUES
    ('FREE', 'Free', 0, 14, 1, 5, 100, 1, 100,
        TRUE, FALSE, FALSE, FALSE, 1),
    ('STARTER', 'Starter', 999, 14, 3, 25, 2000, 1, 1024,
        TRUE, TRUE, FALSE, FALSE, 2),
    ('BUSINESS', 'Business', 2499, 14, NULL, NULL, NULL, 5, 10240,
        TRUE, TRUE, TRUE, TRUE, 3)
ON CONFLICT (code) DO NOTHING;
