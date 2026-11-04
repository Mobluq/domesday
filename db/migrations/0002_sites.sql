-- 0002 sites module: sites, site groups, buildings, floors and rooms (DMS-001, DMS-002).

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  code text,
  address text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
SELECT app_enable_tenant_isolation('sites');

-- DMS-132: access can be scoped to a group of sites.
CREATE TABLE site_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
SELECT app_enable_tenant_isolation('site_groups');

CREATE TABLE site_group_members (
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  site_group_id uuid NOT NULL,
  site_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, site_group_id, site_id),
  FOREIGN KEY (tenant_id, site_group_id) REFERENCES site_groups (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id)
);
SELECT app_enable_tenant_isolation('site_group_members');

CREATE TABLE buildings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  site_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id)
);
SELECT app_enable_tenant_isolation('buildings');

CREATE TABLE floors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  building_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  level integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, building_id, id),
  FOREIGN KEY (tenant_id, building_id) REFERENCES buildings (tenant_id, id)
);
SELECT app_enable_tenant_isolation('floors');

CREATE TABLE rooms (
  -- A room named on the phone during a walk gets its ID there (DMS-002, DMS-011).
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  site_id uuid NOT NULL,
  building_id uuid,
  floor_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- DMS-002: created during a walk and waiting for an administrator to confirm.
  provisional boolean NOT NULL DEFAULT false,
  created_during_walk_id uuid,
  created_by uuid,
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (floor_id IS NULL OR building_id IS NOT NULL),
  CHECK (NOT provisional OR confirmed_at IS NULL),
  CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  -- The building must be on the same site, and the floor in the same building.
  FOREIGN KEY (tenant_id, site_id, building_id) REFERENCES buildings (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, building_id, floor_id) REFERENCES floors (tenant_id, building_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, confirmed_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('rooms');
-- The administrator's queue of provisional rooms (DMS-002).
CREATE INDEX rooms_provisional_queue ON rooms (tenant_id, site_id) WHERE provisional;

-- DMS-001: spreadsheet upload of rooms, with each failed row and its reason.
CREATE TABLE room_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  site_id uuid NOT NULL,
  file_name text NOT NULL,
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_upload'
    CHECK (status IN ('awaiting_upload', 'uploaded', 'processed', 'failed')),
  rows_total integer CHECK (rows_total >= 0),
  rooms_created integer CHECK (rooms_created >= 0),
  row_errors jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(row_errors) = 'array'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('room_imports');
