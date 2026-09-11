-- Test-only baseline schema from 7e6e7b9439df4a36ba409f1ba1f4a938a28e1fb1.
-- Keep immutable: exercises real foreign keys and upgrade ordering, never used by services.

-- schema.sql
CREATE TABLE IF NOT EXISTS companions (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  instructions text NOT NULL DEFAULT '',
  provider text NOT NULL CHECK (provider IN ('local','box')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','ready','error')),
  error text,
  box_id text,
  create_key uuid NOT NULL UNIQUE,
  create_started_at timestamptz,
  endpoint_secret text,
  agent_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY,
  companion_id uuid NOT NULL REFERENCES companions(id),
  client_message_id uuid NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','preparing','running','succeeded','failed','interrupted','cancelled')),
  dispatched boolean NOT NULL DEFAULT false,
  cancel_requested boolean NOT NULL DEFAULT false,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE(companion_id, client_message_id)
);
ALTER TABLE companions ADD COLUMN IF NOT EXISTS config_digest text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS prepared_at timestamptz;
CREATE INDEX IF NOT EXISTS pending_runs ON runs(created_at,id) WHERE status IN ('queued','preparing','running');
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  companion_id uuid NOT NULL REFERENCES companions(id),
  run_id uuid NOT NULL REFERENCES runs(id),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,role)
);

-- auth-schema.sql
CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification"("identifier");

ALTER TABLE companions ADD COLUMN IF NOT EXISTS owner_id text REFERENCES "user"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS companions_owner_created ON companions(owner_id, created_at, id);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS attachment_count integer NOT NULL DEFAULT 0 CHECK (attachment_count BETWEEN 0 AND 5);

-- product.sql
ALTER TABLE companions ADD COLUMN IF NOT EXISTS avatar jsonb NOT NULL DEFAULT '{"shape":0,"color":0,"face":0}';
ALTER TABLE companions ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES companions(id);
ALTER TABLE companions ADD COLUMN IF NOT EXISTS temporary boolean NOT NULL DEFAULT false;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS prepare_requested boolean NOT NULL DEFAULT false;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_taken boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS control_commands (
 id uuid PRIMARY KEY, companion_id uuid NOT NULL REFERENCES companions(id), run_id uuid NOT NULL REFERENCES runs(id),
 operation text NOT NULL, status text NOT NULL DEFAULT 'claimed', result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS task_questions (
 id uuid PRIMARY KEY, companion_id uuid NOT NULL REFERENCES companions(id), run_id uuid NOT NULL REFERENCES runs(id),
 question text NOT NULL, options jsonb NOT NULL DEFAULT '[]', answer text,
 created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz
);

ALTER TABLE control_commands ADD COLUMN IF NOT EXISTS result_secret text;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS preview_text text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS usage jsonb;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS client_creation_id uuid;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS creation_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS companions_owner_creation_id ON companions(owner_id,client_creation_id) WHERE client_creation_id IS NOT NULL;

ALTER TABLE task_questions ADD COLUMN IF NOT EXISTS context_text text;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS thinking_text text;

-- plugins.sql
CREATE TABLE IF NOT EXISTS plugin_accounts (
 id uuid PRIMARY KEY, owner_id text NOT NULL, provider text NOT NULL,
 label text NOT NULL, server_id text, credential_secret text NOT NULL,
 configuration jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 health_status text NOT NULL DEFAULT 'unchecked', health_code text, health_checked_at timestamptz,
 CHECK (health_status IN ('unchecked','ok','error','requires_agent')),
 CHECK (health_code IS NULL OR health_code IN ('authorization_required','connection_failed','configuration_invalid','agent_check_required'))
);
ALTER TABLE plugin_accounts ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'unchecked';
ALTER TABLE plugin_accounts ADD COLUMN IF NOT EXISTS health_code text;
ALTER TABLE plugin_accounts ADD COLUMN IF NOT EXISTS health_checked_at timestamptz;
ALTER TABLE plugin_accounts DROP CONSTRAINT IF EXISTS plugin_accounts_health_status_check;
ALTER TABLE plugin_accounts ADD CONSTRAINT plugin_accounts_health_status_check CHECK (health_status IN ('unchecked','ok','error','requires_agent'));
ALTER TABLE plugin_accounts DROP CONSTRAINT IF EXISTS plugin_accounts_health_code_check;
ALTER TABLE plugin_accounts ADD CONSTRAINT plugin_accounts_health_code_check CHECK (health_code IS NULL OR health_code IN ('authorization_required','connection_failed','configuration_invalid','agent_check_required'));
CREATE INDEX IF NOT EXISTS plugin_owner ON plugin_accounts(owner_id);
CREATE TABLE IF NOT EXISTS companion_plugins (
 companion_id uuid NOT NULL REFERENCES companions(id), account_id uuid NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
 PRIMARY KEY(companion_id,account_id)
);
CREATE TABLE IF NOT EXISTS plugin_oauth_flows (
 state_hash text PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL,
 flow_secret text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);

-- storage-schema.sql
-- Applied after the accounts migration: companions.owner_id must already exist.
CREATE UNIQUE INDEX IF NOT EXISTS companions_id_owner_uq ON companions(id, owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS runs_id_companion_uq ON runs(id, companion_id);

CREATE TABLE IF NOT EXISTS attachments (
  id uuid PRIMARY KEY,
  client_file_id uuid NOT NULL,
  owner_id text NOT NULL,
  companion_id uuid NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('user_upload','agent_output')),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 4),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 120),
  content_type text NOT NULL CHECK (content_type IN (
    'image/png','image/jpeg','image/webp','image/gif','application/pdf',
    'text/plain','text/csv','text/markdown','application/json'
  )),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, companion_id, run_id, client_file_id),
  UNIQUE(run_id, kind, position),
  FOREIGN KEY (companion_id, owner_id) REFERENCES companions(id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, companion_id) REFERENCES runs(id, companion_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS attachments_run_idx ON attachments(owner_id, companion_id, run_id, position);

-- automations.sql
-- Independent histories and FIFO background work. Existing sends remain main/chat.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'main' CHECK (lane IN ('main','background'));
ALTER TABLE runs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'chat' CHECK (source IN ('chat','routine','trigger','delegation'));
ALTER TABLE runs ADD COLUMN IF NOT EXISTS response_root_id uuid REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS result_text text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS publish_to_chat boolean NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS routine_id uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS resume_requested_at timestamptz;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK (status IN ('queued','preparing','running','needs_input','succeeded','failed','interrupted','cancelled'));
DROP INDEX IF EXISTS one_active_run;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_background_run ON runs(companion_id)
  WHERE lane='background' AND status IN ('preparing','running');
CREATE INDEX IF NOT EXISTS runs_lane_queue ON runs(companion_id,lane,created_at,id) WHERE status='queued';

CREATE TABLE IF NOT EXISTS routines (
  id uuid PRIMARY KEY,
  companion_id uuid NOT NULL REFERENCES companions(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 50000),
  cron text NOT NULL,
  timezone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  next_fire_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (companion_id,id)
);
CREATE INDEX IF NOT EXISTS due_routines ON routines(next_fire_at,id) WHERE enabled AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS routine_occurrences (
  routine_id uuid NOT NULL REFERENCES routines(id),
  scheduled_for timestamptz NOT NULL,
  run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
  prompt text NOT NULL,
  cron text NOT NULL,
  timezone text NOT NULL,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (routine_id,scheduled_for)
);
-- A window marks all scheduled instants in it missed, without inserting one row per minute
-- for a service that was offline for years. The schedule snapshot makes the set unambiguous.
CREATE TABLE IF NOT EXISTS routine_missed_windows (
  routine_id uuid NOT NULL REFERENCES routines(id),
  first_scheduled_for timestamptz NOT NULL,
  last_scheduled_for timestamptz NOT NULL,
  cron text NOT NULL,
  timezone text NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (routine_id,first_scheduled_for),
  CHECK (last_scheduled_for >= first_scheduled_for)
);

-- Search only task prompts/results; never index staged instructions or provider credentials.
CREATE INDEX IF NOT EXISTS runs_history_search_idx ON runs USING gin(to_tsvector('simple',content || E'\n' || COALESCE(result_text,'')));

-- Snapshot routine provenance and publication policy at durable admission.
ALTER TABLE routines ADD COLUMN IF NOT EXISTS publication_mode text NOT NULL DEFAULT 'auto' CHECK (publication_mode IN ('auto','always','silent'));
ALTER TABLE runs ADD COLUMN IF NOT EXISTS routine_name text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS publication_mode text NOT NULL DEFAULT 'auto' CHECK (publication_mode IN ('auto','always','silent'));
-- Older scheduled runs had only the routine ID; retain the best available name once.
UPDATE runs r SET routine_name=rt.name FROM routines rt WHERE r.routine_id=rt.id AND r.routine_name IS NULL;

-- triggers.sql
CREATE UNIQUE INDEX IF NOT EXISTS companions_id_owner_uq ON companions(id, owner_id);

CREATE TABLE IF NOT EXISTS triggers (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  companion_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 50000),
  source text NOT NULL CHECK (source IN ('generic','github','sentry')),
  mode text NOT NULL CHECK (mode IN ('direct','filter')),
  filter_code text CHECK (filter_code IS NULL OR length(filter_code) BETWEEN 1 AND 20000),
  filter_requests jsonb NOT NULL DEFAULT '[]',
  problem_path text CHECK (problem_path IS NULL OR problem_path ~ '^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,7}$'),
  provider_account_id uuid,
  target jsonb,
  enabled boolean NOT NULL DEFAULT true,
  secret_ciphertext text NOT NULL,
  registration_status text NOT NULL DEFAULT 'manual' CHECK (registration_status IN ('manual','registered','needs_connection','error')),
  registration_error text,
  remote_hook_id text,
  last_delivery_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_id),
  FOREIGN KEY (companion_id, owner_id) REFERENCES companions(id, owner_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS triggers_owner_companion ON triggers(owner_id, companion_id, created_at, id);

CREATE TABLE IF NOT EXISTS trigger_deliveries (
  id uuid PRIMARY KEY,
  trigger_id uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  delivery_key text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  problem_key text NOT NULL CHECK (length(problem_key) BETWEEN 1 AND 64),
  event_name text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','evaluating','ignored','enqueued','error')),
  decision text CHECK (decision IN ('accepted','ignored','error')),
  error_code text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  claimed_at timestamptz,
  batch_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (trigger_id, delivery_key)
);
CREATE INDEX IF NOT EXISTS trigger_delivery_inbox ON trigger_deliveries(received_at, id)
  WHERE status IN ('received','evaluating');

CREATE TABLE IF NOT EXISTS trigger_batches (
  id uuid PRIMARY KEY,
  trigger_id uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  problem_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','finished')),
  enqueue_status text NOT NULL DEFAULT 'pending' CHECK (enqueue_status IN ('pending','sent','error')),
  enqueue_attempts integer NOT NULL DEFAULT 0 CHECK (enqueue_attempts BETWEEN 0 AND 5),
  next_enqueue_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE trigger_deliveries DROP CONSTRAINT IF EXISTS trigger_deliveries_batch_id_fkey;
ALTER TABLE trigger_deliveries ADD CONSTRAINT trigger_deliveries_batch_id_fkey
  FOREIGN KEY (batch_id) REFERENCES trigger_batches(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trigger_one_queued_problem ON trigger_batches(trigger_id, problem_key) WHERE status='queued';
-- Parked needs_input tasks release their lane; multiple started batches are valid.
DROP INDEX IF EXISTS trigger_one_running_problem;
CREATE INDEX IF NOT EXISTS trigger_pending_batches ON trigger_batches(next_enqueue_at, id) WHERE enqueue_status IN ('pending','error');

-- lifecycle.sql
ALTER TABLE companions ADD COLUMN IF NOT EXISTS snapshot_name text;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS template_id uuid;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS template_revision integer;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS ready_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS archive_requested_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_paused_at timestamptz;
CREATE TABLE IF NOT EXISTS agent_templates (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), name text NOT NULL,
 instructions text NOT NULL DEFAULT '', avatar jsonb NOT NULL DEFAULT '{"shape":0,"color":0,"face":0}',
 model_id text, snapshot_name text, source_companion_id uuid REFERENCES companions(id), revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS template_revisions (
 template_id uuid NOT NULL REFERENCES agent_templates(id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK(revision > 0), owner_id text NOT NULL REFERENCES "user"(id),
 name text NOT NULL, instructions text NOT NULL, avatar jsonb NOT NULL, model_id text,
 snapshot_name text, source_companion_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(template_id,revision)
);
CREATE INDEX IF NOT EXISTS template_revisions_owner_idx ON template_revisions(owner_id,template_id,revision DESC);
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE template_revisions ADD COLUMN IF NOT EXISTS model_id text;
INSERT INTO template_revisions(template_id,revision,owner_id,name,instructions,avatar,model_id,snapshot_name,source_companion_id,created_at)
 SELECT id,revision,owner_id,name,instructions,avatar,model_id,snapshot_name,source_companion_id,updated_at
 FROM agent_templates ON CONFLICT(template_id,revision) DO NOTHING;
CREATE TABLE IF NOT EXISTS template_permissions (
 parent_id uuid NOT NULL REFERENCES companions(id), template_id uuid NOT NULL REFERENCES agent_templates(id),
 max_children integer NOT NULL CHECK(max_children BETWEEN 0 AND 20), PRIMARY KEY(parent_id,template_id)
);
CREATE TABLE IF NOT EXISTS template_candidates (
 id uuid PRIMARY KEY, template_id uuid NOT NULL REFERENCES agent_templates(id), source_companion_id uuid NOT NULL REFERENCES companions(id),
 expected_revision integer NOT NULL, snapshot_name text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','capturing','ready','activated','failed')),
 requested_at timestamptz NOT NULL DEFAULT now(), attempted_at timestamptz, ready_at timestamptz,
 error text
);
CREATE UNIQUE INDEX IF NOT EXISTS one_template_candidate ON template_candidates(template_id) WHERE status IN ('queued','capturing','ready');
CREATE TABLE IF NOT EXISTS delegations (
 id uuid PRIMARY KEY, parent_id uuid NOT NULL REFERENCES companions(id), parent_run_id uuid REFERENCES runs(id),
 target_id uuid NOT NULL REFERENCES companions(id), run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
 result jsonb, files_saved_at timestamptz, returned_run_id uuid REFERENCES runs(id),
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS machine_usage_events (
 id uuid PRIMARY KEY, companion_id uuid NOT NULL REFERENCES companions(id), owner_id text NOT NULL REFERENCES "user"(id),
 event text NOT NULL CHECK(event IN ('starting','ready','archived')), occurred_at timestamptz NOT NULL DEFAULT now(), reported_at timestamptz
);
ALTER TABLE companions ADD COLUMN IF NOT EXISTS preparation_started_at timestamptz;

-- A parent review references the child's one immutable object; it never owns a second storage key.
CREATE TABLE IF NOT EXISTS delegation_files (
 delegation_id uuid NOT NULL REFERENCES delegations(id),
 attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
 owner_id text NOT NULL,
 target_companion_id uuid NOT NULL,
 target_run_id uuid NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 4),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(target_run_id,position),
 UNIQUE(delegation_id,attachment_id),
 FOREIGN KEY(target_companion_id,owner_id) REFERENCES companions(id,owner_id),
 FOREIGN KEY(target_run_id,target_companion_id) REFERENCES runs(id,companion_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS delegation_files_target ON delegation_files(owner_id,target_companion_id,target_run_id);

ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- software.sql
CREATE TABLE IF NOT EXISTS portable_software_bases (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._+-]{0,127}$'),
  provider_snapshot_name text NOT NULL UNIQUE CHECK (provider_snapshot_name ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  distribution_digest text NOT NULL CHECK (distribution_digest ~ '^[0-9a-f]{64}$'),
  resolver_config_digest text NOT NULL CHECK (resolver_config_digest ~ '^[0-9a-f]{64}$'),
  distro_family text NOT NULL CHECK (distro_family ~ '^[a-z0-9][a-z0-9._+-]{0,127}$'),
  distro_suite text NOT NULL CHECK (distro_suite ~ '^[a-z0-9][a-z0-9._+-]{0,127}$'),
  distro_architecture text NOT NULL CHECK (distro_architecture ~ '^[a-z0-9][a-z0-9._+-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portable_software_base_selection (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  base_id text NOT NULL REFERENCES portable_software_bases(id) ON DELETE RESTRICT,
  selected_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portable_software_manifests (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  base_id text NOT NULL REFERENCES portable_software_bases(id) ON DELETE RESTRICT,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,digest),
  UNIQUE(id,owner_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_templates_id_owner_uq ON agent_templates(id,owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS companions_id_owner_software_uq ON companions(id,owner_id);

CREATE TABLE IF NOT EXISTS portable_software_builds (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  template_id uuid NOT NULL,
  expected_revision integer NOT NULL CHECK (expected_revision > 0),
  template_revision integer NOT NULL CHECK (template_revision = expected_revision + 1),
  base_id text NOT NULL REFERENCES portable_software_bases(id) ON DELETE RESTRICT,
  requested_roots jsonb NOT NULL CHECK (jsonb_typeof(requested_roots) = 'object'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Filled by the runtime from the helper's canonical digest, which also binds
  -- the operator-only resolver configuration. It is intentionally distinct
  -- from the user request fingerprint above.
  helper_request_digest text CHECK (helper_request_digest IS NULL OR helper_request_digest ~ '^[0-9a-f]{64}$'),
  create_key uuid NOT NULL UNIQUE,
  box_id text,
  create_started_at timestamptz,
  manifest_id uuid,
  resolved_manifest_digest text CHECK (resolved_manifest_digest IS NULL OR resolved_manifest_digest ~ '^[0-9a-f]{64}$'),
  provider_snapshot_name text NOT NULL UNIQUE CHECK (provider_snapshot_name ~ '^companions-software-[0-9a-f-]{36}$'),
  snapshot_started_at timestamptz,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','creating','resolving','installing','verifying','capturing','ready','failed')),
  cleanup_status text NOT NULL DEFAULT 'pending' CHECK (cleanup_status IN ('pending','complete','error')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(id,owner_id),
  UNIQUE(template_id,template_revision),
  FOREIGN KEY(template_id,owner_id) REFERENCES agent_templates(id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(manifest_id,owner_id) REFERENCES portable_software_manifests(id,owner_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS portable_software_builds_pending_idx ON portable_software_builds(status,created_at)
  WHERE status NOT IN ('ready','failed');
CREATE INDEX IF NOT EXISTS portable_software_builds_owner_idx ON portable_software_builds(owner_id,created_at DESC);

-- Build Boxes are tenant runtime resources, distinct from operator distribution-build Boxes.
-- Each observed ready/resume cycle is billed independently and closes only after an observed
-- archived or missing provider response.
CREATE TABLE IF NOT EXISTS portable_software_usage_intervals (
  id uuid PRIMARY KEY,
  build_id uuid NOT NULL,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  ready_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR end_reason IN ('archived','missing')),
  CHECK (last_observed_at >= ready_at),
  CHECK ((ended_at IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND end_reason IS NOT NULL AND ended_at >= last_observed_at)),
  FOREIGN KEY(build_id,owner_id) REFERENCES portable_software_builds(id,owner_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS portable_software_usage_open_idx ON portable_software_usage_intervals(build_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS portable_software_usage_owner_idx ON portable_software_usage_intervals(owner_id,ready_at,id);

ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS software_build_id uuid;
ALTER TABLE template_revisions ADD COLUMN IF NOT EXISTS software_build_id uuid;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS software_build_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_templates_software_build_owner_fk') THEN
    ALTER TABLE agent_templates ADD CONSTRAINT agent_templates_software_build_owner_fk
      FOREIGN KEY(software_build_id,owner_id) REFERENCES portable_software_builds(id,owner_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='template_revisions_software_build_owner_fk') THEN
    ALTER TABLE template_revisions ADD CONSTRAINT template_revisions_software_build_owner_fk
      FOREIGN KEY(software_build_id,owner_id) REFERENCES portable_software_builds(id,owner_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='companions_software_build_owner_fk') THEN
    ALTER TABLE companions ADD CONSTRAINT companions_software_build_owner_fk
      FOREIGN KEY(software_build_id,owner_id) REFERENCES portable_software_builds(id,owner_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_portable_software_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'portable software records are immutable';
END $$;
DROP TRIGGER IF EXISTS portable_software_bases_immutable ON portable_software_bases;
CREATE TRIGGER portable_software_bases_immutable BEFORE UPDATE OR DELETE ON portable_software_bases
  FOR EACH ROW EXECUTE FUNCTION reject_portable_software_immutable_change();
DROP TRIGGER IF EXISTS portable_software_manifests_immutable ON portable_software_manifests;
CREATE TRIGGER portable_software_manifests_immutable BEFORE UPDATE OR DELETE ON portable_software_manifests
  FOR EACH ROW EXECUTE FUNCTION reject_portable_software_immutable_change();

-- desktop.sql
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_observed_generation bigint;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_broker_boot_id text;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_boundary_version integer NOT NULL DEFAULT 0;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_checked_at timestamptz;

-- box-observation.sql
ALTER TABLE companions DROP CONSTRAINT IF EXISTS companions_status_check;
ALTER TABLE companions ADD CONSTRAINT companions_status_check CHECK(status IN ('new','preparing','ready','error','archived'));
ALTER TABLE machine_usage_events ADD COLUMN IF NOT EXISTS closes_ready_event_id uuid REFERENCES machine_usage_events(id);
CREATE UNIQUE INDEX IF NOT EXISTS one_observed_archive_per_ready ON machine_usage_events(closes_ready_event_id) WHERE event='archived' AND closes_ready_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS machine_usage_events_companion_event_time ON machine_usage_events(companion_id,event,occurred_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS box_observations (
 ready_event_id uuid PRIMARY KEY REFERENCES machine_usage_events(id),
 companion_id uuid NOT NULL REFERENCES companions(id),owner_id text NOT NULL REFERENCES "user"(id),box_id text NOT NULL,
 attempted_at timestamptz NOT NULL,observed_at timestamptz,last_alive_at timestamptz,
 archive_after timestamptz,provider_updated_at timestamptz,
 state text NOT NULL DEFAULT 'unknown' CHECK(state IN ('alive','archived','unknown'))
);
CREATE INDEX IF NOT EXISTS box_observations_companion_time ON box_observations(companion_id,observed_at);
CREATE TABLE IF NOT EXISTS box_observation_gaps (
 ready_event_id uuid NOT NULL REFERENCES machine_usage_events(id),starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
 PRIMARY KEY(ready_event_id,starts_at),CHECK(ends_at>starts_at)
);

-- billing.sql
CREATE TABLE IF NOT EXISTS billing_accounts (
  owner_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  stripe_price_id text,
  subscription_status text,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  last_event_created bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (subscription_status IS NULL OR subscription_status IN ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused'))
);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  object_id text,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  stripe_subscription_id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL,
  stripe_price_id text,
  subscription_status text NOT NULL CHECK (subscription_status IN ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused')),
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  last_event_created bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,stripe_subscription_id)
);
CREATE INDEX IF NOT EXISTS billing_subscriptions_owner_idx ON billing_subscriptions(owner_id,stripe_customer_id);
INSERT INTO billing_subscriptions(stripe_subscription_id,owner_id,stripe_customer_id,stripe_price_id,subscription_status,current_period_end,cancel_at_period_end,last_event_created)
  SELECT stripe_subscription_id,owner_id,stripe_customer_id,stripe_price_id,subscription_status,current_period_end,cancel_at_period_end,last_event_created
  FROM billing_accounts WHERE stripe_subscription_id IS NOT NULL AND stripe_customer_id IS NOT NULL AND subscription_status IS NOT NULL
  ON CONFLICT (stripe_subscription_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS usage_ledger (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  companion_id uuid REFERENCES companions(id) ON DELETE SET NULL,
  operation_id text NOT NULL,
  category text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  stripe_delivery_status text NOT NULL DEFAULT 'pending' CHECK (stripe_delivery_status IN ('pending','sent','skipped')),
  stripe_delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, operation_id),
  CHECK (length(operation_id) BETWEEN 1 AND 200),
  CHECK (length(category) BETWEEN 1 AND 80),
  CHECK (length(unit) BETWEEN 1 AND 40)
);
CREATE INDEX IF NOT EXISTS usage_ledger_owner_time_idx ON usage_ledger(owner_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_ledger_pending_idx ON usage_ledger(stripe_delivery_status, created_at) WHERE stripe_delivery_status='pending';
ALTER TABLE usage_ledger DROP CONSTRAINT IF EXISTS usage_ledger_category_unit_check;
ALTER TABLE usage_ledger ADD CONSTRAINT usage_ledger_category_unit_check CHECK (
  (category='model_tokens' AND unit='token') OR
  (category='box_seconds' AND unit='second') OR
  (category='box_lifecycle' AND unit='event')
) NOT VALID;

-- delivery.sql
CREATE TABLE IF NOT EXISTS companion_deliveries (
  id uuid PRIMARY KEY,
  source_owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  source_companion_id uuid REFERENCES companions(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  profile_snapshot jsonb NOT NULL,
  template_profiles jsonb NOT NULL DEFAULT '[]'::jsonb,
  maintenance_requested boolean NOT NULL DEFAULT false,
  email_status text NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending','sending','sent','unknown','skipped')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  expires_at timestamptz NOT NULL,
  accepted_by text REFERENCES "user"(id) ON DELETE SET NULL,
  delivered_companion_id uuid REFERENCES companions(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (recipient_email = lower(recipient_email))
);
ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS client_delivery_id uuid;
ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE companion_deliveries DROP CONSTRAINT IF EXISTS companion_deliveries_email_status_check;
ALTER TABLE companion_deliveries ADD CONSTRAINT companion_deliveries_email_status_check CHECK (email_status IN ('pending','sending','sent','unknown','skipped'));
UPDATE companion_deliveries SET client_delivery_id=id WHERE client_delivery_id IS NULL;
UPDATE companion_deliveries SET request_fingerprint=encode(sha256(id::text::bytea),'hex') WHERE request_fingerprint IS NULL;
ALTER TABLE companion_deliveries ALTER COLUMN client_delivery_id SET NOT NULL;
ALTER TABLE companion_deliveries ALTER COLUMN request_fingerprint SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS companion_delivery_client_id ON companion_deliveries(source_owner_id,client_delivery_id);
CREATE INDEX IF NOT EXISTS companion_deliveries_sender_idx ON companion_deliveries(source_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS companion_deliveries_recipient_idx ON companion_deliveries(recipient_email, created_at DESC);

CREATE TABLE IF NOT EXISTS companion_maintenance_grants (
  delivery_id uuid PRIMARY KEY REFERENCES companion_deliveries(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  client_owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  maintainer_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (client_owner_id <> maintainer_id)
);
CREATE INDEX IF NOT EXISTS companion_maintenance_access_idx ON companion_maintenance_grants(maintainer_id, companion_id) WHERE revoked_at IS NULL;

-- maintenance.sql
CREATE TABLE IF NOT EXISTS maintenance_actions (
 id uuid PRIMARY KEY,grant_id uuid NOT NULL REFERENCES companion_maintenance_grants(delivery_id),
 actor_id text NOT NULL REFERENCES "user"(id),companion_id uuid NOT NULL REFERENCES companions(id),
 operation text NOT NULL CHECK(operation IN ('configure','prepare','task')),
 run_id uuid REFERENCES runs(id),created_at timestamptz NOT NULL DEFAULT now()
);

-- delivery-skills.sql
CREATE TABLE IF NOT EXISTS portable_skill_bundles (
 id uuid PRIMARY KEY, source_owner_id text NOT NULL, source_companion_id uuid NOT NULL,
 manifest_version integer NOT NULL CHECK(manifest_version=1), bundle_hash text NOT NULL CHECK(bundle_hash ~ '^[0-9a-f]{64}$'),
 object_sha256 text NOT NULL CHECK(object_sha256 ~ '^[0-9a-f]{64}$'), byte_size integer NOT NULL CHECK(byte_size BETWEEN 25 AND 15000000),
 storage_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS portable_skill_exports (
 id uuid PRIMARY KEY, delivery_id uuid REFERENCES companion_deliveries(id) ON DELETE CASCADE,
 source_owner_id text NOT NULL, source_companion_id uuid NOT NULL,
 target_kind text NOT NULL CHECK(target_kind IN ('delivery_main','delivery_template','template_revision')),
 source_template_id uuid, target_revision integer,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','error')),
 bundle_id uuid REFERENCES portable_skill_bundles(id), error text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 CHECK((target_kind='delivery_main' AND delivery_id IS NOT NULL AND source_template_id IS NULL AND target_revision IS NULL)
   OR (target_kind='delivery_template' AND delivery_id IS NOT NULL AND source_template_id IS NOT NULL AND target_revision IS NULL)
   OR (target_kind='template_revision' AND delivery_id IS NULL AND source_template_id IS NOT NULL AND target_revision IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS portable_export_delivery_main_uq ON portable_skill_exports(delivery_id) WHERE target_kind='delivery_main';
CREATE UNIQUE INDEX IF NOT EXISTS portable_export_delivery_template_uq ON portable_skill_exports(delivery_id,source_template_id) WHERE target_kind='delivery_template';
CREATE UNIQUE INDEX IF NOT EXISTS portable_export_template_revision_uq ON portable_skill_exports(source_template_id,target_revision) WHERE target_kind='template_revision';
CREATE INDEX IF NOT EXISTS portable_export_pending_idx ON portable_skill_exports(status,created_at) WHERE status='pending';

ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS include_skills boolean NOT NULL DEFAULT false;
ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS skills_status text NOT NULL DEFAULT 'ready' CHECK(skills_status IN ('pending','ready','error'));
ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS skills_error text;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS skill_bundle_id uuid REFERENCES portable_skill_bundles(id);
ALTER TABLE companions ADD COLUMN IF NOT EXISTS skills_staged_hash text;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS skills_staged_box_id text;
ALTER TABLE IF EXISTS agent_templates ADD COLUMN IF NOT EXISTS skill_bundle_id uuid REFERENCES portable_skill_bundles(id);
ALTER TABLE IF EXISTS template_revisions ADD COLUMN IF NOT EXISTS skill_bundle_id uuid REFERENCES portable_skill_bundles(id);

-- software-results.sql
-- Verified public package images can be shared after delivery consent. Build jobs,
-- source Boxes and their private state remain confined to the original owner.
CREATE TABLE IF NOT EXISTS portable_software_results (
  id uuid PRIMARY KEY,
  source_build_id uuid NOT NULL UNIQUE REFERENCES portable_software_builds(id) ON DELETE RESTRICT,
  base_id text NOT NULL REFERENCES portable_software_bases(id) ON DELETE RESTRICT,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  provider_snapshot_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(id=source_build_id)
);
CREATE TABLE IF NOT EXISTS portable_software_result_grants (
  result_id uuid NOT NULL REFERENCES portable_software_results(id) ON DELETE RESTRICT,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  delivery_id uuid REFERENCES companion_deliveries(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(result_id,owner_id)
);
ALTER TABLE portable_software_builds ADD COLUMN IF NOT EXISTS result_id uuid REFERENCES portable_software_results(id) ON DELETE RESTRICT;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS software_result_id uuid;
ALTER TABLE template_revisions ADD COLUMN IF NOT EXISTS software_result_id uuid;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS software_result_id uuid;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='software_build_result_identity') THEN
    ALTER TABLE portable_software_builds ADD CONSTRAINT software_build_result_identity CHECK(result_id IS NULL OR result_id=id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='templates_software_result_grant_fk') THEN
    ALTER TABLE agent_templates ADD CONSTRAINT templates_software_result_grant_fk
      FOREIGN KEY(software_result_id,owner_id) REFERENCES portable_software_result_grants(result_id,owner_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='revisions_software_result_grant_fk') THEN
    ALTER TABLE template_revisions ADD CONSTRAINT revisions_software_result_grant_fk
      FOREIGN KEY(software_result_id,owner_id) REFERENCES portable_software_result_grants(result_id,owner_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companions_software_result_grant_fk') THEN
    ALTER TABLE companions ADD CONSTRAINT companions_software_result_grant_fk
      FOREIGN KEY(software_result_id,owner_id) REFERENCES portable_software_result_grants(result_id,owner_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='agent_templates_software_single_pin') THEN
    ALTER TABLE agent_templates ADD CONSTRAINT agent_templates_software_single_pin CHECK(software_build_id IS NULL OR software_result_id IS NULL);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='template_revisions_software_single_pin') THEN
    ALTER TABLE template_revisions ADD CONSTRAINT template_revisions_software_single_pin CHECK(software_build_id IS NULL OR software_result_id IS NULL);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companions_software_single_pin') THEN
    ALTER TABLE companions ADD CONSTRAINT companions_software_single_pin CHECK(software_build_id IS NULL OR software_result_id IS NULL);
  END IF;
END $$;
DROP TRIGGER IF EXISTS portable_software_results_immutable ON portable_software_results;
CREATE TRIGGER portable_software_results_immutable BEFORE UPDATE OR DELETE ON portable_software_results
  FOR EACH ROW EXECUTE FUNCTION reject_portable_software_immutable_change();
DROP TRIGGER IF EXISTS portable_software_result_grants_immutable ON portable_software_result_grants;
CREATE TRIGGER portable_software_result_grants_immutable BEFORE UPDATE OR DELETE ON portable_software_result_grants
  FOR EACH ROW EXECUTE FUNCTION reject_portable_software_immutable_change();

ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS software_status text NOT NULL DEFAULT 'ready'
  CHECK(software_status IN ('pending','ready','error'));
ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS software_error text;
CREATE TABLE IF NOT EXISTS delivery_software_targets (
  delivery_id uuid NOT NULL REFERENCES companion_deliveries(id) ON DELETE RESTRICT,
  target_key text NOT NULL CHECK(target_key='main' OR target_key ~ '^[0-9a-f-]{36}$'),
  source_owner_id text NOT NULL,
  source_template_revision integer CHECK(source_template_revision>0),
  source_build_id uuid,
  source_result_id uuid,
  PRIMARY KEY(delivery_id,target_key),
  CHECK((source_build_id IS NOT NULL)::int+(source_result_id IS NOT NULL)::int=1),
  FOREIGN KEY(source_build_id,source_owner_id) REFERENCES portable_software_builds(id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(source_result_id,source_owner_id) REFERENCES portable_software_result_grants(result_id,owner_id) ON DELETE RESTRICT
);
DROP TRIGGER IF EXISTS delivery_software_targets_immutable ON delivery_software_targets;
CREATE TRIGGER delivery_software_targets_immutable BEFORE UPDATE OR DELETE ON delivery_software_targets
  FOR EACH ROW EXECUTE FUNCTION reject_portable_software_immutable_change();

-- events.sql
CREATE OR REPLACE FUNCTION notify_companion_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed_companion_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'companions' THEN
    changed_companion_id := COALESCE(NEW.id, OLD.id);
  ELSE
    changed_companion_id := COALESCE(NEW.companion_id, OLD.companion_id);
  END IF;
  PERFORM pg_notify('companion_changed', changed_companion_id::text);
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Child work is displayed in its permanent parent's durable thread snapshot. Notify the parent
-- when that relationship appears or its child's persisted state changes; the API listener still
-- coalesces repeated transaction notifications before sending an invalidation.
CREATE OR REPLACE FUNCTION notify_companion_parent_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_companion_id uuid;
  child_companion_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'delegations' THEN
    parent_companion_id := COALESCE(NEW.parent_id, OLD.parent_id);
  ELSIF TG_TABLE_NAME = 'companions' THEN
    parent_companion_id := COALESCE(NEW.parent_id, OLD.parent_id);
  ELSE
    child_companion_id := COALESCE(NEW.companion_id, OLD.companion_id);
    SELECT parent_id INTO parent_companion_id FROM companions WHERE id=child_companion_id;
  END IF;
  IF parent_companion_id IS NOT NULL THEN
    PERFORM pg_notify('companion_changed', parent_companion_id::text);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE
  table_name text;
  trigger_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['companions', 'runs', 'messages', 'task_questions', 'attachments'] LOOP
    trigger_name := table_name || '_companion_changed';
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = trigger_name AND tgrelid = table_name::regclass AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_companion_changed()',
        trigger_name,
        table_name
      );
    END IF;
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='delegations_parent_companion_changed' AND NOT tgisinternal) THEN
    CREATE TRIGGER delegations_parent_companion_changed AFTER INSERT OR UPDATE OR DELETE ON delegations
      FOR EACH ROW EXECUTE FUNCTION notify_companion_parent_changed();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='children_parent_companion_changed' AND NOT tgisinternal) THEN
    CREATE TRIGGER children_parent_companion_changed AFTER INSERT OR UPDATE OR DELETE ON companions
      FOR EACH ROW EXECUTE FUNCTION notify_companion_parent_changed();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='child_runs_parent_companion_changed' AND NOT tgisinternal) THEN
    CREATE TRIGGER child_runs_parent_companion_changed AFTER INSERT OR UPDATE OR DELETE ON runs
      FOR EACH ROW EXECUTE FUNCTION notify_companion_parent_changed();
  END IF;
END;
$$;

-- Team projections include the owner's available profiles as well as per-parent permissions.
-- Only committed changes send identifier-only hints; readers still enforce ownership.
CREATE OR REPLACE FUNCTION notify_companion_team_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'template_permissions' THEN
    PERFORM pg_notify('companion_changed', COALESCE(NEW.parent_id, OLD.parent_id)::text);
  ELSE
    FOR affected_id IN SELECT id FROM companions
      WHERE owner_id=COALESCE(NEW.owner_id, OLD.owner_id) AND retired_at IS NULL LOOP
      PERFORM pg_notify('companion_changed', affected_id::text);
    END LOOP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='permissions_team_changed' AND tgrelid='template_permissions'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER permissions_team_changed AFTER INSERT OR UPDATE OR DELETE ON template_permissions
      FOR EACH ROW EXECUTE FUNCTION notify_companion_team_changed();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='templates_team_changed' AND tgrelid='agent_templates'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER templates_team_changed AFTER INSERT OR UPDATE OR DELETE ON agent_templates
      FOR EACH ROW EXECUTE FUNCTION notify_companion_team_changed();
  END IF;
END;
$$;

-- model-gateway.sql
ALTER TABLE runs ADD COLUMN IF NOT EXISTS model_provider text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS usage_source text NOT NULL DEFAULT 'agent' CHECK(usage_source IN ('agent','gateway'));
CREATE TABLE IF NOT EXISTS model_gateway_requests (
 id uuid PRIMARY KEY,
 run_id uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
 companion_id uuid NOT NULL REFERENCES companions(id) ON DELETE RESTRICT,
 owner_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
 provider text NOT NULL CHECK(provider IN ('google','anthropic','openai','openrouter','zai','azure','deepseek')),
 model_id text NOT NULL,
 api text NOT NULL CHECK(api IN ('google-generative-ai','anthropic-messages','openai-responses','openai-completions')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'forwarding' CHECK(status IN ('forwarding','succeeded','failed','interrupted')),
 upstream_status integer,
 error_code text CHECK(error_code ~ '^[a-z0-9_]{1,80}$'),
 usage jsonb CHECK(usage IS NULL OR jsonb_typeof(usage)='object'),
 usage_verified boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 CHECK(NOT usage_verified OR (usage IS NOT NULL AND status IN ('succeeded','failed')))
);
-- Existing installations keep every request tombstone and gain the Azure and DeepSeek routes.
ALTER TABLE model_gateway_requests DROP CONSTRAINT IF EXISTS model_gateway_requests_provider_check;
ALTER TABLE model_gateway_requests ADD CONSTRAINT model_gateway_requests_provider_check
 CHECK(provider IN ('google','anthropic','openai','openrouter','zai','azure','deepseek'));
CREATE UNIQUE INDEX IF NOT EXISTS model_gateway_one_active_request ON model_gateway_requests(run_id) WHERE status='forwarding';
CREATE INDEX IF NOT EXISTS model_gateway_billable_requests ON model_gateway_requests(finished_at,id) WHERE usage_verified;

-- specialist-drafts.sql
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS prepared_disk_snapshot text;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS has_published boolean NOT NULL DEFAULT true;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS init_script text NOT NULL DEFAULT '';
ALTER TABLE template_revisions ADD COLUMN IF NOT EXISTS init_script text NOT NULL DEFAULT '';
ALTER TABLE companions ADD COLUMN IF NOT EXISTS specialist_draft_id uuid REFERENCES agent_templates(id);
ALTER TABLE companions ADD COLUMN IF NOT EXISTS init_script text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS specialist_drafts (
 template_id uuid PRIMARY KEY REFERENCES agent_templates(id),
 companion_id uuid NOT NULL UNIQUE REFERENCES companions(id),
 generation integer NOT NULL DEFAULT 1,
 base_revision integer NOT NULL,
 name text NOT NULL, instructions text NOT NULL DEFAULT '', init_script text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'editing' CHECK(status IN ('editing','capturing','testing','publishing','error')),
 error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE specialist_drafts ADD COLUMN IF NOT EXISTS identity_revision integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS specialist_operations (
 id uuid PRIMARY KEY, template_id uuid NOT NULL REFERENCES agent_templates(id),
 owner_id text NOT NULL REFERENCES "user"(id), generation integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('test','publish')), fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','freezing','capturing','preparing','running','succeeded','failed')),
 prompt text, content_reviewed boolean NOT NULL DEFAULT false,
 snapshot_name text NOT NULL UNIQUE, source_snapshot_name text NOT NULL UNIQUE,
 image_companion_id uuid REFERENCES companions(id), test_companion_id uuid REFERENCES companions(id), run_id uuid REFERENCES runs(id),
 capture_attempted_at timestamptz, image_capture_attempted_at timestamptz,
 sanitized_at timestamptz, error text, assessment text CHECK(assessment IN ('satisfactory','needs_changes')),
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS specialist_one_operation ON specialist_operations(template_id)
 WHERE status IN ('queued','freezing','capturing','preparing','running');
CREATE TABLE IF NOT EXISTS specialist_connections (
 template_id uuid NOT NULL REFERENCES agent_templates(id), slot text NOT NULL,
 account_id uuid REFERENCES plugin_accounts(id) ON DELETE SET NULL,
 required boolean NOT NULL DEFAULT true, PRIMARY KEY(template_id,slot)
);
CREATE TABLE IF NOT EXISTS specialist_connection_overrides (
 parent_id uuid NOT NULL REFERENCES companions(id), template_id uuid NOT NULL REFERENCES agent_templates(id),
 slot text NOT NULL, account_id uuid REFERENCES plugin_accounts(id) ON DELETE SET NULL,
 PRIMARY KEY(parent_id,template_id,slot)
);
CREATE TABLE IF NOT EXISTS specialist_improvements (
 id uuid PRIMARY KEY, template_id uuid NOT NULL REFERENCES agent_templates(id),
 owner_id text NOT NULL REFERENCES "user"(id), source_companion_id uuid NOT NULL REFERENCES companions(id),
 parent_id uuid NOT NULL REFERENCES companions(id), base_revision integer NOT NULL,
 summary text NOT NULL, recipe text NOT NULL,
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','applied','rejected')),
 applied_generation integer, created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE template_revisions ADD COLUMN IF NOT EXISTS prepared_disk_snapshot text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS init_warning text;

ALTER TABLE specialist_connections ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'custom';
ALTER TABLE specialist_connections ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT 'Integration';
ALTER TABLE specialist_connections ADD COLUMN IF NOT EXISTS server_id text;
CREATE TABLE IF NOT EXISTS specialist_revision_connections (
 template_id uuid NOT NULL REFERENCES agent_templates(id), revision integer NOT NULL, slot text NOT NULL,
 account_id uuid REFERENCES plugin_accounts(id) ON DELETE SET NULL, required boolean NOT NULL,
 provider text NOT NULL,label text NOT NULL,server_id text,PRIMARY KEY(template_id,revision,slot)
);

CREATE TABLE IF NOT EXISTS specialist_test_assessments (
 id uuid PRIMARY KEY, operation_id uuid NOT NULL REFERENCES specialist_operations(id),owner_id text NOT NULL,
 assessment text NOT NULL CHECK(assessment IN ('satisfactory','needs_changes')),created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE specialist_operations DROP CONSTRAINT IF EXISTS specialist_operations_status_check;
ALTER TABLE specialist_operations ADD CONSTRAINT specialist_operations_status_check CHECK(status IN ('queued','freezing','capturing','preparing','running','succeeded','failed'));

ALTER TABLE specialist_operations ADD COLUMN IF NOT EXISTS test_files_saved_at timestamptz;

ALTER TABLE companions ADD COLUMN IF NOT EXISTS provider_ttl_checked_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS provider_ttl_target_until timestamptz;
-- Test and publication may deliberately reference the exact same immutable image.
ALTER TABLE specialist_operations DROP CONSTRAINT IF EXISTS specialist_operations_snapshot_name_key;
ALTER TABLE specialist_operations DROP CONSTRAINT IF EXISTS specialist_operations_source_snapshot_name_key;

CREATE TABLE IF NOT EXISTS specialist_guidance (
 id uuid PRIMARY KEY,
 template_id uuid NOT NULL REFERENCES specialist_drafts(template_id),
 run_id uuid NOT NULL REFERENCES runs(id),
 kind text NOT NULL CHECK(kind IN ('profile','connections','test','publish')),
 message text NOT NULL,
 providers jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS specialist_guidance_latest ON specialist_guidance(template_id,created_at DESC);

ALTER TABLE specialist_guidance ADD COLUMN IF NOT EXISTS responded_at timestamptz;

-- admission.sql
ALTER TABLE companions ADD COLUMN IF NOT EXISTS machine_activity_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS keep_alive_until timestamptz;

CREATE TABLE IF NOT EXISTS machine_account_limits (
 owner_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
 offer_active_limit integer NOT NULL DEFAULT 2 CHECK(offer_active_limit BETWEEN 0 AND 1000),
 personal_active_limit integer CHECK(personal_active_limit BETWEEN 0 AND 1000),
 starts_per_hour_limit integer NOT NULL DEFAULT 10 CHECK(starts_per_hour_limit BETWEEN 0 AND 10000),
 queue_limit integer NOT NULL DEFAULT 20 CHECK(queue_limit BETWEEN 0 AND 1000),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS machine_provider_limits (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 active_limit integer NOT NULL DEFAULT 1000 CHECK(active_limit BETWEEN 0 AND 100000),
 starts_per_minute_limit integer NOT NULL DEFAULT 1000 CHECK(starts_per_minute_limit BETWEEN 0 AND 100000),
 starts_per_hour_limit integer NOT NULL DEFAULT 10000 CHECK(starts_per_hour_limit BETWEEN 0 AND 1000000),
 starts_per_day_limit integer NOT NULL DEFAULT 100000 CHECK(starts_per_day_limit BETWEEN 0 AND 10000000),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE machine_provider_limits ADD COLUMN IF NOT EXISTS starts_per_minute_limit integer NOT NULL DEFAULT 1000 CHECK(starts_per_minute_limit BETWEEN 0 AND 100000);
ALTER TABLE machine_provider_limits ADD COLUMN IF NOT EXISTS starts_per_hour_limit integer NOT NULL DEFAULT 10000 CHECK(starts_per_hour_limit BETWEEN 0 AND 1000000);
ALTER TABLE machine_provider_limits ADD COLUMN IF NOT EXISTS starts_per_day_limit integer NOT NULL DEFAULT 100000 CHECK(starts_per_day_limit BETWEEN 0 AND 10000000);
INSERT INTO machine_provider_limits(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;
ALTER TABLE machine_provider_limits ADD COLUMN IF NOT EXISTS cooldown_until timestamptz;

CREATE TABLE IF NOT EXISTS machine_admission_requests (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 companion_id uuid NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('configuration','test','intervention','improvement','capture','resume')),
 fingerprint text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','admitted','cancelling','cancelled','completed','refused')),
 waiting_reason text,
 requested_at timestamptz NOT NULL DEFAULT now(),
 admitted_at timestamptz,
 start_counted boolean NOT NULL DEFAULT false,
 cancelled_at timestamptz,
 released_at timestamptz,
 UNIQUE(owner_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_machine_admission_per_companion
 ON machine_admission_requests(companion_id) WHERE state IN ('queued','admitted','cancelling');
CREATE INDEX IF NOT EXISTS machine_admission_owner_queue
 ON machine_admission_requests(owner_id,requested_at,id) WHERE state='queued';
CREATE INDEX IF NOT EXISTS machine_admission_recent_starts
 ON machine_admission_requests(owner_id,admitted_at) WHERE start_counted AND admitted_at IS NOT NULL;

-- conversation.sql
-- Sequence zero preserves user messages and final responses from older runtimes.
-- New runtimes keep a stable sequence for every visible assistant message.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sequence integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS complete boolean NOT NULL DEFAULT true;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_run_id_role_key;
CREATE UNIQUE INDEX IF NOT EXISTS messages_run_role_sequence ON messages(run_id,role,sequence);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS message_version bigint;

-- chat.sql
-- Timeline scans are always scoped to one Companion and ordered by their durable sort key.
CREATE INDEX IF NOT EXISTS messages_chat_page ON messages(companion_id,created_at,sequence,id);
CREATE INDEX IF NOT EXISTS task_questions_chat_page ON task_questions(companion_id,created_at,id);
CREATE INDEX IF NOT EXISTS runs_chat_page ON runs(companion_id,created_at,id);
CREATE INDEX IF NOT EXISTS messages_run_assistant_page ON messages(run_id,created_at,sequence,id) WHERE role='assistant';

-- managed-base-image.sql
CREATE TABLE IF NOT EXISTS managed_base_image_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  namespace uuid NOT NULL,
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO managed_base_image_state(singleton,namespace)
VALUES(true,gen_random_uuid())
ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS managed_base_images (
  id uuid PRIMARY KEY,
  release_digest text NOT NULL CHECK(release_digest ~ '^[0-9a-f]{64}$'),
  generation integer NOT NULL CHECK(generation > 0),
  snapshot_name text NOT NULL UNIQUE CHECK(snapshot_name ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  archive bytea NOT NULL,
  journal jsonb NOT NULL CHECK(jsonb_typeof(journal)='object'),
  status text NOT NULL DEFAULT 'publishing'
    CHECK(status IN ('publishing','ready','retired','missing','failed','blocked','deleted')),
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  retry_at timestamptz,
  provider_checked_at timestamptz,
  delete_intent_at timestamptz,
  ready_at timestamptz,
  retired_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(release_digest,generation)
);

CREATE UNIQUE INDEX IF NOT EXISTS managed_base_image_one_ready
  ON managed_base_images(release_digest) WHERE status='ready';
CREATE INDEX IF NOT EXISTS managed_base_image_work
  ON managed_base_images(status,retry_at,created_at) WHERE status IN ('publishing','retired','missing','failed');

-- runtime-updates.sql
ALTER TABLE companions ADD COLUMN IF NOT EXISTS runtime_version text;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS runtime_update_target text;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS runtime_update_status text NOT NULL DEFAULT 'pending'
 CHECK(runtime_update_status IN ('pending','updating','current','deferred','failed','blocked'));
ALTER TABLE companions ADD COLUMN IF NOT EXISTS runtime_update_error text;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS runtime_update_checked_at timestamptz;
CREATE TABLE IF NOT EXISTS runtime_updates (
 id uuid PRIMARY KEY,
 companion_id uuid NOT NULL REFERENCES companions(id),
 box_id text NOT NULL,
 target_version text NOT NULL CHECK(target_version ~ '^[a-f0-9]{64}$'),
 manifest jsonb NOT NULL,
 installer_sha256 text NOT NULL CHECK(installer_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('staging','draining','applying','verifying','succeeded','deferred','failed','blocked')),
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_runtime_update_per_companion ON runtime_updates(companion_id) WHERE finished_at IS NULL;
