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
