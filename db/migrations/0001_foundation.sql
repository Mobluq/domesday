-- 0001 foundation: the application role, tenant-context helpers, tenants and users.
--
-- Tenant isolation (ADR-DMS-01, playbook practice 4). Every table carries
-- tenant_id and is protected by forced row-level security keyed on the session
-- setting app.tenant_id. The API runs each request in a transaction that does:
--
--   SET LOCAL ROLE domesday_app;
--   SELECT set_config('app.tenant_id', '<tenant uuid>', true);
--
-- When the setting is missing every policy compares tenant_id with NULL, so no
-- row is visible and no row can be written: isolation fails closed.
--
-- Every foreign key between tenant tables includes tenant_id. Foreign-key checks
-- are not subject to row-level security, so without this a row in one tenant
-- could point at a row in another.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'domesday_app') THEN
    CREATE ROLE domesday_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO domesday_app;

CREATE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- Raised by triggers on records that must never be changed or removed.
CREATE FUNCTION app_refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: these records cannot be changed or removed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Turns on forced row-level security, adds the tenant policy, and grants the
-- application role exactly what the access mode allows:
--   read_write   SELECT, INSERT, UPDATE, DELETE
--   no_delete    SELECT, INSERT, UPDATE; deletes and truncation refused by trigger
--   append_only  SELECT, INSERT; updates, deletes and truncation refused by trigger,
--                and no UPDATE or DELETE privilege or policy for any role
CREATE FUNCTION app_enable_tenant_isolation(target regclass, access text DEFAULT 'read_write') RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF access NOT IN ('read_write', 'no_delete', 'append_only') THEN
    RAISE EXCEPTION 'unknown access mode %', access;
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', target);
  IF access = 'append_only' THEN
    EXECUTE format('CREATE POLICY tenant_isolation_select ON %s FOR SELECT USING (tenant_id = app_current_tenant_id())', target);
    EXECUTE format('CREATE POLICY tenant_isolation_insert ON %s FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id())', target);
    EXECUTE format('GRANT SELECT, INSERT ON %s TO domesday_app', target);
    EXECUTE format('CREATE TRIGGER refuse_update_delete BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION app_refuse_change()', target);
    EXECUTE format('CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION app_refuse_change()', target);
  ELSE
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', target);
    IF access = 'read_write' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO domesday_app', target);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO domesday_app', target);
      EXECUTE format('CREATE TRIGGER refuse_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION app_refuse_change()', target);
      EXECUTE format('CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION app_refuse_change()', target);
    END IF;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app_enable_tenant_isolation(regclass, text) FROM PUBLIC;

CREATE TABLE tenants (
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Audit firms and brokers get their own tenant, of kind partner (DMS-120).
  kind text NOT NULL DEFAULT 'organisation' CHECK (kind IN ('organisation', 'partner')),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- DMS-136: originals are kept at least 13 months and at most 7 years.
  originals_retention_months integer NOT NULL DEFAULT 13 CHECK (originals_retention_months BETWEEN 13 AND 84),
  -- DMS-054: the capturer cannot be the sole approver unless the tenant switches this off.
  capturer_separation_rule boolean NOT NULL DEFAULT true,
  -- DMS-007: optional capitalisation threshold, in kobo.
  capitalisation_threshold_kobo bigint CHECK (capitalisation_threshold_kobo >= 0),
  -- DMS-055 and ADR-DMS-08: training on customer data only with consent in writing.
  training_consent boolean NOT NULL DEFAULT false,
  training_consent_document_ref text,
  training_consent_recorded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT training_consent_in_writing CHECK (
    NOT training_consent OR (training_consent_document_ref IS NOT NULL AND training_consent_recorded_at IS NOT NULL)
  )
);
SELECT app_enable_tenant_isolation('tenants', 'no_delete');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  -- The identity from the bought sign-in provider (DMS-130, ADR-DMS-05).
  auth_subject text NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  email text NOT NULL,
  mfa_enrolled boolean NOT NULL DEFAULT false,
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, auth_subject)
);
SELECT app_enable_tenant_isolation('users', 'no_delete');
