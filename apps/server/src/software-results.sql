-- Verified public package images can be shared after delivery consent. Build jobs,
-- source Boxes and their private state remain confined to the original owner.
CREATE TABLE IF NOT EXISTS portable_software_results (
  id uuid PRIMARY KEY,
  source_build_id uuid NOT NULL UNIQUE REFERENCES portable_software_builds(id) ON DELETE RESTRICT,
  base_id text NOT NULL REFERENCES portable_software_bases(id) ON DELETE RESTRICT,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  provider_snapshot_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(id=source_build_id)
);
CREATE TABLE IF NOT EXISTS portable_software_result_grants (
  result_id uuid NOT NULL REFERENCES portable_software_results(id) ON DELETE RESTRICT,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  delivery_id uuid REFERENCES companion_deliveries(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(result_id,owner_id)
);
ALTER TABLE portable_software_builds ADD COLUMN IF NOT EXISTS result_id uuid REFERENCES portable_software_results(id) ON DELETE RESTRICT;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS software_result_id uuid;
ALTER TABLE template_revisions ADD COLUMN IF NOT EXISTS software_result_id uuid;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS software_result_id uuid;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='software_build_result_identity') THEN
    ALTER TABLE portable_software_builds ADD CONSTRAINT software_build_result_identity CHECK(result_id IS NULL OR result_id=id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='templates_software_result_grant_fk') THEN
    ALTER TABLE agent_templates ADD CONSTRAINT templates_software_result_grant_fk
      FOREIGN KEY(software_result_id,owner_id) REFERENCES portable_software_result_grants(result_id,owner_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='revisions_software_result_grant_fk') THEN
    ALTER TABLE template_revisions ADD CONSTRAINT revisions_software_result_grant_fk
      FOREIGN KEY(software_result_id,owner_id) REFERENCES portable_software_result_grants(result_id,owner_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companions_software_result_grant_fk') THEN
    ALTER TABLE companions ADD CONSTRAINT companions_software_result_grant_fk
      FOREIGN KEY(software_result_id,owner_id) REFERENCES portable_software_result_grants(result_id,owner_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='agent_templates_software_single_pin') THEN
    ALTER TABLE agent_templates ADD CONSTRAINT agent_templates_software_single_pin CHECK(software_build_id IS NULL OR software_result_id IS NULL);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='template_revisions_software_single_pin') THEN
    ALTER TABLE template_revisions ADD CONSTRAINT template_revisions_software_single_pin CHECK(software_build_id IS NULL OR software_result_id IS NULL);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companions_software_single_pin') THEN
    ALTER TABLE companions ADD CONSTRAINT companions_software_single_pin CHECK(software_build_id IS NULL OR software_result_id IS NULL);
  END IF;
END $$;
DROP TRIGGER IF EXISTS portable_software_results_immutable ON portable_software_results;
CREATE TRIGGER portable_software_results_immutable BEFORE UPDATE OR DELETE ON portable_software_results
  FOR EACH ROW EXECUTE FUNCTION reject_portable_software_immutable_change();
DROP TRIGGER IF EXISTS portable_software_result_grants_immutable ON portable_software_result_grants;
CREATE TRIGGER portable_software_result_grants_immutable BEFORE UPDATE OR DELETE ON portable_software_result_grants
  FOR EACH ROW EXECUTE FUNCTION reject_portable_software_immutable_change();

ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS software_status text NOT NULL DEFAULT 'ready'
  CHECK(software_status IN ('pending','ready','error'));
ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS software_error text;
CREATE TABLE IF NOT EXISTS delivery_software_targets (
  delivery_id uuid NOT NULL REFERENCES companion_deliveries(id) ON DELETE RESTRICT,
  target_key text NOT NULL CHECK(target_key='main' OR target_key ~ '^[0-9a-f-]{36}$'),
  source_owner_id text NOT NULL,
  source_template_revision integer CHECK(source_template_revision>0),
  source_build_id uuid,
  source_result_id uuid,
  PRIMARY KEY(delivery_id,target_key),
  CHECK((source_build_id IS NOT NULL)::int+(source_result_id IS NOT NULL)::int=1),
  FOREIGN KEY(source_build_id,source_owner_id) REFERENCES portable_software_builds(id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(source_result_id,source_owner_id) REFERENCES portable_software_result_grants(result_id,owner_id) ON DELETE RESTRICT
);
DROP TRIGGER IF EXISTS delivery_software_targets_immutable ON delivery_software_targets;
CREATE TRIGGER delivery_software_targets_immutable BEFORE UPDATE OR DELETE ON delivery_software_targets
  FOR EACH ROW EXECUTE FUNCTION reject_portable_software_immutable_change();
