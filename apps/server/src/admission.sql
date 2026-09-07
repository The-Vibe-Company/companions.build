ALTER TABLE companions ADD COLUMN IF NOT EXISTS machine_activity_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS keep_alive_until timestamptz;

CREATE TABLE IF NOT EXISTS machine_account_limits (
 owner_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
 offer_active_limit integer NOT NULL DEFAULT 2 CHECK(offer_active_limit BETWEEN 0 AND 1000),
 personal_active_limit integer CHECK(personal_active_limit BETWEEN 0 AND 1000),
 starts_per_hour_limit integer NOT NULL DEFAULT 10 CHECK(starts_per_hour_limit BETWEEN 0 AND 10000),
 queue_limit integer NOT NULL DEFAULT 20 CHECK(queue_limit BETWEEN 0 AND 1000),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS machine_provider_limits (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 active_limit integer NOT NULL DEFAULT 1000 CHECK(active_limit BETWEEN 0 AND 100000),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO machine_provider_limits(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS machine_admission_requests (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 companion_id uuid NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('configuration','test','intervention','improvement','capture','resume')),
 fingerprint text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','admitted','cancelling','cancelled','completed','refused')),
 waiting_reason text,
 requested_at timestamptz NOT NULL DEFAULT now(),
 admitted_at timestamptz,
 start_counted boolean NOT NULL DEFAULT false,
 cancelled_at timestamptz,
 released_at timestamptz,
 UNIQUE(owner_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_machine_admission_per_companion
 ON machine_admission_requests(companion_id) WHERE state IN ('queued','admitted','cancelling');
CREATE INDEX IF NOT EXISTS machine_admission_owner_queue
 ON machine_admission_requests(owner_id,requested_at,id) WHERE state='queued';
CREATE INDEX IF NOT EXISTS machine_admission_recent_starts
 ON machine_admission_requests(owner_id,admitted_at) WHERE start_counted AND admitted_at IS NOT NULL;
