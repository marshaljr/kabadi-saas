-- Protect subscription history through its tenant-owned subscription.
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscription_events
    USING (
        EXISTS (
            SELECT 1
            FROM subscriptions s
            WHERE s.id = subscription_events.subscription_id
              AND (s.business_id = current_business_id() OR is_platform_admin_session())
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM subscriptions s
            WHERE s.id = subscription_events.subscription_id
              AND (s.business_id = current_business_id() OR is_platform_admin_session())
        )
    );
