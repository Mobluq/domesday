-- 0003 tenancy and access module: role grants scoped by site (DMS-131, DMS-132)
-- and partner grants scoped by site and time (DMS-120, DMS-121).

CREATE TABLE role_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN (
    'tenant_administrator', 'financial_controller', 'facilities_manager', 'site_manager',
    'reviewer', 'internal_auditor', 'read_only', 'partner'
  )),
  -- Scope: every site, a group of sites, or the sites listed in role_grant_sites.
  all_sites boolean NOT NULL DEFAULT false,
  site_group_id uuid,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (NOT (all_sites AND site_group_id IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, site_group_id) REFERENCES site_groups (tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('role_grants', 'no_delete');
CREATE INDEX role_grants_user ON role_grants (tenant_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE role_grant_sites (
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  role_grant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, role_grant_id, site_id),
  FOREIGN KEY (tenant_id, role_grant_id) REFERENCES role_grants (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id)
);
SELECT app_enable_tenant_isolation('role_grant_sites');

-- A client tenant (tenant_id) grants an audit firm or broker (partner_tenant_id) access.
CREATE TABLE partner_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  partner_tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  all_sites boolean NOT NULL DEFAULT false,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid,
  revoked_at timestamptz,
  CHECK (partner_tenant_id <> tenant_id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK ((revoked_by IS NULL) = (revoked_at IS NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('partner_grants', 'no_delete');
CREATE INDEX partner_grants_partner ON partner_grants (partner_tenant_id) WHERE revoked_at IS NULL;

CREATE TABLE partner_grant_sites (
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  partner_grant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, partner_grant_id, site_id),
  FOREIGN KEY (tenant_id, partner_grant_id) REFERENCES partner_grants (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id)
);
SELECT app_enable_tenant_isolation('partner_grant_sites');

-- DMS-120: a partner, working in its own tenant, sees the grants made to it...
CREATE POLICY partner_reads_grants_made_to_it ON partner_grants
  FOR SELECT USING (partner_tenant_id = app_current_tenant_id());

-- ...and exactly the client tenants with a live grant, and no others (DMS-121).
CREATE POLICY partner_reads_granting_tenants ON tenants
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM partner_grants g
      WHERE g.tenant_id = tenants.tenant_id
        AND g.partner_tenant_id = app_current_tenant_id()
        AND g.revoked_at IS NULL
        AND g.starts_at <= now()
        AND (g.ends_at IS NULL OR g.ends_at > now())
    )
  );
