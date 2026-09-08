-- Sequence zero preserves user messages and final responses from older runtimes.
-- New runtimes keep a stable sequence for every visible assistant message.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sequence integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS complete boolean NOT NULL DEFAULT true;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_run_id_role_key;
CREATE UNIQUE INDEX IF NOT EXISTS messages_run_role_sequence ON messages(run_id,role,sequence);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS message_version bigint;
