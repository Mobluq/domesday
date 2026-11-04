-- 0009 reports and evidence modules: reports with verification codes (DMS-080
-- to DMS-088), the append-only audit log (DMS-092) and legal holds (DMS-096).

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  type text NOT NULL CHECK (type IN ('audit_verification', 'insurance_schedule', 'loss_pack', 'maintenance_safety', 'handover_pack')),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  site_id uuid,
  status text NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'issued', 'failed')),
  -- DMS-086: fingerprint of the issued PDF, checked through its verification code.
  sha256 char(64) CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- 12 characters of Crockford base32 in three groups (docs/judgement-calls.md).
  verification_code text CHECK (verification_code ~ '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  storage_key text,
  generated_by uuid NOT NULL,
  generated_at timestamptz,
  CHECK (status <> 'issued' OR (sha256 IS NOT NULL AND verification_code IS NOT NULL AND storage_key IS NOT NULL AND generated_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, generated_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('reports', 'no_delete');
-- Codes are checked with no tenant known, so they are unique across all tenants.
CREATE UNIQUE INDEX reports_verification_code ON reports (verification_code) WHERE verification_code IS NOT NULL;

-- DMS-086: anyone with the code can check a report without seeing it. The public
-- check runs with no tenant set, only app.verification_code, which makes that one
-- row visible so its fingerprint can be compared. The API returns only match or no match.
CREATE POLICY public_verification_by_code ON reports
  FOR SELECT USING (verification_code = nullif(current_setting('app.verification_code', true), ''));

CREATE FUNCTION reports_guard_issued() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'issued' AND (NEW.status, NEW.sha256, NEW.verification_code, NEW.storage_key, NEW.scope, NEW.type)
       IS DISTINCT FROM (OLD.status, OLD.sha256, OLD.verification_code, OLD.storage_key, OLD.scope, OLD.type) THEN
    RAISE EXCEPTION 'report % has been issued and cannot be changed', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard_issued BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION reports_guard_issued();

-- DMS-092: append-only. No role has UPDATE or DELETE on this table, there is no
-- UPDATE or DELETE policy, and triggers refuse updates, deletes and truncation
-- even from the table owner.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'partner', 'managed_review', 'service', 'system')),
  -- No foreign key: partner users live in their own tenant, and services have no user row.
  actor_user_id uuid,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\.[a-z_]+)+$'),
  object_type text NOT NULL CHECK (length(object_type) > 0),
  object_id text,
  before jsonb,
  after jsonb,
  reason text,
  request_id text,
  -- Server time is the record of truth (DMS-094): set by the trigger, whatever the caller sends.
  at timestamptz NOT NULL DEFAULT now()
);
SELECT app_enable_tenant_isolation('audit_events', 'append_only');
CREATE INDEX audit_events_recent ON audit_events (tenant_id, at DESC, id DESC);
CREATE INDEX audit_events_object ON audit_events (tenant_id, object_type, object_id, at DESC);

CREATE FUNCTION audit_events_server_time() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER server_time BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_server_time();

-- DMS-096: a legal hold overrides normal deletion until two administrators lift it.
CREATE TABLE legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  site_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  placed_by uuid NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  lift_approved_by_1 uuid,
  lift_approved_by_2 uuid,
  lifted_at timestamptz,
  CONSTRAINT lifted_by_two_administrators CHECK (
    lifted_at IS NULL OR (lift_approved_by_1 IS NOT NULL AND lift_approved_by_2 IS NOT NULL AND lift_approved_by_1 <> lift_approved_by_2)
  ),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, placed_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, lift_approved_by_1) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, lift_approved_by_2) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('legal_holds', 'no_delete');
CREATE INDEX legal_holds_active ON legal_holds (tenant_id, site_id) WHERE lifted_at IS NULL;
