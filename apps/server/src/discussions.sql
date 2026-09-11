CREATE TABLE IF NOT EXISTS discussion_folders (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 companion_ids uuid[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,owner_id)
);
CREATE TABLE IF NOT EXISTS discussions (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 folder_id uuid, direct_companion_id uuid REFERENCES companions(id),
 creation_fingerprint text NOT NULL, archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(folder_id,owner_id) REFERENCES discussion_folders(id,owner_id), UNIQUE(id,owner_id)
);
CREATE INDEX IF NOT EXISTS discussions_owner_recent ON discussions(owner_id,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS discussion_participants (
 discussion_id uuid NOT NULL REFERENCES discussions(id), companion_id uuid NOT NULL REFERENCES companions(id),
 joined_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz,
 PRIMARY KEY(discussion_id,companion_id)
);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS discussion_id uuid REFERENCES discussions(id);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS coordinator_run_id uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS discussion_reported_at timestamptz;
CREATE INDEX IF NOT EXISTS runs_discussion ON runs(discussion_id,created_at,id);
CREATE TABLE IF NOT EXISTS discussion_runs (
 id uuid PRIMARY KEY, discussion_id uuid NOT NULL REFERENCES discussions(id),
 client_message_id uuid NOT NULL, content text NOT NULL,
 attachment_count integer NOT NULL DEFAULT 0 CHECK(attachment_count BETWEEN 0 AND 5),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','interrupted','cancelled')),
 cancel_requested boolean NOT NULL DEFAULT false, leader_pid integer,
 preview_text text, error text, model_provider text, model_id text,
 model_messages jsonb, usage jsonb, source_run_id uuid REFERENCES runs(id),
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 UNIQUE(discussion_id,client_message_id), UNIQUE(source_run_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_central_discussion_run ON discussion_runs(discussion_id) WHERE status='running';
CREATE TABLE IF NOT EXISTS discussion_sends (
 discussion_id uuid NOT NULL REFERENCES discussions(id), client_message_id uuid NOT NULL,
 run_id uuid NOT NULL, companion_id uuid REFERENCES companions(id), fingerprint text NOT NULL,
 PRIMARY KEY(discussion_id,client_message_id)
);
CREATE TABLE IF NOT EXISTS discussion_messages (
 id uuid PRIMARY KEY, sequence bigserial UNIQUE NOT NULL,
 discussion_id uuid NOT NULL REFERENCES discussions(id),
 role text NOT NULL CHECK(role IN ('user','assistant','system')),
 content text NOT NULL, companion_id uuid REFERENCES companions(id), run_id uuid NOT NULL,
 source_message_id uuid UNIQUE, complete boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discussion_messages_page ON discussion_messages(discussion_id,sequence);
CREATE TABLE IF NOT EXISTS discussion_proposals (
 id uuid PRIMARY KEY, discussion_id uuid NOT NULL REFERENCES discussions(id),
 run_id uuid NOT NULL REFERENCES discussion_runs(id), companion_id uuid NOT NULL REFERENCES companions(id),
 reason text NOT NULL, prompt text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 UNIQUE(run_id,companion_id)
);
CREATE TABLE IF NOT EXISTS discussion_tool_calls (
 run_id uuid NOT NULL REFERENCES discussion_runs(id), call_id text NOT NULL,
 name text NOT NULL, fingerprint text NOT NULL, result jsonb,
 PRIMARY KEY(run_id,call_id)
);
CREATE TABLE IF NOT EXISTS discussion_uploads (
 id uuid PRIMARY KEY, discussion_id uuid NOT NULL REFERENCES discussions(id),
 run_id uuid NOT NULL REFERENCES discussion_runs(id), client_file_id uuid NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 4), filename text NOT NULL,
 content_type text NOT NULL, byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
 sha256 text NOT NULL, storage_key text NOT NULL, ready boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,position), UNIQUE(run_id,client_file_id)
);
ALTER TABLE model_gateway_requests ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE model_gateway_requests ALTER COLUMN companion_id DROP NOT NULL;
ALTER TABLE model_gateway_requests ADD COLUMN IF NOT EXISTS discussion_run_id uuid REFERENCES discussion_runs(id);
CREATE UNIQUE INDEX IF NOT EXISTS central_gateway_active ON model_gateway_requests(discussion_run_id) WHERE status='forwarding';

-- Existing principal chat becomes one direct discussion; other discussions start separately.
INSERT INTO discussions(id,owner_id,title,direct_companion_id,creation_fingerprint,created_at,updated_at)
 SELECT id,owner_id,name,id,'legacy',created_at,created_at FROM companions c
 WHERE owner_id IS NOT NULL AND NOT COALESCE((to_jsonb(c)->>'temporary')::boolean,false) AND to_jsonb(c)->>'specialist_draft_id' IS NULL
 ON CONFLICT(id) DO NOTHING;
INSERT INTO discussion_participants(discussion_id,companion_id)
 SELECT id,direct_companion_id FROM discussions WHERE direct_companion_id IS NOT NULL
 ON CONFLICT DO NOTHING;
UPDATE runs r SET discussion_id=c.id FROM companions c
 WHERE r.companion_id=c.id AND r.discussion_id IS NULL AND r.lane='main' AND r.source IN ('chat','background','delegation')
 AND EXISTS(SELECT 1 FROM discussions d WHERE d.id=c.id);
INSERT INTO discussion_messages(id,discussion_id,role,content,companion_id,run_id,source_message_id,complete,created_at)
 SELECT m.id,r.discussion_id,m.role,m.content,m.companion_id,m.run_id,m.id,m.complete,m.created_at
 FROM messages m JOIN runs r ON r.id=m.run_id WHERE r.discussion_id IS NOT NULL
 ORDER BY m.created_at,m.sequence,m.id ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS discussion_task_files (
 run_id uuid NOT NULL REFERENCES runs(id),file_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 4),
 PRIMARY KEY(run_id,file_id),UNIQUE(run_id,position)
);
