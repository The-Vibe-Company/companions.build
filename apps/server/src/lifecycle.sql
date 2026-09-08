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
