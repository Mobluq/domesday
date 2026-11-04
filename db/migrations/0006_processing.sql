-- 0006 processing module: queued stage jobs, stage runs, frames, tracks and
-- proposals (Part 5 pipeline, Part 6 video pipeline mechanics, DMS-041, DMS-042).

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  walk_id uuid NOT NULL,
  -- Null for stages that work on the whole walk.
  clip_id uuid,
  stage text NOT NULL CHECK (stage IN (
    'ingest_and_verify', 'privacy_pass', 'pick_frames', 'detect_and_track', 'read_text_and_tags',
    'describe_and_grade', 'assemble_and_score', 'reconcile_and_compare'
  )),
  model_version text NOT NULL CHECK (length(model_version) > 0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'dead_lettered')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Failed jobs retry a capped number of times with jittered backoff, then go to the dead-letter queue.
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  run_after timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  lease_owner text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (attempts <= max_attempts),
  UNIQUE (tenant_id, id),
  -- DMS-042: every job is keyed by clip, stage and model version, so a repeat is harmless.
  CONSTRAINT job_key UNIQUE NULLS NOT DISTINCT (tenant_id, walk_id, clip_id, stage, model_version),
  FOREIGN KEY (tenant_id, walk_id) REFERENCES walks (tenant_id, id),
  FOREIGN KEY (tenant_id, clip_id) REFERENCES clips (tenant_id, id)
);
SELECT app_enable_tenant_isolation('jobs');
-- Alerts fire on the age of the oldest queued job, not just queue length.
CREATE INDEX jobs_oldest_queued ON jobs (run_after) WHERE status = 'queued';

CREATE TABLE stage_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  job_id uuid NOT NULL,
  walk_id uuid NOT NULL,
  clip_id uuid,
  stage text NOT NULL,
  model_version text NOT NULL,
  prompt_version text,
  attempt integer NOT NULL CHECK (attempt >= 1),
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'succeeded', 'failed')),
  error text,
  output_ref text,
  cost_micro_usd bigint CHECK (cost_micro_usd >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job_id, attempt),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id),
  FOREIGN KEY (tenant_id, walk_id) REFERENCES walks (tenant_id, id),
  FOREIGN KEY (tenant_id, clip_id) REFERENCES clips (tenant_id, id)
);
SELECT app_enable_tenant_isolation('stage_runs');
-- One successful output per clip, stage and model version (DMS-042).
CREATE UNIQUE INDEX stage_runs_one_success ON stage_runs (tenant_id, walk_id, clip_id, stage, model_version)
  NULLS NOT DISTINCT WHERE outcome = 'succeeded';

CREATE TABLE frames (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  walk_id uuid NOT NULL,
  clip_id uuid NOT NULL,
  time_code_ms integer NOT NULL CHECK (time_code_ms >= 0),
  -- DMS-091: every derived record points back to its original clip, time code and fingerprint.
  clip_sha256 char(64) NOT NULL CHECK (clip_sha256 ~ '^[0-9a-f]{64}$'),
  -- Set when the frame is a label shot; stage 3 keeps every label shot.
  label_shot_id uuid,
  -- DMS-100, ADR-DMS-04: people and reports only ever see blurred derivatives.
  blurred_storage_key text NOT NULL,
  sharpness real,
  model_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, clip_id, time_code_ms, model_version),
  FOREIGN KEY (tenant_id, walk_id) REFERENCES walks (tenant_id, id),
  FOREIGN KEY (tenant_id, clip_id) REFERENCES clips (tenant_id, id),
  FOREIGN KEY (tenant_id, label_shot_id) REFERENCES label_shots (tenant_id, id)
);
SELECT app_enable_tenant_isolation('frames', 'no_delete');

-- DMS-031: one item followed across frames is counted once.
CREATE TABLE tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  walk_id uuid NOT NULL,
  clip_id uuid NOT NULL,
  model_version text NOT NULL,
  track_key text NOT NULL,
  first_seen_ms integer NOT NULL CHECK (first_seen_ms >= 0),
  last_seen_ms integer NOT NULL,
  frame_count integer NOT NULL CHECK (frame_count >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_seen_ms >= first_seen_ms),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, clip_id, model_version, track_key),
  FOREIGN KEY (tenant_id, walk_id) REFERENCES walks (tenant_id, id),
  FOREIGN KEY (tenant_id, clip_id) REFERENCES clips (tenant_id, id)
);
SELECT app_enable_tenant_isolation('tracks', 'no_delete');

-- Part 6: proposals are immutable. A reprocess creates new proposals with the new versions.
CREATE TABLE proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  walk_id uuid NOT NULL,
  -- The single track behind the proposal, when there is one.
  track_id uuid,
  -- A stable key from the assemble stage (for example the sorted track set), so reprocessing never duplicates.
  proposal_key text NOT NULL,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  -- DMS-041: the exact frames, time codes and image regions the proposal came from.
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  confidence_band text NOT NULL CHECK (confidence_band IN ('high', 'medium', 'low')),
  model_version text NOT NULL,
  prompt_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Part 5: a serial, model or tag value with no source image region is rejected. The region
  -- must be a JSON object: a JSON null is not SQL NULL, and a NULL result would pass a CHECK.
  CONSTRAINT serial_needs_source_region CHECK (
    (fields ->> 'serial') IS NULL OR coalesce(jsonb_typeof(evidence -> 'regions' -> 'serial') = 'object', false)
  ),
  CONSTRAINT model_needs_source_region CHECK (
    (fields ->> 'model') IS NULL OR coalesce(jsonb_typeof(evidence -> 'regions' -> 'model') = 'object', false)
  ),
  CONSTRAINT tag_needs_source_region CHECK (
    (fields ->> 'tag_code') IS NULL OR coalesce(jsonb_typeof(evidence -> 'regions' -> 'tag_code') = 'object', false)
  ),
  UNIQUE (tenant_id, id),
  -- DMS-042: the same walk processed with the same versions gives the same proposals, never duplicates.
  CONSTRAINT proposal_key UNIQUE (tenant_id, walk_id, proposal_key, model_version, prompt_version),
  FOREIGN KEY (tenant_id, walk_id) REFERENCES walks (tenant_id, id),
  FOREIGN KEY (tenant_id, track_id) REFERENCES tracks (tenant_id, id)
);
SELECT app_enable_tenant_isolation('proposals', 'append_only');
