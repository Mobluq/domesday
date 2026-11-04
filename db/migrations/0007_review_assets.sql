-- 0007 assets and review modules: asset identity across walks, versioned asset
-- lines, and review decisions (DMS-032 to DMS-036, DMS-050 to DMS-058, DMS-093).

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  tag_code text,
  serial text,
  category_id uuid NOT NULL,
  current_site_id uuid NOT NULL,
  current_room_id uuid,
  -- Helps match untagged items between walks (DMS-072). A plain real[] for now: pgvector
  -- is not installed on every Postgres this has to run on, and the embedding model and
  -- its size are not chosen yet (docs/judgement-calls.md). Matching runs in the API.
  appearance_embedding real[] CHECK (appearance_embedding IS NULL OR array_ndims(appearance_embedding) = 1),
  appearance_model_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((appearance_embedding IS NULL) = (appearance_model_version IS NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, current_site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, current_site_id, current_room_id) REFERENCES rooms (tenant_id, site_id, id)
);
SELECT app_enable_tenant_isolation('assets', 'no_delete');
-- DMS-034: a Domesday tag identifies exactly one asset.
CREATE UNIQUE INDEX assets_tag_code ON assets (tenant_id, tag_code) WHERE tag_code IS NOT NULL;
CREATE INDEX assets_serial ON assets (tenant_id, serial) WHERE serial IS NOT NULL;
CREATE INDEX assets_site ON assets (tenant_id, current_site_id);

-- One row per version of a line. Rows never change: every edit, decision or
-- correction writes the next version (DMS-053, DMS-093).
CREATE TABLE asset_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  line_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  walk_id uuid NOT NULL,
  site_id uuid NOT NULL,
  room_id uuid NOT NULL,
  asset_id uuid,
  proposal_id uuid,
  kind text NOT NULL CHECK (kind IN ('single_item', 'counted_group')),
  quantity integer NOT NULL CHECK (quantity >= 1),
  category_id uuid NOT NULL,
  description text,
  make text,
  make_source_region jsonb,
  model text,
  model_source_region jsonb,
  serial text,
  serial_source_region jsonb,
  tag_code text,
  tag_source_region jsonb,
  -- DMS-036: the 4-point scale, with the visible reason.
  condition text NOT NULL CHECK (condition IN ('good', 'fair', 'poor', 'not_working_or_unsafe')),
  condition_reason text,
  confidence_band text CHECK (confidence_band IN ('high', 'medium', 'low')),
  -- DMS-041, DMS-051: frames, time codes and label stills; a merge keeps both frame sets.
  evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected', 'merged', 'split')),
  -- DMS-093: why an approved line was changed.
  reason text,
  approved_by uuid,
  approved_at timestamptz,
  -- Null when the pipeline wrote the version.
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'counted_group' OR quantity = 1),
  -- Part 5 and DMS-033: serial, model and tag numbers only from text actually read. The
  -- region must be a JSON object: a JSON null is not SQL NULL, and a NULL result would pass a CHECK.
  CONSTRAINT serial_needs_source_region CHECK (serial IS NULL OR coalesce(jsonb_typeof(serial_source_region) = 'object', false)),
  CONSTRAINT model_needs_source_region CHECK (model IS NULL OR coalesce(jsonb_typeof(model_source_region) = 'object', false)),
  CONSTRAINT tag_needs_source_region CHECK (tag_code IS NULL OR coalesce(jsonb_typeof(tag_source_region) = 'object', false)),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  -- Approved means accepted by a named person (Part 4 definitions).
  CHECK (approved_at IS NULL OR status = 'accepted'),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, line_id, version),
  FOREIGN KEY (tenant_id, site_id, walk_id) REFERENCES walks (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id, room_id) REFERENCES rooms (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets (tenant_id, id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('asset_lines', 'append_only');
CREATE INDEX asset_lines_walk ON asset_lines (tenant_id, walk_id, line_id, version DESC);
CREATE INDEX asset_lines_asset ON asset_lines (tenant_id, asset_id) WHERE asset_id IS NOT NULL;

-- Versions are consecutive, a line stays in its walk, and a change to an approved
-- version needs a reason (DMS-093). The previous version stays visible.
CREATE FUNCTION asset_lines_versioning() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  previous asset_lines%ROWTYPE;
BEGIN
  SELECT * INTO previous FROM asset_lines
    WHERE tenant_id = NEW.tenant_id AND line_id = NEW.line_id
    ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'the first version of line % must be 1', NEW.line_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version <> previous.version + 1 THEN
    RAISE EXCEPTION 'line % is at version %, so the next version is %', NEW.line_id, previous.version, previous.version + 1
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.walk_id <> previous.walk_id THEN
    RAISE EXCEPTION 'line % belongs to walk %', NEW.line_id, previous.walk_id USING ERRCODE = 'check_violation';
  END IF;
  IF previous.approved_at IS NOT NULL AND (NEW.reason IS NULL OR length(btrim(NEW.reason)) = 0) THEN
    RAISE EXCEPTION 'reason_required: line % is approved, so a change needs a reason (DMS-093)', NEW.line_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER versioning BEFORE INSERT ON asset_lines FOR EACH ROW EXECUTE FUNCTION asset_lines_versioning();

-- DMS-053: every decision records who, when and what changed.
CREATE TABLE review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  walk_id uuid NOT NULL,
  line_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accept', 'edit', 'reject', 'merge', 'split', 'bulk_approve')),
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  from_version integer,
  to_version integer,
  merged_line_ids uuid[],
  split_into_line_ids uuid[],
  reason text,
  -- DMS-056: approved by Domesday's managed review service, shown with names in reports.
  via_managed_service boolean NOT NULL DEFAULT false,
  CHECK (decision <> 'merge' OR cardinality(merged_line_ids) >= 1),
  CHECK (decision <> 'split' OR cardinality(split_into_line_ids) >= 2),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, walk_id) REFERENCES walks (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('review_decisions', 'append_only');
CREATE INDEX review_decisions_line ON review_decisions (tenant_id, line_id, decided_at);
