-- 0004 register module: categories, the chart-of-accounts mapping, saved column
-- mappings, register imports and register lines (DMS-003 to DMS-006).

-- DMS-006: asset classes from the tenant's chart of accounts.
CREATE TABLE account_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  code text,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
SELECT app_enable_tenant_isolation('account_classes');

-- DMS-005: the tenant's category list, seeded from the default catalogue and editable.
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  naming_rule text,
  source text NOT NULL DEFAULT 'tenant' CHECK (source IN ('default_catalogue', 'tenant')),
  hidden boolean NOT NULL DEFAULT false,
  -- DMS-039: the tenant can switch categories on or off for recognition.
  counts_as_asset boolean NOT NULL DEFAULT true,
  merged_into_id uuid,
  account_class_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, merged_into_id) REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, account_class_id) REFERENCES account_classes (tenant_id, id)
);
SELECT app_enable_tenant_isolation('categories', 'no_delete');
CREATE UNIQUE INDEX categories_live_name ON categories (tenant_id, lower(name)) WHERE merged_into_id IS NULL;

-- DMS-003: a mapping saved once and reused for the next import of the same layout.
CREATE TABLE column_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- A hash of the file's column headings, so the same layout finds its mapping.
  layout_signature text NOT NULL,
  file_kind text NOT NULL CHECK (file_kind IN ('csv', 'xlsx')),
  mapping jsonb NOT NULL CHECK (jsonb_typeof(mapping) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, layout_signature),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('column_mappings');

CREATE TABLE register_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  file_name text NOT NULL,
  file_kind text NOT NULL CHECK (file_kind IN ('csv', 'xlsx')),
  file_sha256 char(64) CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_upload'
    CHECK (status IN ('awaiting_upload', 'uploaded', 'mapped', 'committed', 'failed')),
  detected_columns text[],
  layout_signature text,
  column_mapping_id uuid,
  rows_total integer CHECK (rows_total >= 0),
  rows_imported integer CHECK (rows_imported >= 0),
  row_errors jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(row_errors) = 'array'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, column_mapping_id) REFERENCES column_mappings (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('register_imports', 'no_delete');

CREATE TABLE register_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  register_import_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  -- DMS-004: every source field exactly as it was in the file. Never changed (trigger below).
  source_fields jsonb NOT NULL CHECK (jsonb_typeof(source_fields) = 'object'),
  -- The Domesday fields mapped from the source fields.
  original_register_id text,
  description text,
  category_text text,
  location_text text,
  cost_kobo bigint CHECK (cost_kobo >= 0),
  acquisition_date date,
  book_value_kobo bigint,
  tag_code text,
  serial text,
  -- Domesday's own matching of the line to its category and place; may be corrected later.
  category_id uuid,
  site_id uuid,
  room_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, register_import_id, row_number),
  FOREIGN KEY (tenant_id, register_import_id) REFERENCES register_imports (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id, room_id) REFERENCES rooms (tenant_id, site_id, id)
);
SELECT app_enable_tenant_isolation('register_lines', 'no_delete');
CREATE INDEX register_lines_site ON register_lines (tenant_id, site_id);
CREATE INDEX register_lines_serial ON register_lines (tenant_id, serial) WHERE serial IS NOT NULL;
CREATE INDEX register_lines_tag ON register_lines (tenant_id, tag_code) WHERE tag_code IS NOT NULL;

CREATE FUNCTION register_lines_keep_source() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.source_fields IS DISTINCT FROM OLD.source_fields
     OR NEW.register_import_id IS DISTINCT FROM OLD.register_import_id
     OR NEW.row_number IS DISTINCT FROM OLD.row_number THEN
    RAISE EXCEPTION 'the source fields of register line % cannot be changed (DMS-004)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER keep_source_fields BEFORE UPDATE ON register_lines
  FOR EACH ROW EXECUTE FUNCTION register_lines_keep_source();
