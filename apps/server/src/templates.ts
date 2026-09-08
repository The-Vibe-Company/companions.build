import {retireCompanionInTransaction} from './retirement';
import { z } from 'zod';
import { db } from './store';
import { avatarSchema } from './control';
import { queueTemplateSkillExport } from './delivery-skills';
import {requireSoftwareReady,SoftwareReadinessError} from './software-readiness';
import {LifecycleConflict} from './lifecycle-errors';
export {LifecycleConflict} from './lifecycle-errors';
export const templateInput=z.object({name:z.string().trim().min(1).max(80),instructions:z.string().max(20_000).default(''),avatar:avatarSchema.default({shape:0,color:0,face:0}),modelId:z.string().min(1).max(200).nullable().optional()});
export async function listTemplates(ownerId:string,sql:any=db) {
 return sql`SELECT id,name,instructions,avatar,model_id AS "modelId",revision,source_companion_id AS "sourceCompanionId",software_build_id AS "softwareBuildId",software_result_id AS "softwareResultId",snapshot_name IS NOT NULL AS "hasSnapshot",has_published AS "hasPublished",(SELECT companion_id FROM specialist_drafts WHERE template_id=agent_templates.id) AS "draftCompanionId" FROM agent_templates WHERE owner_id=${ownerId} AND deleted_at IS NULL ORDER BY created_at,id`;
}
export async function listTemplateRevisions(ownerId:string,templateId:string,sql:any=db) {
 return sql`SELECT r.revision,r.name,r.instructions,r.avatar,r.model_id AS "modelId",r.snapshot_name AS "snapshotName",r.skill_bundle_id AS "skillBundleId",r.software_build_id AS "softwareBuildId",r.software_result_id AS "softwareResultId",
  r.source_companion_id AS "sourceCompanionId",r.created_at AS "createdAt"
  FROM template_revisions r JOIN agent_templates t ON t.id=r.template_id
  WHERE r.template_id=${templateId} AND r.owner_id=${ownerId} AND t.owner_id=${ownerId}
  ORDER BY r.revision DESC`;
}
/** Record the template's current committed state inside the caller's transaction. */
export async function recordTemplateRevision(sql:any,templateId:string) {
 const [row]=await sql`INSERT INTO template_revisions(template_id,revision,owner_id,name,instructions,avatar,model_id,snapshot_name,source_companion_id,skill_bundle_id,software_build_id,software_result_id,init_script,prepared_disk_snapshot)
  SELECT id,revision,owner_id,name,instructions,avatar,model_id,snapshot_name,source_companion_id,skill_bundle_id,software_build_id,software_result_id,init_script,prepared_disk_snapshot
  FROM agent_templates WHERE id=${templateId}
  ON CONFLICT(template_id,revision) DO NOTHING RETURNING template_id AS id,revision`;
 return row??null;
}
export async function saveTemplate(ownerId:string,input:unknown,sql:any=db) {
 const value=templateInput.extend({id:z.string().uuid().optional(),expectedRevision:z.number().int().positive().optional()}).parse(input);
 const modelProvided=value.modelId!==undefined;
 if(!value.id){
  const id=crypto.randomUUID();
  const [row]=await sql`WITH saved AS (
   INSERT INTO agent_templates(id,owner_id,name,instructions,avatar,model_id) VALUES(${id},${ownerId},${value.name},${value.instructions},${value.avatar},${value.modelId??null}) RETURNING *
  ) INSERT INTO template_revisions(template_id,revision,owner_id,name,instructions,avatar,model_id,snapshot_name,source_companion_id,skill_bundle_id,software_build_id,software_result_id)
   SELECT id,revision,owner_id,name,instructions,avatar,model_id,snapshot_name,source_companion_id,skill_bundle_id,software_build_id,software_result_id FROM saved RETURNING template_id AS id,revision`;
  return row;
 }
 if(!value.expectedRevision)throw new LifecycleConflict('Read the current template revision before editing.');
 if((await sql`SELECT template_id FROM specialist_drafts WHERE template_id=${value.id}`).length)throw new LifecycleConflict('Edit this specialist in its configuration draft, then publish explicitly.');
 const [row]=await sql`WITH saved AS (
  UPDATE agent_templates SET name=${value.name},instructions=${value.instructions},avatar=${value.avatar},model_id=CASE WHEN ${modelProvided} THEN ${value.modelId??null} ELSE model_id END,revision=revision+1,updated_at=now()
  WHERE id=${value.id} AND owner_id=${ownerId} AND deleted_at IS NULL AND revision=${value.expectedRevision} RETURNING *
 ) INSERT INTO template_revisions(template_id,revision,owner_id,name,instructions,avatar,model_id,snapshot_name,source_companion_id,skill_bundle_id,software_build_id,software_result_id)
  SELECT id,revision,owner_id,name,instructions,avatar,model_id,snapshot_name,source_companion_id,skill_bundle_id,software_build_id,software_result_id FROM saved RETURNING template_id AS id,revision`;
 if(!row)throw new LifecycleConflict('Template missing or changed.');return row;
}
export async function rollbackTemplate(ownerId:string,templateId:string,input:unknown,sql:any=db) {
 if((await sql`SELECT template_id FROM specialist_drafts WHERE template_id=${templateId}`).length)throw new LifecycleConflict('Use the current draft to prepare a new version before publishing.');
 const value=z.object({targetRevision:z.number().int().positive(),expectedRevision:z.number().int().positive()}).parse(input);
 const [row]=await sql`WITH restored AS (
  UPDATE agent_templates current SET name=historical.name,instructions=historical.instructions,avatar=historical.avatar,model_id=historical.model_id,init_script=historical.init_script,prepared_disk_snapshot=historical.prepared_disk_snapshot,
   snapshot_name=historical.snapshot_name,source_companion_id=historical.source_companion_id,skill_bundle_id=historical.skill_bundle_id,software_build_id=historical.software_build_id,software_result_id=historical.software_result_id,
   revision=current.revision+1,updated_at=now()
  FROM template_revisions historical
  WHERE current.id=${templateId} AND current.owner_id=${ownerId} AND current.deleted_at IS NULL AND current.revision=${value.expectedRevision}
   AND historical.template_id=current.id AND historical.owner_id=current.owner_id AND historical.revision=${value.targetRevision}
  RETURNING current.*
 ) INSERT INTO template_revisions(template_id,revision,owner_id,name,instructions,avatar,model_id,snapshot_name,source_companion_id,skill_bundle_id,software_build_id,software_result_id)
  SELECT id,revision,owner_id,name,instructions,avatar,model_id,snapshot_name,source_companion_id,skill_bundle_id,software_build_id,software_result_id FROM restored RETURNING template_id AS id,revision`;
 if(!row)throw new LifecycleConflict('Template missing, changed, or revision unavailable.');
 return row;
}
export async function allowTemplate(ownerId:string,parentId:string,input:unknown,sql:any=db){
 const value=z.object({templateId:z.string().uuid(),maxChildren:z.number().int().min(0).max(20)}).parse(input);
 return sql.begin(async(tx:any)=>{
  const [parent]=await tx`SELECT id FROM companions WHERE id=${parentId} AND owner_id=${ownerId} AND parent_id IS NULL AND NOT temporary AND retired_at IS NULL FOR UPDATE`;
  const [template]=await tx`SELECT id FROM agent_templates WHERE id=${value.templateId} AND owner_id=${ownerId} AND deleted_at IS NULL AND has_published`;
  if(!parent||!template)throw new LifecycleConflict('Parent or template unavailable.');
  await tx`INSERT INTO template_permissions(parent_id,template_id,max_children) VALUES(${parentId},${value.templateId},${value.maxChildren}) ON CONFLICT(parent_id,template_id) DO UPDATE SET max_children=EXCLUDED.max_children`;
  return {templateId:value.templateId,maxChildren:value.maxChildren};
 });
}
/** Capture is asynchronous. A unique name is persisted before the first provider request. */
export async function adoptTemplate(ownerId:string,parentId:string,commandId:string,input:unknown,sql:any=db){
 const value=z.object({templateId:z.string().uuid(),childId:z.string().uuid(),expectedRevision:z.number().int().positive()}).parse(input);
 return sql.begin(async(tx:any)=>{
  const [parent]=await tx`SELECT id FROM companions WHERE id=${parentId} AND owner_id=${ownerId} AND parent_id IS NULL AND NOT temporary AND retired_at IS NULL FOR UPDATE`;
  const [prior]=await tx`SELECT id,template_id,source_companion_id,expected_revision FROM template_candidates WHERE id=${commandId}`;
  if(prior){if(!parent||prior.template_id!==value.templateId||prior.source_companion_id!==value.childId||prior.expected_revision!==value.expectedRevision)throw new LifecycleConflict('Request identifier changed.');return {candidateId:prior.id};}
  const [child]=await tx`SELECT id,software_build_id,software_result_id FROM companions WHERE id=${value.childId} AND parent_id=${parentId} AND owner_id=${ownerId} AND temporary AND retired_at IS NULL AND archive_requested_at IS NULL AND provider='box' FOR UPDATE`;
  const [template]=await tx`SELECT t.id,t.software_build_id,t.software_result_id,t.snapshot_name FROM agent_templates t JOIN template_permissions p ON p.template_id=t.id WHERE t.id=${value.templateId} AND t.owner_id=${ownerId} AND p.parent_id=${parentId} AND t.deleted_at IS NULL AND t.revision=${value.expectedRevision} FOR UPDATE OF t`;
  const active=template?await tx`SELECT id FROM template_candidates WHERE template_id=${value.templateId} AND status IN ('queued','capturing','ready') LIMIT 1`:[];
  if(active.length)throw new LifecycleConflict('A template capture is already in progress.');
  if(!parent||!child||!template)throw new LifecycleConflict('Child or template unavailable or changed.');
  if((await tx`SELECT template_id FROM specialist_drafts WHERE template_id=${value.templateId}`).length)throw new LifecycleConflict('Propose an improvement and prepare it in the specialist draft before human publication.');
  if(child.software_build_id!==template.software_build_id||child.software_result_id!==template.software_result_id)throw new LifecycleConflict('The child does not use this template software revision.');
  try{await requireSoftwareReady(ownerId,template.software_build_id,template.software_result_id,template.snapshot_name,tx);}
  catch(error){if(error instanceof SoftwareReadinessError)throw new LifecycleConflict(error.message);throw error;}
  await tx`INSERT INTO template_candidates(id,template_id,source_companion_id,expected_revision,snapshot_name) VALUES(${commandId},${value.templateId},${value.childId},${value.expectedRevision},${'companions-'+commandId})`;
  await queueTemplateSkillExport(tx,ownerId,value.templateId,value.childId,value.expectedRevision+1);
  return {candidateId:commandId};
 });
}

/** Hide the reusable role while preserving published revisions and existing missions. */
export async function deleteTemplate(ownerId:string,templateId:string,sql:any=db){
 return sql.begin(async(tx:any)=>{
  await tx`SELECT pg_advisory_xact_lock(721440140)`;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId},569))`;
  const [template]=await tx`SELECT id,deleted_at FROM agent_templates WHERE id=${templateId} AND owner_id=${ownerId} FOR UPDATE`;
  if(!template)return null;
  if(template.deleted_at)return {deleted:true};
  await tx`UPDATE agent_templates SET deleted_at=now(),updated_at=now() WHERE id=${templateId}`;
  // Keep existing missions authorized; deleted_at blocks new delegation and team edits.
  await tx`UPDATE specialist_operations SET status='failed',error='Specialist was deleted.',finished_at=now() WHERE template_id=${templateId} AND status IN ('queued','freezing','capturing','preparing','running')`;
  await tx`UPDATE specialist_drafts SET status='error',error='Specialist was deleted.' WHERE template_id=${templateId}`;
  const computers=await tx`SELECT companion_id AS id FROM specialist_drafts WHERE template_id=${templateId}
   UNION SELECT image_companion_id FROM specialist_operations WHERE template_id=${templateId} AND image_companion_id IS NOT NULL
   UNION SELECT test_companion_id FROM specialist_operations WHERE template_id=${templateId} AND test_companion_id IS NOT NULL`;
  for(const computer of computers)await retireCompanionInTransaction(ownerId,computer.id,tx);
  return {deleted:true};
 });
}
