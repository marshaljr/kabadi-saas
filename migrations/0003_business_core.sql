-- ============================================================
-- MIGRATION 0003: BUSINESS CORE DATA
-- categories, materials, material_rates, workers, customers,
-- suppliers, payment_methods
-- ============================================================

CREATE TYPE party_status AS ENUM (
    'ACTIVE',
    'INACTIVE'
);

CREATE TYPE unit_type AS ENUM (
    'KG',
    'GRAM',
    'TON',
    'PIECE',
    'DOZEN',
    'BAG',
    'CUSTOM'
);

-- ------------------------------------------------------------
-- CATEGORIES
-- ------------------------------------------------------------

CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    name VARCHAR(150) NOT NULL,
    description TEXT,

    status party_status NOT NULL DEFAULT 'ACTIVE',

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    deleted_at TIMESTAMPTZ,

    UNIQUE (business_id, name)
);

CREATE TRIGGER trg_categories_updated_at
BEFORE UPDATE ON categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_categories_business_status
ON categories(business_id, status);

-- ------------------------------------------------------------
-- MATERIALS
-- ------------------------------------------------------------

CREATE TABLE materials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    category_id UUID NOT NULL
        REFERENCES categories(id) ON DELETE RESTRICT,

    name VARCHAR(150) NOT NULL,
    sku VARCHAR(50),

    default_unit unit_type NOT NULL DEFAULT 'KG',
    custom_unit_name VARCHAR(50),

    -- current effective rates are denormalized here for fast reads
    -- (dashboard, quick-collection autofill); material_rates below
    -- remains the source of truth / history. A trigger keeps these
    -- two in sync whenever a new rate row becomes effective.
    current_purchase_rate NUMERIC(20,4) NOT NULL DEFAULT 0
        CHECK (current_purchase_rate >= 0),
    current_sales_rate NUMERIC(20,4) NOT NULL DEFAULT 0
        CHECK (current_sales_rate >= 0),

    minimum_stock NUMERIC(20,6) NOT NULL DEFAULT 0
        CHECK (minimum_stock >= 0),

    status party_status NOT NULL DEFAULT 'ACTIVE',

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    deleted_at TIMESTAMPTZ,

    UNIQUE (business_id, sku),
    UNIQUE (business_id, name)
);

CREATE TRIGGER trg_materials_updated_at
BEFORE UPDATE ON materials
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_materials_business_status
ON materials(business_id, status);

CREATE INDEX idx_materials_category
ON materials(category_id);

-- ------------------------------------------------------------
-- MATERIAL_RATES (history with effective dates)
--
-- Correction B7: an exclusion constraint prevents two rate rows
-- for the same material from having overlapping effective ranges,
-- so "what was the rate on this date" is never ambiguous. Postgres
-- represents an open-ended row (effective_to IS NULL) with an
-- unbounded daterange for this purpose.
-- ------------------------------------------------------------

CREATE TABLE material_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    material_id UUID NOT NULL
        REFERENCES materials(id) ON DELETE RESTRICT,

    purchase_rate NUMERIC(20,4) NOT NULL
        CHECK (purchase_rate >= 0),

    sales_rate NUMERIC(20,4) NOT NULL
        CHECK (sales_rate >= 0),

    effective_from DATE NOT NULL,
    effective_to DATE,

    -- generated column purely so the exclusion constraint below has
    -- a range type to operate on; effective_from/effective_to remain
    -- the columns the application reads and writes.
    effective_range DATERANGE GENERATED ALWAYS AS (
        daterange(effective_from, effective_to, '[]')
    ) STORED,

    notes TEXT,

    created_by UUID
        REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (
        effective_to IS NULL
        OR effective_to >= effective_from
    ),

    -- no two rate periods for the same material may overlap
    EXCLUDE USING gist (
        material_id WITH =,
        effective_range WITH &&
    )
);

CREATE INDEX idx_material_rates_material_date
ON material_rates(material_id, effective_from DESC);

-- keeps materials.current_purchase_rate / current_sales_rate in
-- sync whenever a rate becomes (or stops being) the open-ended
-- current row.
CREATE OR REPLACE FUNCTION sync_material_current_rate()
RETURNS TRIGGER AS $$
DECLARE
    v_material_id UUID;
BEGIN
    v_material_id := COALESCE(NEW.material_id, OLD.material_id);

    UPDATE materials m
    SET current_purchase_rate = COALESCE(r.purchase_rate, m.current_purchase_rate),
        current_sales_rate    = COALESCE(r.sales_rate, m.current_sales_rate)
    FROM (
        SELECT purchase_rate, sales_rate
        FROM material_rates
        WHERE material_id = v_material_id
          AND effective_from <= CURRENT_DATE
          AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
        ORDER BY effective_from DESC
        LIMIT 1
    ) r
    WHERE m.id = v_material_id;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_material_rates_sync
AFTER INSERT OR UPDATE OR DELETE ON material_rates
FOR EACH ROW EXECUTE FUNCTION sync_material_current_rate();

-- ------------------------------------------------------------
-- WORKERS / COLLECTORS
-- ------------------------------------------------------------

CREATE TABLE workers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    worker_code VARCHAR(50),
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(50),
    address TEXT,

    joining_date DATE,

    opening_balance NUMERIC(20,2) NOT NULL DEFAULT 0,

    -- running balances, maintained by the transaction/payment services
    -- (never written to directly by the frontend — section 63).
    -- Positive = worker owes nothing extra; see advance_balance for
    -- unconsumed advances, tracked separately so the two are never
    -- confused (section 13).
    payable_balance NUMERIC(20,2) NOT NULL DEFAULT 0,
    advance_balance NUMERIC(20,2) NOT NULL DEFAULT 0
        CHECK (advance_balance >= 0),

    status party_status NOT NULL DEFAULT 'ACTIVE',

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    deleted_at TIMESTAMPTZ,

    UNIQUE (business_id, worker_code)
);

CREATE TRIGGER trg_workers_updated_at
BEFORE UPDATE ON workers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_workers_business_status
ON workers(business_id, status);

-- ------------------------------------------------------------
-- CUSTOMERS / BUYERS
-- ------------------------------------------------------------

CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    customer_code VARCHAR(50),
    name VARCHAR(150) NOT NULL,
    business_name VARCHAR(200),

    phone VARCHAR(50),
    address TEXT,

    pan_number VARCHAR(50),
    vat_number VARCHAR(50),

    opening_balance NUMERIC(20,2) NOT NULL DEFAULT 0,
    receivable_balance NUMERIC(20,2) NOT NULL DEFAULT 0,

    status party_status NOT NULL DEFAULT 'ACTIVE',

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    deleted_at TIMESTAMPTZ,

    UNIQUE (business_id, customer_code)
);

CREATE TRIGGER trg_customers_updated_at
BEFORE UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_customers_business_status
ON customers(business_id, status);

-- ------------------------------------------------------------
-- SUPPLIERS
-- ------------------------------------------------------------

CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    supplier_code VARCHAR(50),
    name VARCHAR(150) NOT NULL,
    business_name VARCHAR(200),

    phone VARCHAR(50),
    address TEXT,

    pan_number VARCHAR(50),
    vat_number VARCHAR(50),

    opening_balance NUMERIC(20,2) NOT NULL DEFAULT 0,
    payable_balance NUMERIC(20,2) NOT NULL DEFAULT 0,

    status party_status NOT NULL DEFAULT 'ACTIVE',

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    deleted_at TIMESTAMPTZ,

    UNIQUE (business_id, supplier_code)
);

CREATE TRIGGER trg_suppliers_updated_at
BEFORE UPDATE ON suppliers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_suppliers_business_status
ON suppliers(business_id, status);

-- ------------------------------------------------------------
-- PAYMENT_METHODS
-- ------------------------------------------------------------

CREATE TABLE payment_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    name VARCHAR(100) NOT NULL,

    is_cash BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (business_id, name)
);

CREATE TRIGGER trg_payment_methods_updated_at
BEFORE UPDATE ON payment_methods
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
