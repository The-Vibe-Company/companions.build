CREATE TABLE IF NOT EXISTS portable_skill_bundles (
 id uuid PRIMARY KEY, source_owner_id text NOT NULL, source_companion_id uuid NOT NULL,
 manifest_version integer NOT NULL CHECK(manifest_version=1), bundle_hash text NOT NULL CHECK(bundle_hash ~ '^[0-9a-f]{64}$'),
 object_sha256 text NOT NULL CHECK(object_sha256 ~ '^[0-9a-f]{64}$'), byte_size integer NOT NULL CHECK(byte_size BETWEEN 25 AND 15000000),
 storage_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS portable_skill_exports (
 id uuid PRIMARY KEY, delivery_id uuid REFERENCES companion_deliveries(id) ON DELETE CASCADE,
 source_owner_id text NOT NULL, source_companion_id uuid NOT NULL,
 target_kind text NOT NULL CHECK(target_kind IN ('delivery_main','delivery_template','template_revision')),
 source_template_id uuid, target_revision integer,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','error')),
 bundle_id uuid REFERENCES portable_skill_bundles(id), error text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 CHECK((target_kind='delivery_main' AND delivery_id IS NOT NULL AND source_template_id IS NULL AND target_revision IS NULL)
   OR (target_kind='delivery_template' AND delivery_id IS NOT NULL AND source_template_id IS NOT NULL AND target_revision IS NULL)
   OR (target_kind='template_revision' AND delivery_id IS NULL AND source_template_id IS NOT NULL AND target_revision IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS portable_export_delivery_main_uq ON portable_skill_exports(delivery_id) WHERE target_kind='delivery_main';
CREATE UNIQUE INDEX IF NOT EXISTS portable_export_delivery_template_uq ON portable_skill_exports(delivery_id,source_template_id) WHERE target_kind='delivery_template';
CREATE UNIQUE INDEX IF NOT EXISTS portable_export_template_revision_uq ON portable_skill_exports(source_template_id,target_revision) WHERE target_kind='template_revision';
CREATE INDEX IF NOT EXISTS portable_export_pending_idx ON portable_skill_exports(status,created_at) WHERE status='pending';

ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS include_skills boolean NOT NULL DEFAULT false;
ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS skills_status text NOT NULL DEFAULT 'ready' CHECK(skills_status IN ('pending','ready','error'));
ALTER TABLE companion_deliveries ADD COLUMN IF NOT EXISTS skills_error text;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS skill_bundle_id uuid REFERENCES portable_skill_bundles(id);
ALTER TABLE companions ADD COLUMN IF NOT EXISTS skills_staged_hash text;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS skills_staged_box_id text;
ALTER TABLE IF EXISTS agent_templates ADD COLUMN IF NOT EXISTS skill_bundle_id uuid REFERENCES portable_skill_bundles(id);
ALTER TABLE IF EXISTS template_revisions ADD COLUMN IF NOT EXISTS skill_bundle_id uuid REFERENCES portable_skill_bundles(id);
