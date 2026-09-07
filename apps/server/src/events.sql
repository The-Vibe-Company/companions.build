CREATE OR REPLACE FUNCTION notify_companion_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed_companion_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'companions' THEN
    changed_companion_id := COALESCE(NEW.id, OLD.id);
  ELSE
    changed_companion_id := COALESCE(NEW.companion_id, OLD.companion_id);
  END IF;
  PERFORM pg_notify('companion_changed', changed_companion_id::text);
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE
  table_name text;
  trigger_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['companions', 'runs', 'messages', 'task_questions', 'attachments'] LOOP
    trigger_name := table_name || '_companion_changed';
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = trigger_name AND tgrelid = table_name::regclass AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_companion_changed()',
        trigger_name,
        table_name
      );
    END IF;
  END LOOP;
END;
$$;
