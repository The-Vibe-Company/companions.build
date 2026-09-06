CREATE TABLE IF NOT EXISTS companion_deliveries (
  id uuid PRIMARY KEY,
  source_owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  source_companion_id uuid REFERENCES companions(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  profile_snapshot jsonb NOT NULL,
  template_profiles jsonb NOT NULL DEFAULT '[]'::jsonb,
  maintenance_requested boolean NOT NULL DEFAULT false,
  email_status text NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending','sending','sent','unknown','skipped')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  expires_at timestamptz NOT NULL,
  accepted_by text REFERENCES "user"(id) ON DELETE SET NULL,
  delivered_companion_id uuid REFERENCES companions(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (recipient_email = lower(recipient_email))
);
ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS client_delivery_id uuid;
ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE companion_deliveries DROP CONSTRAINT IF EXISTS companion_deliveries_email_status_check;
ALTER TABLE companion_deliveries ADD CONSTRAINT companion_deliveries_email_status_check CHECK (email_status IN ('pending','sending','sent','unknown','skipped'));
UPDATE companion_deliveries SET client_delivery_id=id WHERE client_delivery_id IS NULL;
UPDATE companion_deliveries SET request_fingerprint=encode(sha256(id::text::bytea),'hex') WHERE request_fingerprint IS NULL;
ALTER TABLE companion_deliveries ALTER COLUMN client_delivery_id SET NOT NULL;
ALTER TABLE companion_deliveries ALTER COLUMN request_fingerprint SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS companion_delivery_client_id ON companion_deliveries(source_owner_id,client_delivery_id);
CREATE INDEX IF NOT EXISTS companion_deliveries_sender_idx ON companion_deliveries(source_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS companion_deliveries_recipient_idx ON companion_deliveries(recipient_email, created_at DESC);

CREATE TABLE IF NOT EXISTS companion_maintenance_grants (
  delivery_id uuid PRIMARY KEY REFERENCES companion_deliveries(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  client_owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  maintainer_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (client_owner_id <> maintainer_id)
);
CREATE INDEX IF NOT EXISTS companion_maintenance_access_idx ON companion_maintenance_grants(maintainer_id, companion_id) WHERE revoked_at IS NULL;
