-- Reverses 0001. The domesday_app role is left in place: roles belong to the whole
-- cluster and other databases on it may use the role.
DROP TABLE users;
DROP TABLE tenants;
DROP FUNCTION app_enable_tenant_isolation(regclass, text);
DROP FUNCTION app_refuse_change();
DROP FUNCTION app_current_tenant_id();
REVOKE USAGE ON SCHEMA public FROM domesday_app;
