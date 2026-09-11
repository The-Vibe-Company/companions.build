-- Stop old executors and reconcile provider resources before applying this migration.
DO $$ DECLARE unresolved bigint; BEGIN
 IF to_regclass('public.portable_software_usage_intervals') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM portable_software_usage_intervals WHERE ended_at IS NULL' INTO unresolved; IF unresolved>0 THEN RAISE EXCEPTION 'legacy decommission blocked: portable software usage is unreconciled'; END IF; END IF;
 IF to_regclass('public.portable_software_builds') IS NOT NULL THEN EXECUTE $query$SELECT count(*) FROM portable_software_builds WHERE (box_id IS NOT NULL OR create_started_at IS NOT NULL) AND cleanup_status<>'complete'$query$ INTO unresolved; IF unresolved>0 THEN RAISE EXCEPTION 'legacy decommission blocked: portable software machines are not confirmed archived'; END IF; END IF;
 IF EXISTS(SELECT 1 FROM companions WHERE (temporary OR specialist_draft_id IS NOT NULL) AND (box_id IS NOT NULL OR create_started_at IS NOT NULL) AND (archived_at IS NULL OR archive_requested_at IS NULL OR archived_at<archive_requested_at)) THEN RAISE EXCEPTION 'legacy decommission blocked: specialist machines are not confirmed archived'; END IF;
END $$;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS agent_state_layout text NOT NULL DEFAULT 'root';
ALTER TABLE companions ADD COLUMN IF NOT EXISTS agent_state_seeded_at timestamptz;
UPDATE companions SET agent_state_layout='per_companion' WHERE NOT temporary AND specialist_draft_id IS NULL AND template_id IS NOT NULL;
-- Preserve the effective revision pin before removing its owning feature or evaluating blob cleanup.
DO $$ BEGIN
 IF to_regclass('public.template_revisions') IS NOT NULL THEN
  EXECUTE $query$UPDATE companions c SET skill_bundle_id=r.skill_bundle_id FROM template_revisions r
   WHERE r.template_id=c.template_id AND r.revision=c.template_revision AND r.skill_bundle_id IS NOT NULL
    AND NOT c.temporary AND c.specialist_draft_id IS NULL$query$;
 END IF;
END $$;
ALTER TABLE companions DROP CONSTRAINT IF EXISTS companions_agent_state_layout_check;
ALTER TABLE companions ADD CONSTRAINT companions_agent_state_layout_check CHECK(agent_state_layout IN ('root','per_companion'));
CREATE TEMP TABLE legacy_companion_ids ON COMMIT DROP AS
 SELECT id FROM companions WHERE temporary OR specialist_draft_id IS NOT NULL;
CREATE TEMP TABLE legacy_run_ids ON COMMIT DROP AS
 SELECT id FROM runs WHERE source IN ('routine','trigger') OR companion_id IN (SELECT id FROM legacy_companion_ids);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM attachments WHERE run_id IN (SELECT id FROM legacy_run_ids)) THEN
  RAISE EXCEPTION 'legacy decommission blocked: archive and purge attachment blobs for legacy runs before retrying';
 END IF;
 IF EXISTS(SELECT 1 FROM portable_skill_bundles b WHERE b.source_companion_id IN (SELECT id FROM legacy_companion_ids)
  AND NOT EXISTS(SELECT 1 FROM companions c WHERE c.skill_bundle_id=b.id AND c.id NOT IN (SELECT id FROM legacy_companion_ids))
  AND NOT EXISTS(SELECT 1 FROM portable_skill_exports e WHERE e.bundle_id=b.id AND e.target_kind='delivery_main')) THEN
  RAISE EXCEPTION 'legacy decommission blocked: archive and purge portable skill blobs for legacy Companions before retrying';
 END IF;
END $$;
UPDATE model_gateway_requests SET run_id=null WHERE run_id IN (SELECT id FROM legacy_run_ids);
UPDATE model_gateway_requests SET companion_id=null WHERE companion_id IN (SELECT id FROM legacy_companion_ids);
UPDATE discussion_runs SET source_run_id=null WHERE source_run_id IN (SELECT id FROM legacy_run_ids);
DELETE FROM discussion_task_files WHERE run_id IN (SELECT id FROM legacy_run_ids);
DELETE FROM delegation_files WHERE target_run_id IN (SELECT id FROM legacy_run_ids)
 OR delegation_id IN (SELECT id FROM delegations WHERE run_id IN (SELECT id FROM legacy_run_ids) OR parent_run_id IN (SELECT id FROM legacy_run_ids) OR returned_run_id IN (SELECT id FROM legacy_run_ids));
DELETE FROM delegations WHERE run_id IN (SELECT id FROM legacy_run_ids) OR parent_run_id IN (SELECT id FROM legacy_run_ids)
 OR returned_run_id IN (SELECT id FROM legacy_run_ids) OR parent_id IN (SELECT id FROM legacy_companion_ids) OR target_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM maintenance_actions WHERE run_id IN (SELECT id FROM legacy_run_ids) OR companion_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM control_commands WHERE run_id IN (SELECT id FROM legacy_run_ids) OR companion_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM task_questions WHERE run_id IN (SELECT id FROM legacy_run_ids) OR companion_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM messages WHERE run_id IN (SELECT id FROM legacy_run_ids) OR companion_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM discussion_proposals WHERE companion_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM discussion_messages WHERE run_id IN (SELECT id FROM legacy_run_ids) OR companion_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM discussion_sends WHERE run_id IN (SELECT id FROM legacy_run_ids) OR companion_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM discussion_participants WHERE companion_id IN (SELECT id FROM legacy_companion_ids);
UPDATE discussions SET direct_companion_id=null WHERE direct_companion_id IN (SELECT id FROM legacy_companion_ids);
UPDATE runs SET response_root_id=null WHERE response_root_id IN (SELECT id FROM legacy_run_ids) AND id NOT IN (SELECT id FROM legacy_run_ids);
DELETE FROM runtime_updates WHERE companion_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM box_observation_gaps WHERE ready_event_id IN (SELECT id FROM machine_usage_events WHERE companion_id IN (SELECT id FROM legacy_companion_ids));
DELETE FROM box_observations WHERE companion_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM machine_usage_events WHERE companion_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM machine_admission_requests WHERE companion_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM companion_plugins WHERE companion_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM portable_skill_exports WHERE source_companion_id IN (SELECT id FROM legacy_companion_ids) AND target_kind<>'delivery_main';
UPDATE discussion_folders SET companion_ids=ARRAY(SELECT unnest(companion_ids) EXCEPT SELECT id FROM legacy_companion_ids);
DELETE FROM machine_admission_requests WHERE kind NOT IN ('configuration','resume');
DELETE FROM portable_skill_exports WHERE target_kind<>'delivery_main';
-- Readiness now depends only on the retained main export; removed template failures cannot block it.
UPDATE companion_deliveries d SET
 skills_status=CASE WHEN EXISTS(SELECT 1 FROM portable_skill_exports e WHERE e.delivery_id=d.id AND e.status='error') THEN 'error'
  WHEN EXISTS(SELECT 1 FROM portable_skill_exports e WHERE e.delivery_id=d.id AND e.status='pending') THEN 'pending' ELSE 'ready' END,
 skills_error=CASE WHEN EXISTS(SELECT 1 FROM portable_skill_exports e WHERE e.delivery_id=d.id AND e.status='error') THEN 'Portable skills could not be prepared.' ELSE null END;
DROP INDEX IF EXISTS portable_export_delivery_main_uq;
DROP INDEX IF EXISTS portable_export_delivery_template_uq;
DROP INDEX IF EXISTS portable_export_template_revision_uq;
ALTER TABLE portable_skill_exports DROP CONSTRAINT IF EXISTS portable_skill_exports_target_kind_check;
ALTER TABLE portable_skill_exports DROP CONSTRAINT IF EXISTS portable_skill_exports_check;
ALTER TABLE portable_skill_exports DROP COLUMN IF EXISTS source_template_id;
ALTER TABLE portable_skill_exports DROP COLUMN IF EXISTS target_revision;
ALTER TABLE portable_skill_exports ALTER COLUMN delivery_id SET NOT NULL;
ALTER TABLE portable_skill_exports ADD CONSTRAINT portable_skill_exports_target_kind_check CHECK(target_kind='delivery_main');
CREATE UNIQUE INDEX portable_export_delivery_main_uq ON portable_skill_exports(delivery_id);
DROP INDEX IF EXISTS machine_admission_owner_queue;
DROP INDEX IF EXISTS machine_admission_recent_starts;
ALTER TABLE machine_admission_requests DROP CONSTRAINT IF EXISTS machine_admission_requests_kind_check;
ALTER TABLE machine_admission_requests ADD CONSTRAINT machine_admission_requests_kind_check CHECK(kind IN ('configuration','resume'));
CREATE INDEX machine_admission_recent_starts ON machine_admission_requests(admitted_at) WHERE start_counted AND admitted_at IS NOT NULL;
DROP TABLE IF EXISTS machine_account_limits CASCADE;
DROP TABLE IF EXISTS trigger_inbox CASCADE; DROP TABLE IF EXISTS trigger_batches CASCADE; DROP TABLE IF EXISTS trigger_deliveries CASCADE; DROP TABLE IF EXISTS triggers CASCADE;
DROP TABLE IF EXISTS routine_missed_windows CASCADE; DROP TABLE IF EXISTS routine_occurrences CASCADE; DROP TABLE IF EXISTS routines CASCADE;
DROP TABLE IF EXISTS specialist_guidance CASCADE; DROP TABLE IF EXISTS specialist_test_assessments CASCADE; DROP TABLE IF EXISTS specialist_revision_connections CASCADE; DROP TABLE IF EXISTS specialist_connection_overrides CASCADE; DROP TABLE IF EXISTS specialist_connections CASCADE; DROP TABLE IF EXISTS specialist_improvements CASCADE; DROP TABLE IF EXISTS specialist_operations CASCADE; DROP TABLE IF EXISTS specialist_drafts CASCADE; DROP TABLE IF EXISTS template_candidates CASCADE; DROP TABLE IF EXISTS template_permissions CASCADE; DROP TABLE IF EXISTS template_revisions CASCADE; DROP TABLE IF EXISTS agent_templates CASCADE;
DROP TABLE IF EXISTS delivery_software_targets CASCADE; DROP TABLE IF EXISTS portable_software_usage_intervals CASCADE; DROP TABLE IF EXISTS portable_software_result_grants CASCADE; DROP TABLE IF EXISTS portable_software_results CASCADE; DROP TABLE IF EXISTS portable_software_builds CASCADE; DROP TABLE IF EXISTS portable_software_manifests CASCADE; DROP TABLE IF EXISTS portable_software_base_selection CASCADE; DROP TABLE IF EXISTS portable_software_bases CASCADE;
DROP FUNCTION IF EXISTS reject_portable_software_immutable_change() CASCADE;
DELETE FROM runs WHERE id IN (SELECT id FROM legacy_run_ids);
UPDATE companions SET parent_id=null WHERE parent_id IN (SELECT id FROM legacy_companion_ids);
DELETE FROM companions WHERE id IN (SELECT id FROM legacy_companion_ids);
ALTER TABLE runs DROP COLUMN IF EXISTS routine_id; ALTER TABLE runs DROP COLUMN IF EXISTS routine_name; ALTER TABLE runs DROP COLUMN IF EXISTS publication_mode; ALTER TABLE runs DROP COLUMN IF EXISTS scheduled_for; ALTER TABLE runs DROP COLUMN IF EXISTS init_warning;
DROP TRIGGER IF EXISTS children_parent_companion_changed ON companions; DROP TRIGGER IF EXISTS child_runs_parent_companion_changed ON runs; DROP FUNCTION IF EXISTS notify_companion_parent_changed() CASCADE; DROP FUNCTION IF EXISTS notify_companion_team_changed() CASCADE;
ALTER TABLE companions DROP COLUMN IF EXISTS parent_id; ALTER TABLE companions DROP COLUMN IF EXISTS temporary; ALTER TABLE companions DROP COLUMN IF EXISTS template_id; ALTER TABLE companions DROP COLUMN IF EXISTS template_revision; ALTER TABLE companions DROP COLUMN IF EXISTS specialist_draft_id; ALTER TABLE companions DROP COLUMN IF EXISTS init_script; ALTER TABLE companions DROP COLUMN IF EXISTS provider_ttl_checked_at; ALTER TABLE companions DROP COLUMN IF EXISTS provider_ttl_target_until; ALTER TABLE companions DROP COLUMN IF EXISTS software_build_id; ALTER TABLE companions DROP COLUMN IF EXISTS software_result_id;
ALTER TABLE companion_deliveries DROP COLUMN IF EXISTS template_profiles; ALTER TABLE companion_deliveries DROP COLUMN IF EXISTS software_status; ALTER TABLE companion_deliveries DROP COLUMN IF EXISTS software_error;
ALTER TABLE runs VALIDATE CONSTRAINT runs_source_check;
