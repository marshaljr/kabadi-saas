-- ============================================================
-- MIGRATION 0009: RLS FOR ROLE_PERMISSIONS
--
-- role_permissions belongs to a business indirectly through:
--
-- role_permissions.role_id
--        ↓
-- roles.business_id
--
-- Therefore it cannot use the generic business_id-based RLS policy.
-- ============================================================

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON role_permissions
    USING (
        EXISTS (
            SELECT 1
            FROM roles r
            WHERE r.id = role_permissions.role_id
              AND r.business_id = current_business_id()
        )
        OR is_platform_admin_session()
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM roles r
            WHERE r.id = role_permissions.role_id
              AND r.business_id = current_business_id()
        )
        OR is_platform_admin_session()
    );
