-- Transport receipts only. Memory records remain in the Companion's existing local store.
CREATE TABLE IF NOT EXISTS memory_commands (
  companion_id uuid NOT NULL REFERENCES companions(id),
  operation_id text NOT NULL,
  authority text NOT NULL CHECK(authority IN ('human','system')),
  request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
  response jsonb CHECK(response IS NULL OR jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY(companion_id,operation_id)
);
CREATE INDEX IF NOT EXISTS memory_commands_pending ON memory_commands(companion_id,created_at) WHERE settled_at IS NULL;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS memory_checked_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS memory_cursor text;
