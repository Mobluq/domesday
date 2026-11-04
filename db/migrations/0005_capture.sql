-- 0005 capture module: walks, room status per walk, clips, upload sessions and
-- label shots (DMS-010 to DMS-023, DMS-090, DMS-094).

CREATE TABLE walks (
  -- Made on the phone, so a walk can start with no network (DMS-011, DMS-153).
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  site_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'capturing'
    CHECK (status IN ('capturing', 'uploading', 'processing', 'in_review', 'approved')),
  started_by uuid NOT NULL,
  started_at_device timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  -- DMS-070: the previous approved walk of the same site, for the comparison.
  previous_walk_id uuid,
  -- DMS-095: signals that items may have been brought in for the camera.
  staged_risk boolean NOT NULL DEFAULT false,
  staged_risk_reasons jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(staged_risk_reasons) = 'array'),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL)),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (previous_walk_id IS NULL OR previous_walk_id <> id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, started_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id, previous_walk_id) REFERENCES walks (tenant_id, site_id, id)
);
SELECT app_enable_tenant_isolation('walks', 'no_delete');
CREATE INDEX walks_site_recent ON walks (tenant_id, site_id, received_at DESC);

ALTER TABLE rooms
  ADD CONSTRAINT rooms_created_during_walk_fk
  FOREIGN KEY (tenant_id, created_during_walk_id) REFERENCES walks (tenant_id, id);

-- DMS-010: each room's status within one walk. A skipped room needs a reason.
CREATE TABLE walk_rooms (
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  walk_id uuid NOT NULL,
  room_id uuid NOT NULL,
  site_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'filmed', 'skipped')),
  skip_reason text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, walk_id, room_id),
  CONSTRAINT skipped_room_needs_reason CHECK (
    status <> 'skipped' OR (skip_reason IS NOT NULL AND length(btrim(skip_reason)) > 0)
  ),
  CHECK (status = 'skipped' OR skip_reason IS NULL),
  -- The room must be on the walk's site.
  FOREIGN KEY (tenant_id, site_id, walk_id) REFERENCES walks (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id, room_id) REFERENCES rooms (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('walk_rooms', 'no_delete');

CREATE TABLE clips (
  -- The UUID made on the phone is the idempotency key: a retried upload can never create a second clip.
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  walk_id uuid NOT NULL,
  room_id uuid NOT NULL,
  site_id uuid NOT NULL,
  -- DMS-017 and DMS-022: capture metadata, each clip credited to its filmer.
  captured_by uuid NOT NULL,
  device_id text NOT NULL CHECK (length(device_id) > 0),
  started_at_device timestamptz NOT NULL,
  ended_at_device timestamptz NOT NULL,
  location_latitude double precision CHECK (location_latitude BETWEEN -90 AND 90),
  location_longitude double precision CHECK (location_longitude BETWEEN -180 AND 180),
  location_accuracy_m real CHECK (location_accuracy_m >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'verified', 'rejected')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  content_type text NOT NULL,
  -- Where the phone uploads, through short-lived signed URLs.
  staging_key text NOT NULL,
  -- DMS-090: the write-once originals bucket, set once the fingerprint checks out.
  storage_key text,
  -- DMS-018: computed on the phone when recording stopped, and again by the server on arrival.
  sha256 char(64) CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  server_sha256 char(64) CHECK (server_sha256 ~ '^[0-9a-f]{64}$'),
  -- DMS-094: the phone's clock when it sent the final request, and the server's on arrival.
  device_time timestamptz,
  server_time timestamptz,
  clock_gap_flag boolean GENERATED ALWAYS AS (abs(extract(epoch FROM (server_time - device_time))) > 600) STORED,
  retention_until timestamptz,
  legal_hold boolean NOT NULL DEFAULT false,
  original_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  rejected_at timestamptz,
  CHECK (ended_at_device >= started_at_device),
  CHECK ((location_latitude IS NULL) = (location_longitude IS NULL)),
  CONSTRAINT verified_needs_matching_fingerprint CHECK (
    status <> 'verified' OR (
      sha256 IS NOT NULL AND server_sha256 = sha256 AND storage_key IS NOT NULL
      AND retention_until IS NOT NULL AND server_time IS NOT NULL AND verified_at IS NOT NULL
    )
  ),
  CONSTRAINT rejected_means_mismatch CHECK (
    status <> 'rejected' OR (
      sha256 IS NOT NULL AND server_sha256 IS NOT NULL AND server_sha256 <> sha256 AND rejected_at IS NOT NULL
    )
  ),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id, walk_id) REFERENCES walks (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id, room_id) REFERENCES rooms (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, captured_by) REFERENCES users (tenant_id, id)
);
-- Clip rows are never deleted: when retention ends the original file goes and original_deleted_at is set (DMS-136).
SELECT app_enable_tenant_isolation('clips', 'no_delete');
CREATE INDEX clips_walk ON clips (tenant_id, walk_id);
CREATE INDEX clips_retention_due ON clips (retention_until) WHERE original_deleted_at IS NULL AND NOT legal_hold;

-- DMS-017, DMS-018, DMS-090: once recorded, capture metadata and fingerprints never change,
-- a verified or rejected clip keeps its status, and retention can only be extended.
CREATE FUNCTION clips_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW.tenant_id, NEW.walk_id, NEW.room_id, NEW.site_id, NEW.captured_by, NEW.device_id,
      NEW.started_at_device, NEW.ended_at_device, NEW.location_latitude, NEW.location_longitude,
      NEW.location_accuracy_m, NEW.size_bytes, NEW.content_type, NEW.staging_key)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.walk_id, OLD.room_id, OLD.site_id, OLD.captured_by, OLD.device_id,
      OLD.started_at_device, OLD.ended_at_device, OLD.location_latitude, OLD.location_longitude,
      OLD.location_accuracy_m, OLD.size_bytes, OLD.content_type, OLD.staging_key) THEN
    RAISE EXCEPTION 'capture metadata of clip % cannot be changed (DMS-017)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256)
     OR (OLD.server_sha256 IS NOT NULL AND NEW.server_sha256 IS DISTINCT FROM OLD.server_sha256)
     OR (OLD.device_time IS NOT NULL AND NEW.device_time IS DISTINCT FROM OLD.device_time)
     OR (OLD.server_time IS NOT NULL AND NEW.server_time IS DISTINCT FROM OLD.server_time)
     OR (OLD.storage_key IS NOT NULL AND NEW.storage_key IS DISTINCT FROM OLD.storage_key) THEN
    RAISE EXCEPTION 'fingerprints, times and storage of clip % cannot be changed once recorded (DMS-018)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('verified', 'rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'clip % is % and its status cannot change', OLD.id, OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.retention_until IS NOT NULL AND (NEW.retention_until IS NULL OR NEW.retention_until < OLD.retention_until) THEN
    RAISE EXCEPTION 'retention of clip % can be extended but never shortened (DMS-090)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard_capture_record BEFORE UPDATE ON clips FOR EACH ROW EXECUTE FUNCTION clips_guard();

-- Part 6: resumable multipart upload sessions, one per clip.
CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  clip_id uuid NOT NULL,
  upload_id text NOT NULL,
  part_size_bytes integer NOT NULL CHECK (part_size_bytes BETWEEN 5242880 AND 104857600),
  part_count integer NOT NULL CHECK (part_count BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, id),
  -- Creating the session again returns the same one.
  UNIQUE (tenant_id, clip_id),
  FOREIGN KEY (tenant_id, clip_id) REFERENCES clips (tenant_id, id)
);
SELECT app_enable_tenant_isolation('upload_sessions');

-- DMS-015: a high-resolution still of a nameplate, serial plate or tag, linked to the moment in the clip.
CREATE TABLE label_shots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  clip_id uuid NOT NULL,
  offset_ms integer NOT NULL CHECK (offset_ms >= 0),
  captured_by uuid NOT NULL,
  taken_at_device timestamptz NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  staging_key text NOT NULL,
  storage_key text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'verified', 'rejected')),
  sha256 char(64) CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  server_sha256 char(64) CHECK (server_sha256 ~ '^[0-9a-f]{64}$'),
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'verified' OR (sha256 IS NOT NULL AND server_sha256 = sha256 AND storage_key IS NOT NULL)),
  CHECK (status <> 'rejected' OR (sha256 IS NOT NULL AND server_sha256 IS NOT NULL AND server_sha256 <> sha256)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, clip_id) REFERENCES clips (tenant_id, id),
  FOREIGN KEY (tenant_id, captured_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('label_shots', 'no_delete');
