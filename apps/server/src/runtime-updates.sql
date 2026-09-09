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
