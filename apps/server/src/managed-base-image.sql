CREATE TABLE IF NOT EXISTS managed_base_image_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  namespace uuid NOT NULL,
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO managed_base_image_state(singleton,namespace)
VALUES(true,gen_random_uuid())
ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS managed_base_images (
  id uuid PRIMARY KEY,
  release_digest text NOT NULL CHECK(release_digest ~ '^[0-9a-f]{64}$'),
  generation integer NOT NULL CHECK(generation > 0),
  snapshot_name text NOT NULL UNIQUE CHECK(snapshot_name ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  archive bytea NOT NULL,
  journal jsonb NOT NULL CHECK(jsonb_typeof(journal)='object'),
  status text NOT NULL DEFAULT 'publishing'
    CHECK(status IN ('publishing','ready','retired','missing','failed','blocked','deleted')),
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  retry_at timestamptz,
  provider_checked_at timestamptz,
  delete_intent_at timestamptz,
  ready_at timestamptz,
  retired_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(release_digest,generation)
);

CREATE UNIQUE INDEX IF NOT EXISTS managed_base_image_one_ready
  ON managed_base_images(release_digest) WHERE status='ready';
CREATE INDEX IF NOT EXISTS managed_base_image_work
  ON managed_base_images(status,retry_at,created_at) WHERE status IN ('publishing','retired','missing','failed');
