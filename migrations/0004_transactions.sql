-- ============================================================
-- MIGRATION 0004: TRANSACTIONS
-- purchases, purchase_items, sales, sale_items, payments
-- (+ worker advance tracking), expense_categories, expenses
-- ============================================================

CREATE TYPE purchase_status AS ENUM ('DRAFT', 'POSTED', 'CANCELLED', 'REVERSED');
CREATE TYPE sale_status     AS ENUM ('DRAFT', 'POSTED', 'CANCELLED', 'REVERSED');
CREATE TYPE payment_status  AS ENUM ('PENDING', 'POSTED', 'CANCELLED', 'REVERSED');
CREATE TYPE payment_direction AS ENUM ('IN', 'OUT', 'ADJUSTMENT');
CREATE TYPE expense_status  AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');

-- shared by payments, stock_movements (0005) and journal_entries (0006)
-- so any posted record can point back at what caused it.
CREATE TYPE reference_type AS ENUM (
    'PURCHASE',
    'SALE',
    'PAYMENT',
    'EXPENSE',
    'STOCK_ADJUSTMENT',
    'OPENING_BALANCE',
    'DAILY_CLOSING',
    'WORKER_ADVANCE'
);

-- ------------------------------------------------------------
-- PURCHASES
-- ------------------------------------------------------------

CREATE TABLE purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    purchase_no VARCHAR(50) NOT NULL,

    worker_id UUID
        REFERENCES workers(id) ON DELETE RESTRICT,

    supplier_id UUID
        REFERENCES suppliers(id) ON DELETE RESTRICT,

    date DATE NOT NULL DEFAULT CURRENT_DATE,

    subtotal NUMERIC(20,2) NOT NULL DEFAULT 0,
    discount NUMERIC(20,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(20,2) NOT NULL DEFAULT 0,

    total_amount NUMERIC(20,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(20,2) NOT NULL DEFAULT 0,
    due_amount NUMERIC(20,2) NOT NULL DEFAULT 0,

    status purchase_status NOT NULL DEFAULT 'DRAFT',

    notes TEXT,

    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (business_id, purchase_no),

    CHECK (
        (worker_id IS NOT NULL AND supplier_id IS NULL)
        OR (worker_id IS NULL AND supplier_id IS NOT NULL)
    ),
    CHECK (subtotal >= 0),
    CHECK (discount >= 0),
    CHECK (tax_amount >= 0),
    CHECK (total_amount >= 0),
    CHECK (paid_amount >= 0),
    CHECK (due_amount >= 0),
    CHECK (paid_amount <= total_amount),
    CHECK (due_amount = total_amount - paid_amount)
);

CREATE TRIGGER trg_purchases_updated_at
BEFORE UPDATE ON purchases
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_purchases_business_date ON purchases(business_id, date DESC);
CREATE INDEX idx_purchases_worker ON purchases(worker_id, date DESC);
CREATE INDEX idx_purchases_supplier ON purchases(supplier_id, date DESC);
CREATE INDEX idx_purchases_status ON purchases(business_id, status);

-- ------------------------------------------------------------
-- PURCHASE_ITEMS
-- ------------------------------------------------------------

CREATE TABLE purchase_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- denormalized from purchases.business_id, same rationale as
    -- journal_entry_lines.business_id (migration 0006): lets RLS
    -- apply directly to this table and avoids a join on every
    -- tenant-scoped read. Kept correct by trigger below.
    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    purchase_id UUID NOT NULL
        REFERENCES purchases(id) ON DELETE CASCADE,

    material_id UUID NOT NULL
        REFERENCES materials(id) ON DELETE RESTRICT,

    quantity NUMERIC(20,6) NOT NULL CHECK (quantity > 0),
    unit unit_type NOT NULL,
    unit_price NUMERIC(20,4) NOT NULL CHECK (unit_price >= 0),
    amount NUMERIC(20,2) NOT NULL CHECK (amount >= 0),

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX idx_purchase_items_material ON purchase_items(material_id);
CREATE INDEX idx_purchase_items_business ON purchase_items(business_id);

CREATE OR REPLACE FUNCTION set_purchase_item_business_id()
RETURNS TRIGGER AS $$
BEGIN
    SELECT business_id INTO NEW.business_id
    FROM purchases WHERE id = NEW.purchase_id;

    IF NEW.business_id IS NULL THEN
        RAISE EXCEPTION 'purchase % not found', NEW.purchase_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_purchase_item_business_id
BEFORE INSERT OR UPDATE ON purchase_items
FOR EACH ROW EXECUTE FUNCTION set_purchase_item_business_id();

-- ------------------------------------------------------------
-- SALES
-- ------------------------------------------------------------

CREATE TABLE sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    sale_no VARCHAR(50) NOT NULL,

    customer_id UUID
        REFERENCES customers(id) ON DELETE RESTRICT,

    date DATE NOT NULL DEFAULT CURRENT_DATE,

    subtotal NUMERIC(20,2) NOT NULL DEFAULT 0,
    discount NUMERIC(20,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(20,2) NOT NULL DEFAULT 0,

    total_amount NUMERIC(20,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(20,2) NOT NULL DEFAULT 0,
    due_amount NUMERIC(20,2) NOT NULL DEFAULT 0,

    status sale_status NOT NULL DEFAULT 'DRAFT',

    notes TEXT,

    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (business_id, sale_no),

    CHECK (subtotal >= 0),
    CHECK (discount >= 0),
    CHECK (tax_amount >= 0),
    CHECK (total_amount >= 0),
    CHECK (paid_amount >= 0),
    CHECK (due_amount >= 0),
    CHECK (paid_amount <= total_amount),
    CHECK (due_amount = total_amount - paid_amount)
);

CREATE TRIGGER trg_sales_updated_at
BEFORE UPDATE ON sales
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_sales_business_date ON sales(business_id, date DESC);
CREATE INDEX idx_sales_customer ON sales(customer_id, date DESC);
CREATE INDEX idx_sales_status ON sales(business_id, status);

-- NOTE on the ERD's sales.worker_id (worker as the sale's contact
-- person): omitted here deliberately. A worker is a collector the
-- business pays, not a party a sale is made *to* — conflating the
-- two risks a worker's payable and a customer's receivable being
-- accidentally netted against each other (section 13 forbids the
-- frontend/back end from blurring these balances). If a business
-- needs to record "which staff member handled this sale", that is
-- an audit/notes concern, not a financial relationship, and will be
-- added as a plain `handled_by_user_id` column if requested later.

-- ------------------------------------------------------------
-- SALE_ITEMS
-- ------------------------------------------------------------

CREATE TABLE sale_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- see purchase_items.business_id above for rationale
    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    sale_id UUID NOT NULL
        REFERENCES sales(id) ON DELETE CASCADE,

    material_id UUID NOT NULL
        REFERENCES materials(id) ON DELETE RESTRICT,

    quantity NUMERIC(20,6) NOT NULL CHECK (quantity > 0),
    unit unit_type NOT NULL,
    unit_price NUMERIC(20,4) NOT NULL CHECK (unit_price >= 0),
    amount NUMERIC(20,2) NOT NULL CHECK (amount >= 0),

    -- populated by the inventory costing service at POSTING time from
    -- the weighted-average cost; never supplied by the client
    -- (sections 17 & 64).
    cost_per_unit NUMERIC(20,4),
    cogs_amount NUMERIC(20,2),

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_material ON sale_items(material_id);
CREATE INDEX idx_sale_items_business ON sale_items(business_id);

CREATE OR REPLACE FUNCTION set_sale_item_business_id()
RETURNS TRIGGER AS $$
BEGIN
    SELECT business_id INTO NEW.business_id
    FROM sales WHERE id = NEW.sale_id;

    IF NEW.business_id IS NULL THEN
        RAISE EXCEPTION 'sale % not found', NEW.sale_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sale_item_business_id
BEFORE INSERT OR UPDATE ON sale_items
FOR EACH ROW EXECUTE FUNCTION set_sale_item_business_id();

-- ------------------------------------------------------------
-- PAYMENTS
--
-- Correction B6 (worker advance tracking): payments gets an
-- is_advance flag for OUT payments to a worker with no linked
-- purchase yet, and worker_advance_applications (below) records
-- exactly how much of which advance was later consumed against
-- which purchase — so the worker ledger can show "Advance issued
-- → Advance applied → Remaining payable" as distinct queryable
-- rows instead of an implicit running balance (section 13/24).
-- ------------------------------------------------------------

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    payment_no VARCHAR(50) NOT NULL,

    direction payment_direction NOT NULL,

    worker_id UUID REFERENCES workers(id) ON DELETE RESTRICT,
    customer_id UUID REFERENCES customers(id) ON DELETE RESTRICT,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,

    payment_method_id UUID NOT NULL
        REFERENCES payment_methods(id) ON DELETE RESTRICT,

    amount NUMERIC(20,2) NOT NULL CHECK (amount > 0),

    date DATE NOT NULL DEFAULT CURRENT_DATE,

    -- true only for a worker OUT payment issued with no purchase to
    -- apply against yet (an advance). Regular purchase payments and
    -- sale receipts leave this FALSE.
    is_advance BOOLEAN NOT NULL DEFAULT FALSE,

    -- direct link when a payment is made specifically against one
    -- purchase/sale at entry time (the common case). Application of
    -- previously-issued advances is tracked separately below since
    -- one advance can be consumed across several later purchases.
    reference_type reference_type,
    reference_id UUID,

    status payment_status NOT NULL DEFAULT 'POSTED',

    reference_number VARCHAR(100),
    notes TEXT,

    created_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (business_id, payment_no),

    CHECK (
        (worker_id IS NOT NULL AND customer_id IS NULL AND supplier_id IS NULL)
        OR (worker_id IS NULL AND customer_id IS NOT NULL AND supplier_id IS NULL)
        OR (worker_id IS NULL AND customer_id IS NULL AND supplier_id IS NOT NULL)
    ),
    CHECK (NOT (is_advance AND worker_id IS NULL))
);

CREATE TRIGGER trg_payments_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_payments_worker ON payments(worker_id, date DESC);
CREATE INDEX idx_payments_customer ON payments(customer_id, date DESC);
CREATE INDEX idx_payments_supplier ON payments(supplier_id, date DESC);
CREATE INDEX idx_payments_business_date ON payments(business_id, date DESC);
CREATE INDEX idx_payments_reference ON payments(reference_type, reference_id);

-- ------------------------------------------------------------
-- WORKER_ADVANCE_APPLICATIONS
-- ------------------------------------------------------------

CREATE TABLE worker_advance_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    worker_id UUID NOT NULL
        REFERENCES workers(id) ON DELETE CASCADE,

    -- the original advance payment (payments.is_advance = TRUE)
    advance_payment_id UUID NOT NULL
        REFERENCES payments(id) ON DELETE RESTRICT,

    -- the purchase the advance was applied against
    purchase_id UUID NOT NULL
        REFERENCES purchases(id) ON DELETE RESTRICT,

    amount_applied NUMERIC(20,2) NOT NULL CHECK (amount_applied > 0),

    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    created_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_advance_applications_worker
ON worker_advance_applications(worker_id, applied_at DESC);

CREATE INDEX idx_advance_applications_advance
ON worker_advance_applications(advance_payment_id);

CREATE INDEX idx_advance_applications_purchase
ON worker_advance_applications(purchase_id);

-- ------------------------------------------------------------
-- EXPENSE_CATEGORIES
-- ------------------------------------------------------------

CREATE TABLE expense_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    name VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (business_id, name)
);

CREATE TRIGGER trg_expense_categories_updated_at
BEFORE UPDATE ON expense_categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- EXPENSES
-- ------------------------------------------------------------

CREATE TABLE expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    expense_no VARCHAR(50) NOT NULL,

    expense_category_id UUID NOT NULL
        REFERENCES expense_categories(id) ON DELETE RESTRICT,

    worker_id UUID REFERENCES workers(id) ON DELETE SET NULL,
    payment_method_id UUID REFERENCES payment_methods(id) ON DELETE RESTRICT,

    amount NUMERIC(20,2) NOT NULL CHECK (amount > 0),

    date DATE NOT NULL DEFAULT CURRENT_DATE,

    status expense_status NOT NULL DEFAULT 'POSTED',

    description TEXT,

    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (business_id, expense_no)
);

CREATE TRIGGER trg_expenses_updated_at
BEFORE UPDATE ON expenses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_expenses_business_date ON expenses(business_id, date DESC);
CREATE INDEX idx_expenses_worker ON expenses(worker_id, date DESC);
