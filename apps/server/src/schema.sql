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
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(companion_id) WHERE status IN ('preparing','running');
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
