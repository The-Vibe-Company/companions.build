-- Durable display positions. A Companion-scoped lock serializes visibility at commit.
CREATE SEQUENCE IF NOT EXISTS conversation_position_seq;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS position bigint;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS routine_timezone text;
UPDATE runs r SET routine_timezone=COALESCE((SELECT timezone FROM routines WHERE id=r.routine_id),'UTC') WHERE r.source='routine' AND r.routine_timezone IS NULL;
CREATE OR REPLACE FUNCTION snapshot_routine_timezone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source='routine' THEN NEW.routine_timezone:=COALESCE((SELECT timezone FROM routines WHERE id=NEW.routine_id),'UTC'); END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runs_routine_timezone ON runs;
CREATE TRIGGER runs_routine_timezone BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION snapshot_routine_timezone();
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_name text;
ALTER TABLE task_questions ADD COLUMN IF NOT EXISTS position bigint;
ALTER TABLE specialist_guidance ADD COLUMN IF NOT EXISTS position bigint;
CREATE TABLE IF NOT EXISTS chat_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), companion_id uuid NOT NULL REFERENCES companions(id),
 run_id uuid NOT NULL REFERENCES runs(id), sequence integer NOT NULL, kind text NOT NULL CHECK(kind IN ('thinking','tool')),
 position bigint NOT NULL, created_at timestamptz NOT NULL, text text, tool_name text,
 application jsonb, status text CHECK(status IN ('running','succeeded','failed','unknown')),
 UNIQUE(run_id,sequence)
);
CREATE INDEX IF NOT EXISTS chat_events_companion ON chat_events(companion_id,position);
-- Stable legacy order, including questions. Only rows with no position are backfilled.
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT 'messages' AS relation,id,created_at FROM messages WHERE position IS NULL
 UNION ALL SELECT 'task_questions',id,created_at FROM task_questions WHERE position IS NULL
 UNION ALL SELECT 'specialist_guidance',id,created_at FROM specialist_guidance WHERE position IS NULL ORDER BY created_at,id
 LOOP EXECUTE format('UPDATE %I SET position=nextval(''conversation_position_seq'') WHERE id=$1',item.relation) USING item.id; END LOOP;
END $$;
CREATE OR REPLACE FUNCTION assign_conversation_position() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF NEW.position IS NULL THEN
  IF TG_TABLE_NAME='specialist_guidance' THEN SELECT companion_id INTO target FROM runs WHERE id=NEW.run_id; ELSE target:=NEW.companion_id; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(target::text,9158));
  NEW.position := nextval('conversation_position_seq');
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messages_position ON messages;
CREATE TRIGGER messages_position BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION assign_conversation_position();
DROP TRIGGER IF EXISTS questions_position ON task_questions;
CREATE TRIGGER questions_position BEFORE INSERT ON task_questions FOR EACH ROW EXECUTE FUNCTION assign_conversation_position();
DROP TRIGGER IF EXISTS guidance_position ON specialist_guidance;
CREATE TRIGGER guidance_position BEFORE INSERT ON specialist_guidance FOR EACH ROW EXECUTE FUNCTION assign_conversation_position();
CREATE TABLE IF NOT EXISTS routine_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), companion_id uuid NOT NULL REFERENCES companions(id),
 run_id uuid NOT NULL REFERENCES runs(id), kind text NOT NULL CHECK(kind IN ('result','question','failure')),
 source_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 UNIQUE(kind,source_id)
);
CREATE INDEX IF NOT EXISTS routine_notifications_page ON routine_notifications(companion_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS routine_notifications_unread ON routine_notifications(companion_id) WHERE read_at IS NULL;
-- Old results are retained in messages for a compatible UI rollback. Backfill once per source.
INSERT INTO routine_notifications(companion_id,run_id,kind,source_id,created_at,read_at)
 SELECT m.companion_id,m.run_id,'result',m.id,m.created_at,now() FROM messages m JOIN runs r ON r.id=m.run_id
 WHERE r.source='routine' AND m.role='assistant' ON CONFLICT(kind,source_id) DO NOTHING;
INSERT INTO routine_notifications(companion_id,run_id,kind,source_id,created_at,read_at)
 SELECT q.companion_id,q.run_id,'question',q.id,q.created_at,now() FROM task_questions q JOIN runs r ON r.id=q.run_id
 WHERE r.source='routine' ON CONFLICT(kind,source_id) DO NOTHING;
INSERT INTO routine_notifications(companion_id,run_id,kind,source_id,created_at,read_at)
 SELECT companion_id,id,'failure',id,COALESCE(finished_at,created_at),now() FROM runs
 WHERE source='routine' AND status IN ('failed','interrupted') ON CONFLICT(kind,source_id) DO NOTHING;
CREATE OR REPLACE FUNCTION project_routine_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_run runs; notification_kind text;
BEGIN
 IF TG_TABLE_NAME='runs' THEN source_run:=NEW; notification_kind:='failure';
  IF NEW.status NOT IN ('failed','interrupted') THEN RETURN NEW; END IF;
 ELSE
  SELECT * INTO source_run FROM runs WHERE id=NEW.run_id;
  IF TG_TABLE_NAME='messages' THEN
   IF NEW.role<>'assistant' THEN RETURN NEW; END IF;
   notification_kind:='result';
  ELSE notification_kind:='question'; END IF;
 END IF;
 IF source_run.source='routine' THEN
  INSERT INTO routine_notifications(companion_id,run_id,kind,source_id)
   VALUES(source_run.companion_id,source_run.id,notification_kind,NEW.id) ON CONFLICT(kind,source_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messages_routine_notification ON messages;
CREATE TRIGGER messages_routine_notification AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION project_routine_notification();
DROP TRIGGER IF EXISTS questions_routine_notification ON task_questions;
CREATE TRIGGER questions_routine_notification AFTER INSERT ON task_questions FOR EACH ROW EXECUTE FUNCTION project_routine_notification();
DROP TRIGGER IF EXISTS runs_routine_notification ON runs;
CREATE TRIGGER runs_routine_notification AFTER INSERT OR UPDATE OF status ON runs FOR EACH ROW EXECUTE FUNCTION project_routine_notification();
DROP TRIGGER IF EXISTS notifications_companion_changed ON routine_notifications;
CREATE TRIGGER notifications_companion_changed AFTER INSERT OR UPDATE ON routine_notifications FOR EACH ROW EXECUTE FUNCTION notify_companion_changed();
DROP TRIGGER IF EXISTS chat_events_companion_changed ON chat_events;
CREATE TRIGGER chat_events_companion_changed AFTER INSERT OR UPDATE ON chat_events FOR EACH ROW EXECUTE FUNCTION notify_companion_changed();
