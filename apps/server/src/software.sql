CREATE TABLE IF NOT EXISTS portable_software_bases (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._+-]{0,127}$'),
  provider_snapshot_name text NOT NULL UNIQUE CHECK (provider_snapshot_name ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  distribution_digest text NOT NULL CHECK (distribution_digest ~ '^[0-9a-f]{64}$'),
  resolver_config_digest text NOT NULL CHECK (resolver_config_digest ~ '^[0-9a-f]{64}$'),
  distro_family text NOT NULL CHECK (distro_family ~ '^[a-z0-9][a-z0-9._+-]{0,127}$'),
  distro_suite text NOT NULL CHECK (distro_suite ~ '^[a-z0-9][a-z0-9._+-]{0,127}$'),
  distro_architecture text NOT NULL CHECK (distro_architecture ~ '^[a-z0-9][a-z0-9._+-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portable_software_base_selection (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  base_id text NOT NULL REFERENCES portable_software_bases(id) ON DELETE RESTRICT,
  selected_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portable_software_manifests (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  base_id text NOT NULL REFERENCES portable_software_bases(id) ON DELETE RESTRICT,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,digest),
  UNIQUE(id,owner_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_templates_id_owner_uq ON agent_templates(id,owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS companions_id_owner_software_uq ON companions(id,owner_id);

CREATE TABLE IF NOT EXISTS portable_software_builds (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  template_id uuid NOT NULL,
  expected_revision integer NOT NULL CHECK (expected_revision > 0),
  template_revision integer NOT NULL CHECK (template_revision = expected_revision + 1),
  base_id text NOT NULL REFERENCES portable_software_bases(id) ON DELETE RESTRICT,
  requested_roots jsonb NOT NULL CHECK (jsonb_typeof(requested_roots) = 'object'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Filled by the runtime from the helper's canonical digest, which also binds
  -- the operator-only resolver configuration. It is intentionally distinct
  -- from the user request fingerprint above.
  helper_request_digest text CHECK (helper_request_digest IS NULL OR helper_request_digest ~ '^[0-9a-f]{64}$'),
  create_key uuid NOT NULL UNIQUE,
  box_id text,
  create_started_at timestamptz,
  manifest_id uuid,
  resolved_manifest_digest text CHECK (resolved_manifest_digest IS NULL OR resolved_manifest_digest ~ '^[0-9a-f]{64}$'),
  provider_snapshot_name text NOT NULL UNIQUE CHECK (provider_snapshot_name ~ '^companions-software-[0-9a-f-]{36}$'),
  snapshot_started_at timestamptz,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','creating','resolving','installing','verifying','capturing','ready','failed')),
  cleanup_status text NOT NULL DEFAULT 'pending' CHECK (cleanup_status IN ('pending','complete','error')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(id,owner_id),
  UNIQUE(template_id,template_revision),
  FOREIGN KEY(template_id,owner_id) REFERENCES agent_templates(id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(manifest_id,owner_id) REFERENCES portable_software_manifests(id,owner_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS portable_software_builds_pending_idx ON portable_software_builds(status,created_at)
  WHERE status NOT IN ('ready','failed');
CREATE INDEX IF NOT EXISTS portable_software_builds_owner_idx ON portable_software_builds(owner_id,created_at DESC);

-- Build Boxes are tenant runtime resources, distinct from operator distribution-build Boxes.
-- Each observed ready/resume cycle is billed independently and closes only after an observed
-- archived or missing provider response.
CREATE TABLE IF NOT EXISTS portable_software_usage_intervals (
  id uuid PRIMARY KEY,
  build_id uuid NOT NULL,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  ready_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR end_reason IN ('archived','missing')),
  CHECK (last_observed_at >= ready_at),
  CHECK ((ended_at IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND end_reason IS NOT NULL AND ended_at >= last_observed_at)),
  FOREIGN KEY(build_id,owner_id) REFERENCES portable_software_builds(id,owner_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS portable_software_usage_open_idx ON portable_software_usage_intervals(build_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS portable_software_usage_owner_idx ON portable_software_usage_intervals(owner_id,ready_at,id);

ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS software_build_id uuid;
ALTER TABLE template_revisions ADD COLUMN IF NOT EXISTS software_build_id uuid;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS software_build_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_templates_software_build_owner_fk') THEN
    ALTER TABLE agent_templates ADD CONSTRAINT agent_templates_software_build_owner_fk
      FOREIGN KEY(software_build_id,owner_id) REFERENCES portable_software_builds(id,owner_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='template_revisions_software_build_owner_fk') THEN
    ALTER TABLE template_revisions ADD CONSTRAINT template_revisions_software_build_owner_fk
      FOREIGN KEY(software_build_id,owner_id) REFERENCES portable_software_builds(id,owner_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='companions_software_build_owner_fk') THEN
    ALTER TABLE companions ADD CONSTRAINT companions_software_build_owner_fk
      FOREIGN KEY(software_build_id,owner_id) REFERENCES portable_software_builds(id,owner_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_portable_software_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'portable software records are immutable';
END $$;
DROP TRIGGER IF EXISTS portable_software_bases_immutable ON portable_software_bases;
CREATE TRIGGER portable_software_bases_immutable BEFORE UPDATE OR DELETE ON portable_software_bases
  FOR EACH ROW EXECUTE FUNCTION reject_portable_software_immutable_change();
DROP TRIGGER IF EXISTS portable_software_manifests_immutable ON portable_software_manifests;
CREATE TRIGGER portable_software_manifests_immutable BEFORE UPDATE OR DELETE ON portable_software_manifests
  FOR EACH ROW EXECUTE FUNCTION reject_portable_software_immutable_change();
