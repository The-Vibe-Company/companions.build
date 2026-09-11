ALTER TABLE companions ADD COLUMN IF NOT EXISTS snapshot_name text;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS ready_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS archive_requested_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_paused_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS preparation_started_at timestamptz;
CREATE TABLE IF NOT EXISTS machine_usage_events(id uuid PRIMARY KEY,companion_id uuid NOT NULL REFERENCES companions(id),owner_id text NOT NULL REFERENCES "user"(id),event text NOT NULL CHECK(event IN ('starting','ready','archived')),occurred_at timestamptz NOT NULL DEFAULT now(),reported_at timestamptz);
