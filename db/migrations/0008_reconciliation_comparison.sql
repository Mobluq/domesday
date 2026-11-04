-- 0008 reconciliation and comparison modules (DMS-060 to DMS-075).

CREATE TABLE reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  -- DMS-065: per site or across the whole group.
  scope text NOT NULL CHECK (scope IN ('site', 'group')),
  site_id uuid,
  register_import_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ready', 'failed')),
  started_by uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((scope = 'site') = (site_id IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, register_import_id) REFERENCES register_imports (tenant_id, id),
  FOREIGN KEY (tenant_id, started_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('reconciliations', 'no_delete');

CREATE TABLE reconciliation_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  reconciliation_id uuid NOT NULL,
  -- DMS-060: found, found elsewhere, unrecorded or not seen.
  status text NOT NULL CHECK (status IN ('found', 'found_elsewhere', 'unrecorded', 'not_seen')),
  register_line_id uuid,
  asset_line_id uuid,
  asset_id uuid,
  -- DMS-061: tag number, serial number, then description, category and location.
  method text CHECK (method IN ('tag', 'serial', 'description')),
  score numeric(5, 4) CHECK (score BETWEEN 0 AND 1),
  reasons jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(reasons) = 'array'),
  requires_confirmation boolean NOT NULL DEFAULT false,
  confirmed_by uuid,
  confirmed_at timestamptz,
  register_site_id uuid,
  found_site_id uuid,
  -- DMS-062: book value, so the controller sees the value at risk.
  book_value_kobo bigint,
  CHECK (status NOT IN ('found', 'found_elsewhere') OR (register_line_id IS NOT NULL AND asset_line_id IS NOT NULL AND method IS NOT NULL)),
  CHECK (status <> 'unrecorded' OR (register_line_id IS NULL AND asset_line_id IS NOT NULL)),
  CHECK (status <> 'not_seen' OR (register_line_id IS NOT NULL AND asset_line_id IS NULL)),
  -- DMS-060: found elsewhere shows both locations.
  CHECK (status <> 'found_elsewhere' OR (register_site_id IS NOT NULL AND found_site_id IS NOT NULL AND register_site_id <> found_site_id)),
  -- DMS-061: a description match shows its score and needs a person to confirm it.
  CONSTRAINT description_match_needs_confirmation CHECK (method IS DISTINCT FROM 'description' OR (requires_confirmation AND score IS NOT NULL)),
  CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, reconciliation_id) REFERENCES reconciliations (tenant_id, id),
  FOREIGN KEY (tenant_id, register_line_id) REFERENCES register_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_line_id) REFERENCES asset_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets (tenant_id, id),
  FOREIGN KEY (tenant_id, confirmed_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, register_site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, found_site_id) REFERENCES sites (tenant_id, id)
);
SELECT app_enable_tenant_isolation('reconciliation_matches', 'no_delete');
CREATE INDEX reconciliation_matches_status ON reconciliation_matches (tenant_id, reconciliation_id, status);

-- DMS-064: the corrections file, one row per correction with a link to its evidence.
CREATE TABLE corrections_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  reconciliation_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('xlsx', 'csv')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  storage_key text,
  sha256 char(64) CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (status <> 'ready' OR (storage_key IS NOT NULL AND sha256 IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, reconciliation_id) REFERENCES reconciliations (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('corrections_exports', 'no_delete');

-- DMS-070: each approved walk compared with the previous approved walk of the same site.
CREATE TABLE comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  site_id uuid NOT NULL,
  walk_id uuid NOT NULL,
  -- Null for a site's first walk.
  previous_walk_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  change_count integer CHECK (change_count >= 0),
  room_not_filmed_count integer CHECK (room_not_filmed_count >= 0),
  unchanged_count integer CHECK (unchanged_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  CHECK (previous_walk_id IS NULL OR previous_walk_id <> walk_id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, walk_id),
  FOREIGN KEY (tenant_id, site_id, walk_id) REFERENCES walks (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id, previous_walk_id) REFERENCES walks (tenant_id, site_id, id)
);
SELECT app_enable_tenant_isolation('comparisons', 'no_delete');

CREATE TABLE change_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  comparison_id uuid NOT NULL,
  asset_id uuid,
  -- DMS-071.
  status text NOT NULL CHECK (status IN (
    'unchanged', 'not_seen', 'moved', 'new', 'condition_worse', 'condition_better', 'room_not_filmed'
  )),
  before_line_id uuid,
  after_line_id uuid,
  quantity_before integer,
  quantity_after integer,
  -- DMS-073: "24 chairs, was 32" is -8.
  quantity_delta integer,
  condition_change text CHECK (condition_change IN ('worse', 'better')),
  matched_by text CHECK (matched_by IN ('asset_identity', 'tag', 'serial', 'category_appearance_position')),
  CHECK (before_line_id IS NOT NULL OR after_line_id IS NOT NULL),
  -- DMS-071: "room not filmed" is only ever an item from the last walk with nothing on this one.
  CHECK (status <> 'room_not_filmed' OR (before_line_id IS NOT NULL AND after_line_id IS NULL)),
  CHECK (status <> 'new' OR before_line_id IS NULL OR quantity_delta > 0),
  CHECK (status <> 'not_seen' OR after_line_id IS NULL OR quantity_delta < 0),
  CHECK (quantity_delta IS NULL OR quantity_delta = quantity_after - quantity_before),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, comparison_id) REFERENCES comparisons (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets (tenant_id, id),
  FOREIGN KEY (tenant_id, before_line_id) REFERENCES asset_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, after_line_id) REFERENCES asset_lines (tenant_id, id)
);
SELECT app_enable_tenant_isolation('change_items', 'no_delete');
CREATE INDEX change_items_comparison ON change_items (tenant_id, comparison_id, status);

-- DMS-075, DMS-113: investigations have owners, due dates and recorded outcomes.
CREATE TABLE investigations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  change_item_id uuid NOT NULL,
  asset_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  owner_user_id uuid NOT NULL,
  assigned_by uuid NOT NULL,
  due_date date NOT NULL,
  -- "Lost or stolen" in the PRD is proposed as two outcomes (docs/judgement-calls.md).
  outcome text CHECK (outcome IN ('found', 'transferred', 'disposed', 'written_off', 'lost', 'stolen')),
  outcome_note text,
  outcome_recorded_by uuid,
  outcome_recorded_at timestamptz,
  transferred_to_site_id uuid,
  transferred_to_room_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- DMS-063: closed only with an outcome a named person recorded.
  CHECK ((status = 'closed') = (outcome IS NOT NULL)),
  CHECK ((outcome IS NULL) = (outcome_recorded_by IS NULL) AND (outcome IS NULL) = (outcome_recorded_at IS NULL)),
  -- DMS-075: "transferred to Site C" updates the location, so the site is needed.
  CHECK (outcome IS DISTINCT FROM 'transferred' OR transferred_to_site_id IS NOT NULL),
  CHECK (transferred_to_room_id IS NULL OR transferred_to_site_id IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, change_item_id) REFERENCES change_items (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, outcome_recorded_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, transferred_to_site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, transferred_to_site_id, transferred_to_room_id) REFERENCES rooms (tenant_id, site_id, id)
);
SELECT app_enable_tenant_isolation('investigations', 'no_delete');
-- DMS-113: the daily job finds investigations past their due date.
CREATE INDEX investigations_open_due ON investigations (tenant_id, due_date) WHERE status = 'open';
