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

-- Child work is displayed in its permanent parent's durable thread snapshot. Notify the parent
-- when that relationship appears or its child's persisted state changes; the API listener still
-- coalesces repeated transaction notifications before sending an invalidation.
CREATE OR REPLACE FUNCTION notify_companion_parent_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_companion_id uuid;
  child_companion_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'delegations' THEN
    parent_companion_id := COALESCE(NEW.parent_id, OLD.parent_id);
  ELSIF TG_TABLE_NAME = 'companions' THEN
    parent_companion_id := COALESCE(NEW.parent_id, OLD.parent_id);
  ELSE
    child_companion_id := COALESCE(NEW.companion_id, OLD.companion_id);
    SELECT parent_id INTO parent_companion_id FROM companions WHERE id=child_companion_id;
  END IF;
  IF parent_companion_id IS NOT NULL THEN
    PERFORM pg_notify('companion_changed', parent_companion_id::text);
  END IF;
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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='delegations_parent_companion_changed' AND NOT tgisinternal) THEN
    CREATE TRIGGER delegations_parent_companion_changed AFTER INSERT OR UPDATE OR DELETE ON delegations
      FOR EACH ROW EXECUTE FUNCTION notify_companion_parent_changed();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='children_parent_companion_changed' AND NOT tgisinternal) THEN
    CREATE TRIGGER children_parent_companion_changed AFTER INSERT OR UPDATE OR DELETE ON companions
      FOR EACH ROW EXECUTE FUNCTION notify_companion_parent_changed();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='child_runs_parent_companion_changed' AND NOT tgisinternal) THEN
    CREATE TRIGGER child_runs_parent_companion_changed AFTER INSERT OR UPDATE OR DELETE ON runs
      FOR EACH ROW EXECUTE FUNCTION notify_companion_parent_changed();
  END IF;
END;
$$;

-- Team projections include the owner's available profiles as well as per-parent permissions.
-- Only committed changes send identifier-only hints; readers still enforce ownership.
CREATE OR REPLACE FUNCTION notify_companion_team_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'template_permissions' THEN
    PERFORM pg_notify('companion_changed', COALESCE(NEW.parent_id, OLD.parent_id)::text);
  ELSE
    FOR affected_id IN SELECT id FROM companions
      WHERE owner_id=COALESCE(NEW.owner_id, OLD.owner_id) AND retired_at IS NULL LOOP
      PERFORM pg_notify('companion_changed', affected_id::text);
    END LOOP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='permissions_team_changed' AND tgrelid='template_permissions'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER permissions_team_changed AFTER INSERT OR UPDATE OR DELETE ON template_permissions
      FOR EACH ROW EXECUTE FUNCTION notify_companion_team_changed();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='templates_team_changed' AND tgrelid='agent_templates'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER templates_team_changed AFTER INSERT OR UPDATE OR DELETE ON agent_templates
      FOR EACH ROW EXECUTE FUNCTION notify_companion_team_changed();
  END IF;
END;
$$;
