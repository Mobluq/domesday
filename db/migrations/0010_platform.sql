-- 0010 platform, notifications, billing and AI gateway tables.

-- Idempotency keys for every write (Part 6 API design; playbook practice 3).
-- Owned by the API's shared HTTP layer rather than a business module.
CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 255),
  request_hash char(64) NOT NULL,
  method text NOT NULL,
  route text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  CHECK (status <> 'completed' OR response_status IS NOT NULL),
  PRIMARY KEY (tenant_id, key)
);
SELECT app_enable_tenant_isolation('idempotency_keys');
CREATE INDEX idempotency_keys_expiry ON idempotency_keys (expires_at);

-- Notifications module. DMS-112: walk reminders follow each site's schedule.
CREATE TABLE walk_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  site_id uuid NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('monthly', 'quarterly')),
  -- For example 35 days for a monthly site (DMS-112).
  overdue_after_days integer NOT NULL CHECK (overdue_after_days > 0),
  escalate_to_user_id uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, escalate_to_user_id) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('walk_schedules');

-- DMS-110, DMS-111: summaries and reminders. WhatsApp bodies are built by the domain rule
-- that allows only counts, the site name and a link.
CREATE TABLE notification_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  event text NOT NULL CHECK (event IN ('walk_processed', 'walk_approved', 'comparison_ready', 'walk_overdue', 'investigation_overdue')),
  site_id uuid,
  recipient_user_id uuid NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, recipient_user_id) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('notification_messages', 'no_delete');

-- Billing module. DMS-133: plans meter sites, walks and video minutes.
CREATE TABLE tenant_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  plan_code text NOT NULL,
  site_limit integer NOT NULL CHECK (site_limit > 0),
  -- Part 7: each walk includes up to 120 minutes of video.
  video_minutes_per_walk integer NOT NULL DEFAULT 120 CHECK (video_minutes_per_walk > 0),
  starts_on date NOT NULL,
  ends_on date,
  CHECK (ends_on IS NULL OR ends_on > starts_on),
  UNIQUE (tenant_id, id)
);
SELECT app_enable_tenant_isolation('tenant_plans', 'no_delete');

CREATE TABLE usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  site_id uuid,
  walk_id uuid,
  kind text NOT NULL CHECK (kind IN ('site', 'walk', 'video_minute', 'hosted_model_call', 'storage_gb_month')),
  quantity numeric(14, 4) NOT NULL CHECK (quantity >= 0),
  -- DMS-156: cost tracked per walk from day one.
  cost_micro_usd bigint CHECK (cost_micro_usd >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- Recording the same usage twice is harmless.
  dedupe_key text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, walk_id) REFERENCES walks (tenant_id, id)
);
SELECT app_enable_tenant_isolation('usage_records', 'append_only');

-- AI gateway module: routes per tenant to approved providers, and every call metered.
CREATE TABLE model_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  stage text NOT NULL CHECK (stage IN ('describe_and_grade')),
  provider text NOT NULL,
  model text NOT NULL,
  model_version text NOT NULL,
  prompt_version text NOT NULL,
  -- Part 5: only providers with zero data retention terms are allowed through the gateway.
  zero_data_retention boolean NOT NULL CONSTRAINT zero_data_retention_only CHECK (zero_data_retention),
  timeout_ms integer NOT NULL DEFAULT 30000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, stage, provider, model_version, prompt_version)
);
SELECT app_enable_tenant_isolation('model_routes');

CREATE TABLE model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  walk_id uuid NOT NULL,
  route_id uuid NOT NULL,
  model_version text NOT NULL,
  prompt_version text NOT NULL,
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  cost_micro_usd bigint CHECK (cost_micro_usd >= 0),
  latency_ms integer CHECK (latency_ms >= 0),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'timeout', 'error', 'refused')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, walk_id) REFERENCES walks (tenant_id, id),
  FOREIGN KEY (tenant_id, route_id) REFERENCES model_routes (tenant_id, id)
);
SELECT app_enable_tenant_isolation('model_calls', 'append_only');

-- Part 5 (kill switches): each stage can be switched off per tenant.
CREATE TABLE stage_switches (
  tenant_id uuid NOT NULL REFERENCES tenants (tenant_id),
  stage text NOT NULL CHECK (stage IN (
    'privacy_pass', 'pick_frames', 'detect_and_track', 'read_text_and_tags', 'describe_and_grade', 'assemble_and_score'
  )),
  enabled boolean NOT NULL DEFAULT true,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stage),
  FOREIGN KEY (tenant_id, changed_by) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_isolation('stage_switches');
