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
