ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_observed_generation bigint;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_broker_boot_id text;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_boundary_version integer NOT NULL DEFAULT 0;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_checked_at timestamptz;
