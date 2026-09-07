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
