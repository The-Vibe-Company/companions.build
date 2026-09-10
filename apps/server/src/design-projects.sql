DO $$ DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='companions'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%profile_id%' LOOP
    EXECUTE format('ALTER TABLE companions DROP CONSTRAINT %I',item.conname);
  END LOOP;
END $$;
ALTER TABLE companions ADD CONSTRAINT companions_profile_id_check
  CHECK (profile_id IS NULL OR profile_id IN ('default-v1','design-v1','design-v2'));

CREATE TABLE IF NOT EXISTS design_projects (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"("id"),
  companion_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  brief text NOT NULL CHECK (length(brief)<=20000),
  creation_fingerprint text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,companion_id),
  FOREIGN KEY(companion_id,owner_id) REFERENCES companions(id,owner_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS design_projects_companion_id ON design_projects(companion_id,id);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS project_id uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS design_context jsonb;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='runs_design_project_fk') THEN
  ALTER TABLE runs ADD CONSTRAINT runs_design_project_fk FOREIGN KEY(project_id,companion_id)
   REFERENCES design_projects(id,companion_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='runs_design_context_check') THEN
  ALTER TABLE runs ADD CONSTRAINT runs_design_context_check CHECK (
   (project_id IS NULL AND design_context IS NULL) OR
   (project_id IS NOT NULL AND jsonb_typeof(design_context)='object' AND design_context->>'version'='1' AND design_context->>'profileId'='design-v2'
    AND design_context->'project'->>'id'=project_id::text AND design_context->>'companionId'=companion_id::text
    AND length(design_context->'project'->>'name') BETWEEN 1 AND 160 AND length(design_context->'project'->>'brief')<=20000
    AND (design_context->'project'->>'revision')::integer>0 AND design_context->'skill'->>'id'='first-party/design-studio'
    AND design_context->'skill'->>'version'='1.0.0') IS TRUE
  );
 END IF;
END $$;
CREATE OR REPLACE FUNCTION prevent_run_design_context_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.design_context IS DISTINCT FROM NEW.design_context THEN
  RAISE EXCEPTION 'run design context is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS runs_design_context_immutable ON runs;
CREATE TRIGGER runs_design_context_immutable BEFORE UPDATE OF project_id,design_context ON runs
 FOR EACH ROW EXECUTE FUNCTION prevent_run_design_context_update();

ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS project_id uuid;
ALTER TABLE workbench_events ADD COLUMN IF NOT EXISTS project_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS runs_id_companion_project_uq ON runs(id,companion_id,project_id);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_revisions_revision_project_uq ON artifact_revisions(revision_id,project_id);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='artifact_revisions_project_fk') THEN
  ALTER TABLE artifact_revisions ADD CONSTRAINT artifact_revisions_project_fk FOREIGN KEY(project_id,companion_id)
   REFERENCES design_projects(id,companion_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='artifact_revisions_run_project_fk') THEN
  ALTER TABLE artifact_revisions ADD CONSTRAINT artifact_revisions_run_project_fk FOREIGN KEY(run_id,companion_id,project_id)
   REFERENCES runs(id,companion_id,project_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='artifact_revisions_previous_project_fk') THEN
  ALTER TABLE artifact_revisions ADD CONSTRAINT artifact_revisions_previous_project_fk FOREIGN KEY(previous_revision_id,project_id)
   REFERENCES artifact_revisions(revision_id,project_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workbench_events_project_fk') THEN
  ALTER TABLE workbench_events ADD CONSTRAINT workbench_events_project_fk FOREIGN KEY(project_id,companion_id)
   REFERENCES design_projects(id,companion_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workbench_events_revision_project_fk') THEN
  ALTER TABLE workbench_events ADD CONSTRAINT workbench_events_revision_project_fk FOREIGN KEY(revision_id,project_id)
   REFERENCES artifact_revisions(revision_id,project_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='artifact_revisions_schema_project_check') THEN
  ALTER TABLE artifact_revisions ADD CONSTRAINT artifact_revisions_schema_project_check CHECK (
   (project_id IS NULL AND manifest->>'schemaVersion'='1') OR
   (project_id IS NOT NULL AND manifest->>'schemaVersion'='2' AND manifest->'provenance'->>'projectId'=project_id::text) IS TRUE);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workbench_events_schema_project_check') THEN
  ALTER TABLE workbench_events ADD CONSTRAINT workbench_events_schema_project_check CHECK (
   (project_id IS NULL AND event->'provenance'->>'profileId'='design-v1') OR
   (project_id IS NOT NULL AND event->'provenance'->>'profileId'='design-v2' AND event->'provenance'->>'projectId'=project_id::text) IS TRUE);
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS design_artifacts (
 owner_id text NOT NULL REFERENCES "user"("id"), companion_id uuid NOT NULL, artifact_id uuid NOT NULL,
 project_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(companion_id,artifact_id),
 FOREIGN KEY(companion_id,owner_id) REFERENCES companions(id,owner_id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,companion_id) REFERENCES design_projects(id,companion_id) ON DELETE RESTRICT
);
DROP TRIGGER IF EXISTS design_artifacts_append_only ON design_artifacts;
CREATE TRIGGER design_artifacts_append_only BEFORE UPDATE OR DELETE ON design_artifacts
 FOR EACH ROW EXECUTE FUNCTION prevent_workbench_record_change();

DROP TRIGGER IF EXISTS design_projects_companion_changed ON design_projects;
CREATE TRIGGER design_projects_companion_changed AFTER INSERT OR UPDATE OR DELETE ON design_projects
 FOR EACH ROW EXECUTE FUNCTION notify_companion_changed();

CREATE OR REPLACE FUNCTION prevent_artifact_project_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.project_id IS DISTINCT FROM NEW.project_id THEN RAISE EXCEPTION 'artifact project is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS artifact_revisions_project_immutable ON artifact_revisions;
CREATE TRIGGER artifact_revisions_project_immutable BEFORE UPDATE OF project_id ON artifact_revisions
 FOR EACH ROW EXECUTE FUNCTION prevent_artifact_project_change();
DROP TRIGGER IF EXISTS workbench_events_project_immutable ON workbench_events;
CREATE TRIGGER workbench_events_project_immutable BEFORE UPDATE OF project_id ON workbench_events
 FOR EACH ROW EXECUTE FUNCTION prevent_artifact_project_change();

CREATE OR REPLACE FUNCTION prevent_project_identity_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.id IS DISTINCT FROM NEW.id OR OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.companion_id IS DISTINCT FROM NEW.companion_id OR OLD.creation_fingerprint IS DISTINCT FROM NEW.creation_fingerprint THEN
  RAISE EXCEPTION 'project identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS design_project_identity_immutable ON design_projects;
CREATE TRIGGER design_project_identity_immutable BEFORE UPDATE ON design_projects FOR EACH ROW EXECUTE FUNCTION prevent_project_identity_update();
