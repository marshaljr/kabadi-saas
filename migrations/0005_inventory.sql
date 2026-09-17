-- ============================================================
-- MIGRATION 0005: INVENTORY
-- stock_movements is the sole source of truth for current stock
-- (Master Build Prompt section 16).
-- ============================================================

CREATE TYPE stock_movement_type AS ENUM (
    'PURCHASE_IN',
    'SALE_OUT',
    'PURCHASE_RETURN_OUT',
    'SALE_RETURN_IN',
    'ADJUSTMENT_IN',
    'ADJUSTMENT_OUT',
    'OPENING_STOCK'
);

-- ------------------------------------------------------------
-- STOCK_MOVEMENTS
--
-- Correction B8: unit_cost is now NOT NULL. Every movement needs a
-- cost basis: PURCHASE_IN/OPENING_STOCK record the cost being added
-- to inventory; SALE_OUT/ADJUSTMENT_OUT/PURCHASE_RETURN_OUT record
-- the weighted-average cost being removed (this is where COGS comes
-- from — sections 17 & 19). The application layer is responsible
-- for computing the correct value before insert; the NOT NULL
-- constraint just makes it impossible to silently skip that step.
-- ------------------------------------------------------------

CREATE TABLE stock_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    material_id UUID NOT NULL
        REFERENCES materials(id) ON DELETE RESTRICT,

    movement_type stock_movement_type NOT NULL,

    reference_type reference_type,
    reference_id UUID,

    quantity_in NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (quantity_in >= 0),
    quantity_out NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (quantity_out >= 0),

    unit unit_type NOT NULL,

    unit_cost NUMERIC(20,4) NOT NULL CHECK (unit_cost >= 0),

    movement_date DATE NOT NULL DEFAULT CURRENT_DATE,

    notes TEXT,

    created_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (quantity_in > 0 OR quantity_out > 0),
    CHECK (NOT (quantity_in > 0 AND quantity_out > 0)),

    -- direction must match the declared movement_type, so a
    -- SALE_OUT row can never accidentally carry stock IN and vice
    -- versa.
    CHECK (
        (movement_type IN ('PURCHASE_IN', 'SALE_RETURN_IN', 'ADJUSTMENT_IN', 'OPENING_STOCK')
            AND quantity_in > 0 AND quantity_out = 0)
        OR
        (movement_type IN ('SALE_OUT', 'PURCHASE_RETURN_OUT', 'ADJUSTMENT_OUT')
            AND quantity_out > 0 AND quantity_in = 0)
    )
);

CREATE INDEX idx_stock_movements_material_date
ON stock_movements(material_id, movement_date DESC);

CREATE INDEX idx_stock_movements_business_date
ON stock_movements(business_id, movement_date DESC);

CREATE INDEX idx_stock_movements_reference
ON stock_movements(reference_type, reference_id);

-- Convenience view: current on-hand quantity per material, derived
-- entirely from the movement ledger (never a manually maintained
-- counter — section 16).
CREATE VIEW current_stock AS
SELECT
    material_id,
    business_id,
    SUM(quantity_in) - SUM(quantity_out) AS quantity_on_hand
FROM stock_movements
GROUP BY material_id, business_id;
