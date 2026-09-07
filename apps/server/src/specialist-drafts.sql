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
