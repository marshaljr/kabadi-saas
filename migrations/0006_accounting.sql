-- ============================================================
-- MIGRATION 0006: ACCOUNTING
-- Double-entry chart of accounts, journal entries and lines.
-- ============================================================

CREATE TYPE account_type AS ENUM (
    'ASSET',
    'LIABILITY',
    'EQUITY',
    'REVENUE',
    'COGS',
    'EXPENSE'
);

CREATE TYPE journal_status AS ENUM (
    'POSTED',
    'REVERSED'
);

-- ------------------------------------------------------------
-- ACCOUNTS
-- ------------------------------------------------------------

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    account_code VARCHAR(30) NOT NULL,
    name VARCHAR(150) NOT NULL,

    type account_type NOT NULL,

    parent_account_id UUID
        REFERENCES accounts(id) ON DELETE RESTRICT,

    is_system_account BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    description TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (business_id, account_code),
    UNIQUE (business_id, name)
);

CREATE TRIGGER trg_accounts_updated_at
BEFORE UPDATE ON accounts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_accounts_parent ON accounts(parent_account_id);
CREATE INDEX idx_accounts_business_type ON accounts(business_id, type);

-- ------------------------------------------------------------
-- JOURNAL_ENTRIES
-- ------------------------------------------------------------

CREATE TABLE journal_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    entry_no VARCHAR(50) NOT NULL,

    date DATE NOT NULL DEFAULT CURRENT_DATE,

    reference_type reference_type,
    reference_id UUID,

    description TEXT,

    status journal_status NOT NULL DEFAULT 'POSTED',

    created_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (business_id, entry_no)
);

CREATE TRIGGER trg_journal_entries_updated_at
BEFORE UPDATE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_journal_entries_date ON journal_entries(business_id, date DESC);
CREATE INDEX idx_journal_entries_reference ON journal_entries(reference_type, reference_id);

-- ------------------------------------------------------------
-- JOURNAL_ENTRY_LINES
--
-- Correction B10: business_id is denormalized onto each line
-- (rather than reachable only via a join to journal_entries). This
-- lets the RLS policy in migration 0008 apply directly to this
-- table without a subquery on every row-level check, and makes
-- per-business account-balance queries a single-table scan.
-- Kept consistent with journal_entries.business_id by trigger.
-- ------------------------------------------------------------

CREATE TABLE journal_entry_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    journal_entry_id UUID NOT NULL
        REFERENCES journal_entries(id) ON DELETE CASCADE,

    account_id UUID NOT NULL
        REFERENCES accounts(id) ON DELETE RESTRICT,

    debit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),

    description TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (
        (debit > 0 AND credit = 0)
        OR (debit = 0 AND credit > 0)
    )
);

CREATE INDEX idx_journal_lines_entry ON journal_entry_lines(journal_entry_id);
CREATE INDEX idx_journal_lines_account ON journal_entry_lines(account_id);
CREATE INDEX idx_journal_lines_business ON journal_entry_lines(business_id);

-- keep journal_entry_lines.business_id truthful even if application
-- code forgets to set it explicitly.
CREATE OR REPLACE FUNCTION set_journal_line_business_id()
RETURNS TRIGGER AS $$
DECLARE
    v_business_id UUID;
BEGIN
    SELECT business_id INTO v_business_id
    FROM journal_entries WHERE id = NEW.journal_entry_id;

    IF v_business_id IS NULL THEN
        RAISE EXCEPTION 'journal_entry % not found', NEW.journal_entry_id;
    END IF;

    NEW.business_id := v_business_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_journal_line_business_id
BEFORE INSERT OR UPDATE ON journal_entry_lines
FOR EACH ROW EXECUTE FUNCTION set_journal_line_business_id();

-- ------------------------------------------------------------
-- JOURNAL BALANCE VALIDATION
--
-- The backend must call this (or an equivalent check) before
-- committing any transaction that posts a journal entry — total
-- debits must equal total credits (section 18).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION validate_journal_entry_balance(
    p_journal_entry_id UUID
)
RETURNS BOOLEAN AS $$
DECLARE
    v_debit NUMERIC(20,2);
    v_credit NUMERIC(20,2);
BEGIN
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO v_debit, v_credit
    FROM journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id;

    RETURN v_debit = v_credit;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- SEED: default chart of accounts, per business
--
-- Call this function once from the business-onboarding service
-- immediately after a business row is created (section 38).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION seed_default_accounts(p_business_id UUID)
RETURNS VOID AS $$
BEGIN
    INSERT INTO accounts (business_id, account_code, name, type, is_system_account) VALUES
        (p_business_id, '1000', 'Cash', 'ASSET', TRUE),
        (p_business_id, '1010', 'Bank', 'ASSET', TRUE),
        (p_business_id, '1100', 'Accounts Receivable', 'ASSET', TRUE),
        (p_business_id, '1200', 'Inventory', 'ASSET', TRUE),

        (p_business_id, '2000', 'Worker Payables', 'LIABILITY', TRUE),
        (p_business_id, '2010', 'Supplier Payables', 'LIABILITY', TRUE),

        (p_business_id, '3000', 'Owner Capital', 'EQUITY', TRUE),
        (p_business_id, '3010', 'Owner Withdrawals', 'EQUITY', TRUE),

        (p_business_id, '4000', 'Sales Revenue', 'REVENUE', TRUE),

        (p_business_id, '5000', 'Cost of Goods Sold', 'COGS', TRUE),

        (p_business_id, '6000', 'Transport Expense', 'EXPENSE', TRUE),
        (p_business_id, '6010', 'Fuel Expense', 'EXPENSE', TRUE),
        (p_business_id, '6020', 'Rent Expense', 'EXPENSE', TRUE),
        (p_business_id, '6030', 'Electricity Expense', 'EXPENSE', TRUE),
        (p_business_id, '6040', 'Salary Expense', 'EXPENSE', TRUE),
        (p_business_id, '6050', 'Loading/Unloading Expense', 'EXPENSE', TRUE),
        (p_business_id, '6060', 'Maintenance Expense', 'EXPENSE', TRUE),
        (p_business_id, '6090', 'Miscellaneous Expense', 'EXPENSE', TRUE)
    ON CONFLICT (business_id, account_code) DO NOTHING;
END;
$$ LANGUAGE plpgsql;
