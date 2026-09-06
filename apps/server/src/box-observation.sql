ALTER TABLE companions DROP CONSTRAINT IF EXISTS companions_status_check;
ALTER TABLE companions ADD CONSTRAINT companions_status_check CHECK(status IN ('new','preparing','ready','error','archived'));
ALTER TABLE machine_usage_events ADD COLUMN IF NOT EXISTS closes_ready_event_id uuid REFERENCES machine_usage_events(id);
CREATE UNIQUE INDEX IF NOT EXISTS one_observed_archive_per_ready ON machine_usage_events(closes_ready_event_id) WHERE event='archived' AND closes_ready_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS machine_usage_events_companion_event_time ON machine_usage_events(companion_id,event,occurred_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS box_observations (
 ready_event_id uuid PRIMARY KEY REFERENCES machine_usage_events(id),
 companion_id uuid NOT NULL REFERENCES companions(id),owner_id text NOT NULL REFERENCES "user"(id),box_id text NOT NULL,
 attempted_at timestamptz NOT NULL,observed_at timestamptz,last_alive_at timestamptz,
 archive_after timestamptz,provider_updated_at timestamptz,
 state text NOT NULL DEFAULT 'unknown' CHECK(state IN ('alive','archived','unknown'))
);
CREATE INDEX IF NOT EXISTS box_observations_companion_time ON box_observations(companion_id,observed_at);
CREATE TABLE IF NOT EXISTS box_observation_gaps (
 ready_event_id uuid NOT NULL REFERENCES machine_usage_events(id),starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
 PRIMARY KEY(ready_event_id,starts_at),CHECK(ends_at>starts_at)
);
