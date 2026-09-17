-- ============================================================
-- MIGRATION 0007: OPERATIONS
-- daily_closings, audit_logs (tenant-scoped), attachments,
-- notifications
-- ============================================================

CREATE TYPE notification_type AS ENUM (
    'INFO',
    'WARNING',
    'PLAN_LIMIT',
    'PAYMENT_DUE',
    'SYSTEM'
);

-- ------------------------------------------------------------
-- DAILY_CLOSINGS
-- ------------------------------------------------------------

CREATE TABLE daily_closings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    closing_date DATE NOT NULL,

    opening_cash NUMERIC(20,2) NOT NULL DEFAULT 0,
    cash_sales NUMERIC(20,2) NOT NULL DEFAULT 0,
    other_cash_in NUMERIC(20,2) NOT NULL DEFAULT 0,

    worker_payments NUMERIC(20,2) NOT NULL DEFAULT 0,
    supplier_payments NUMERIC(20,2) NOT NULL DEFAULT 0,
    expenses NUMERIC(20,2) NOT NULL DEFAULT 0,
    owner_withdrawals NUMERIC(20,2) NOT NULL DEFAULT 0,

    expected_closing_cash NUMERIC(20,2) NOT NULL DEFAULT 0,
    actual_closing_cash NUMERIC(20,2) NOT NULL DEFAULT 0,
    cash_difference NUMERIC(20,2) NOT NULL DEFAULT 0,

    notes TEXT,

    closed_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (business_id, closing_date)
);

-- ------------------------------------------------------------
-- AUDIT_LOGS (tenant-scoped business activity — distinct from
-- platform_audit_logs in migration 0001, which covers
-- platform-admin-level actions across tenants)
-- ------------------------------------------------------------

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID
        REFERENCES businesses(id) ON DELETE CASCADE,

    user_id UUID
        REFERENCES users(id) ON DELETE SET NULL,

    table_name VARCHAR(100) NOT NULL,
    record_id UUID,
    action VARCHAR(50) NOT NULL,

    old_values JSONB,
    new_values JSONB,

    ip_address INET,
    user_agent TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_business_date ON audit_logs(business_id, created_at DESC);
CREATE INDEX idx_audit_logs_record ON audit_logs(table_name, record_id);

-- ------------------------------------------------------------
-- ATTACHMENTS (receipts/photos attached to any business record)
-- ------------------------------------------------------------

CREATE TABLE attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    table_name VARCHAR(100) NOT NULL,
    record_id UUID NOT NULL,

    file_name VARCHAR(255) NOT NULL,
    file_url TEXT NOT NULL,
    mime_type VARCHAR(100),
    file_size_bytes BIGINT CHECK (file_size_bytes >= 0),

    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_record ON attachments(table_name, record_id);
CREATE INDEX idx_attachments_business ON attachments(business_id);

-- ------------------------------------------------------------
-- NOTIFICATIONS (in-app notifications for a user within a business
-- context — plan-limit warnings, payment-due reminders, etc.)
-- ------------------------------------------------------------

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID
        REFERENCES businesses(id) ON DELETE CASCADE,

    user_id UUID
        REFERENCES users(id) ON DELETE CASCADE,

    type notification_type NOT NULL DEFAULT 'INFO',

    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,

    is_read BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX idx_notifications_business ON notifications(business_id, created_at DESC);
