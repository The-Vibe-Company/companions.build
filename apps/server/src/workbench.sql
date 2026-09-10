ALTER TABLE companions ADD COLUMN IF NOT EXISTS profile_id text
  CHECK (profile_id IS NULL OR profile_id IN ('default-v1','design-v1'));

CREATE OR REPLACE FUNCTION prevent_companion_profile_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'companion profile is immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS companions_profile_immutable ON companions;
CREATE TRIGGER companions_profile_immutable
  BEFORE UPDATE OF profile_id ON companions
  FOR EACH ROW EXECUTE FUNCTION prevent_companion_profile_update();

CREATE TABLE IF NOT EXISTS artifact_revisions (
  revision_id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"("id"),
  companion_id uuid NOT NULL,
  run_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  previous_revision_id uuid REFERENCES artifact_revisions(revision_id),
  status text NOT NULL CHECK (status IN ('ready','failed')),
  manifest jsonb NOT NULL,
  html text,
  created_at timestamptz NOT NULL,
  UNIQUE (companion_id, artifact_id, revision),
  CHECK ((status = 'ready' AND html IS NOT NULL) OR (status = 'failed' AND html IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_id_companion_id_uq ON runs(id,companion_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='artifact_revisions_companion_owner_fk') THEN
    ALTER TABLE artifact_revisions ADD CONSTRAINT artifact_revisions_companion_owner_fk
      FOREIGN KEY(companion_id,owner_id) REFERENCES companions(id,owner_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='artifact_revisions_run_companion_fk') THEN
    ALTER TABLE artifact_revisions ADD CONSTRAINT artifact_revisions_run_companion_fk
      FOREIGN KEY(run_id,companion_id) REFERENCES runs(id,companion_id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS artifact_revisions_companion_newest
  ON artifact_revisions(companion_id,created_at DESC,revision_id DESC);
CREATE INDEX IF NOT EXISTS artifact_revisions_preview
  ON artifact_revisions(companion_id,artifact_id,revision DESC) WHERE status='ready';

CREATE TABLE IF NOT EXISTS workbench_events (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"("id"),
  companion_id uuid NOT NULL,
  run_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('artifact.revision')),
  artifact_id uuid NOT NULL,
  revision_id uuid NOT NULL REFERENCES artifact_revisions(revision_id) ON DELETE RESTRICT,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workbench_events_companion_owner_fk') THEN
    ALTER TABLE workbench_events ADD CONSTRAINT workbench_events_companion_owner_fk
      FOREIGN KEY(companion_id,owner_id) REFERENCES companions(id,owner_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workbench_events_run_companion_fk') THEN
    ALTER TABLE workbench_events ADD CONSTRAINT workbench_events_run_companion_fk
      FOREIGN KEY(run_id,companion_id) REFERENCES runs(id,companion_id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS workbench_events_companion_newest
  ON workbench_events(companion_id,created_at DESC,id DESC);

CREATE OR REPLACE FUNCTION prevent_workbench_record_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workbench records are append-only' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS artifact_revisions_append_only ON artifact_revisions;
CREATE TRIGGER artifact_revisions_append_only BEFORE UPDATE OR DELETE ON artifact_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_workbench_record_change();
DROP TRIGGER IF EXISTS workbench_events_append_only ON workbench_events;
CREATE TRIGGER workbench_events_append_only BEFORE UPDATE OR DELETE ON workbench_events
  FOR EACH ROW EXECUTE FUNCTION prevent_workbench_record_change();

DROP TRIGGER IF EXISTS artifact_revisions_companion_changed ON artifact_revisions;
CREATE TRIGGER artifact_revisions_companion_changed AFTER INSERT OR UPDATE OR DELETE ON artifact_revisions
  FOR EACH ROW EXECUTE FUNCTION notify_companion_changed();
DROP TRIGGER IF EXISTS workbench_events_companion_changed ON workbench_events;
CREATE TRIGGER workbench_events_companion_changed AFTER INSERT OR UPDATE OR DELETE ON workbench_events
  FOR EACH ROW EXECUTE FUNCTION notify_companion_changed();
