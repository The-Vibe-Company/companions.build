import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {avatarSchema} from './control';
import {db} from './store';
import {config,encrypt} from './config';
import {LifecycleConflict,saveTemplate} from './templates';
import {requestMachineAdmissionInTransaction} from './admission';

const uuid=z.string().uuid();
const editable=z.object({avatar:avatarSchema.optional(),name:z.string().trim().min(1).max(80).optional(),instructions:z.string().max(20_000).optional(),initScript:z.string().max(100_000).optional()});
const fingerprint=(input:unknown)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
export const specialistConfigurationInstructions=`You are configuring a reusable specialist, not performing its production missions.
Guide one step at a time. Make the first response useful: understand the supplied brief, choose and save a short meaningful name, and take the smallest concrete next step. Do not ask the human to describe a role they already described. If they named GitHub or Linear, propose the connections card immediately so they can connect or select accounts in the chat. Otherwise ask one focused question only when its answer changes how you prepare the specialist. Do not dump a checklist, recap obvious facts, or announce every future setup action.
Speak as the specialist in the first person, in the human's language. Keep each turn short: what you understood or verified, and the one decision or action needed now. The card already contains its controls: do not repeat their instructions or say "the card has been proposed". Card messages should explain the concrete benefit, e.g. "Connect GitHub so I can clone your repo and run its tests." Never suggest irrelevant integrations just to fill an onboarding step.
Use specialist_next_step to show ONE interactive card in the conversation: kind profile after saving a proposed name/instructions with specialist_configure; connections with providers such as ["github","linear"] when access is needed; test with a concrete suggested mission; publish only after preparation and a recommended trial. Its message is your short explanation of why this step is useful. Never invent connected accounts, installations, or test success. For repository choices and other clarifications use ask_user with concise options.
After showing a card, stop and wait for the human to complete it and continue. Inspect current state again before proposing the next card. Keep updating the profile as you learn; use specialist_configure to choose a short meaningful name instead of leaving New specialist.
Ask about the precise work, selected repositories, required skills and tools. Use plugin_connect and plugin_select for GitHub, Linear and other MCP connections; never ask users to paste credentials into chat.
Prepare selected repositories and user-space tools using your isolated shell. Do not claim an installation succeeded until verified. System installation requires a supported installation operation; never bypass your shell boundary through a desktop terminal.
Use specialist_configure {} to read the current draft generation, then specialist_configure to save mission instructions and optional init script. Use specialist_install for required apt packages. The init script runs once on a NEW intervention, never automatically on resume.
Offer a representative test. Before publication help the user review files retained in the copied disk. Browser sessions and files will be copied; MCP credentials and conversation history will not. The human publishes explicitly.
Do not publish, erase user files without approval, or report simulated progress.`;

export async function readSpecialistDraft(ownerId:string,templateId:string,sql:any=db):Promise<any>{
 const [draft]=await sql`SELECT d.template_id AS "templateId",d.companion_id AS "companionId",d.generation,d.base_revision AS "baseRevision",d.name,d.instructions,d.init_script AS "initScript",d.status,d.error,
  c.avatar,c.status AS "machineStatus",c.archived_at AS "archivedAt",t.has_published AS "hasPublished"
  FROM specialist_drafts d JOIN agent_templates t ON t.id=d.template_id JOIN companions c ON c.id=d.companion_id
  WHERE d.template_id=${templateId} AND t.owner_id=${ownerId} AND t.deleted_at IS NULL`;
 if(!draft)return null;
 const operations=await sql`SELECT id,kind,status,generation,prompt,error,assessment,test_companion_id AS "companionId",run_id AS "runId",created_at AS "createdAt",finished_at AS "finishedAt" FROM specialist_operations WHERE template_id=${templateId} AND owner_id=${ownerId} ORDER BY created_at DESC,id DESC`;
 const guidance=await sql`SELECT id,kind,message,providers,created_at AS "createdAt",responded_at AS "respondedAt" FROM specialist_guidance WHERE template_id=${templateId} ORDER BY created_at,id`;
 draft.guidance=guidance;
 draft.nextStep=guidance.at(-1)??null;
 draft.lastTest=operations.find((o:any)=>o.kind==='test')??null;
 draft.publication=operations.find((o:any)=>o.kind==='publish')??null;
 return {draft};
}

export async function createSpecialistDraft(ownerId:string,raw:unknown){
 const value=editable.extend({commandId:uuid,name:z.string().trim().min(1).max(80)}).parse(raw);
 return db.begin(async(tx:any)=>{
  await tx`SELECT pg_advisory_xact_lock(721440140)`;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId+value.commandId},7341))`;
  const [existing]=await tx`SELECT specialist_draft_id,creation_fingerprint FROM companions WHERE owner_id=${ownerId} AND client_creation_id=${value.commandId}`;
  if(existing?.specialist_draft_id){if(existing.creation_fingerprint!==fingerprint(value))throw new LifecycleConflict('Creation identifier changed.');return readSpecialistDraft(ownerId,existing.specialist_draft_id,tx);}
  const profile=await saveTemplate(ownerId,{name:value.name,instructions:value.instructions??'',...(value.avatar?{avatar:value.avatar}:{})},tx);
  await tx`UPDATE agent_templates SET has_published=false WHERE id=${profile.id}`;
  const result=await openDraftInTransaction(ownerId,profile.id,value.commandId,tx);
  await tx`UPDATE specialist_drafts SET init_script=${value.initScript??''} WHERE template_id=${profile.id}`;
  result.draft.initScript=value.initScript??'';
  await tx`UPDATE companions SET creation_fingerprint=${fingerprint(value)} WHERE id=${result.draft.companionId}`;
  const runId=crypto.randomUUID(),prompt=`Help me prepare the specialist ${value.name}.\n${value.instructions??''}\nStart by identifying the repositories, skills and connections needed for this work, then guide me through preparing and testing it.`;
  await tx`INSERT INTO runs(id,companion_id,client_message_id,content) VALUES(${runId},${result.draft.companionId},${value.commandId},${prompt})`;
  await tx`INSERT INTO messages(id,companion_id,run_id,role,content) VALUES(${crypto.randomUUID()},${result.draft.companionId},${runId},'user',${value.instructions?.trim()||prompt})`;
  const admission=await requestMachineAdmissionInTransaction(tx,ownerId,{requestId:value.commandId,companionId:result.draft.companionId,kind:'configuration'});
  if(admission.state==='refused')throw new LifecycleConflict('The specialist queue is full.');
  return result;
 });
}
async function openDraftInTransaction(ownerId:string,templateId:string,commandId:string,tx:any){
 const [template]=await tx`SELECT * FROM agent_templates WHERE id=${templateId} AND owner_id=${ownerId} AND deleted_at IS NULL FOR UPDATE`;
 if(!template)throw new LifecycleConflict('Specialist not found.');
 const previous=await readSpecialistDraft(ownerId,templateId,tx);if(previous)return previous;
 const companionId=crypto.randomUUID();
 await tx`INSERT INTO companions(id,owner_id,name,instructions,provider,create_key,agent_secret,avatar,model_id,snapshot_name,specialist_draft_id,prepare_requested,client_creation_id)
  VALUES(${companionId},${ownerId},${template.name},${specialistConfigurationInstructions},${config.boxKey&&config.boxTemplate?'box':'local'},${crypto.randomUUID()},${encrypt(randomBytes(32).toString('hex'))},${template.avatar},${template.model_id},${template.snapshot_name},${templateId},false,${commandId})`;
 await tx`INSERT INTO companion_plugins(companion_id,account_id)
  SELECT ${companionId},a.id FROM specialist_connections s JOIN plugin_accounts a ON a.id=s.account_id AND a.owner_id=${ownerId}
  WHERE s.template_id=${templateId} ON CONFLICT DO NOTHING`;
 await tx`INSERT INTO specialist_drafts(template_id,companion_id,base_revision,name,instructions,init_script) VALUES(${templateId},${companionId},${template.revision},${template.name},${template.instructions},${template.init_script??''})`;
 return readSpecialistDraft(ownerId,templateId,tx);
}
export async function openSpecialistDraft(ownerId:string,templateId:string,raw:unknown){
 const value=z.object({commandId:uuid}).parse(raw);
 return db.begin((tx:any)=>openDraftInTransaction(ownerId,templateId,value.commandId,tx));
}
export async function updateSpecialistDraft(ownerId:string,templateId:string,raw:unknown){
 const value=editable.extend({expectedGeneration:z.number().int().positive()}).parse(raw);
 return db.begin(async(tx:any)=>{
  await tx`SELECT pg_advisory_xact_lock(721440140)`;
  const [row]=await tx`SELECT d.* FROM specialist_drafts d JOIN agent_templates t ON t.id=d.template_id WHERE d.template_id=${templateId} AND t.owner_id=${ownerId} AND t.deleted_at IS NULL FOR UPDATE OF d`;
  if(!row||row.generation!==value.expectedGeneration||!['editing','error'].includes(row.status))throw new LifecycleConflict('Draft changed or is busy. Reload before editing.');
  await tx`UPDATE specialist_drafts SET name=${value.name??row.name},instructions=${value.instructions??row.instructions},init_script=${value.initScript??row.init_script},generation=generation+1,status='editing',error=null,updated_at=now() WHERE template_id=${templateId}`;
  await tx`UPDATE companions SET name=${value.name??row.name},avatar=COALESCE(${value.avatar??null}::jsonb,avatar) WHERE id=${row.companion_id}`;
  return readSpecialistDraft(ownerId,templateId,tx);
 });
}
async function requestOperation(ownerId:string,templateId:string,kind:'test'|'publish',raw:unknown){
 const value=z.object({commandId:uuid,expectedGeneration:z.number().int().positive(),prompt:z.string().trim().min(1).max(50_000).optional(),contentReviewed:z.boolean().optional()}).parse(raw);
 if(kind==='publish'&&!value.contentReviewed)throw new LifecycleConflict('Review the copied disk contents before publishing.');
 if(kind==='test'&&!value.prompt)throw new LifecycleConflict('Provide a representative test mission.');
 return db.begin(async(tx:any)=>{
  await tx`SELECT pg_advisory_xact_lock(721440140)`;
  const [draft]=await tx`SELECT d.* FROM specialist_drafts d JOIN agent_templates t ON t.id=d.template_id WHERE d.template_id=${templateId} AND t.owner_id=${ownerId} AND t.deleted_at IS NULL FOR UPDATE OF d`;
  if(!draft)throw new LifecycleConflict('Draft not found.');
  const key=fingerprint({templateId,kind,...value});
  const [previous]=await tx`SELECT id,status,fingerprint FROM specialist_operations WHERE id=${value.commandId} AND owner_id=${ownerId}`;
  if(previous){if(previous.fingerprint!==key)throw new LifecycleConflict('Command identifier changed.');return {...await readSpecialistDraft(ownerId,templateId,tx),[kind==='publish'?'publication':'test']:{id:previous.id,status:previous.status}};}
  if(draft.generation!==value.expectedGeneration||!['editing','error'].includes(draft.status))throw new LifecycleConflict('Draft changed or is busy.');
  const [active]=await tx`SELECT id FROM runs WHERE companion_id=${draft.companion_id} AND status IN ('queued','preparing','running','needs_input') LIMIT 1`;
  if(active)throw new LifecycleConflict('Finish the configuration conversation before capturing this draft.');
  await tx`INSERT INTO specialist_operations(id,template_id,owner_id,generation,kind,fingerprint,prompt,content_reviewed,snapshot_name,source_snapshot_name) VALUES(${value.commandId},${templateId},${ownerId},${draft.generation},${kind},${key},${value.prompt??null},${value.contentReviewed??false},${'specialist-'+value.commandId},${'specialist-source-'+value.commandId})`;
  if(kind==='publish'){
   const [tested]=await tx`SELECT * FROM specialist_operations WHERE template_id=${templateId} AND generation=${draft.generation} AND kind='test' AND status='succeeded' AND sanitized_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
   if(tested)await tx`UPDATE specialist_operations SET status='preparing',snapshot_name=${tested.snapshot_name},source_snapshot_name=${tested.source_snapshot_name},image_companion_id=${tested.image_companion_id},sanitized_at=${tested.sanitized_at},image_capture_attempted_at=${tested.image_capture_attempted_at} WHERE id=${value.commandId}`;
  }
  await tx`UPDATE specialist_drafts SET status=${kind==='publish'?'publishing':'testing'},error=null WHERE template_id=${templateId}`;
  const result=await readSpecialistDraft(ownerId,templateId,tx);
  return {...result,[kind==='publish'?'publication':'test']:kind==='publish'?result.draft.publication:result.draft.lastTest};
 });
}
export const requestSpecialistPublication=(ownerId:string,templateId:string,raw:unknown)=>requestOperation(ownerId,templateId,'publish',raw);
export const requestSpecialistTest=(ownerId:string,templateId:string,raw:unknown)=>requestOperation(ownerId,templateId,'test',raw);
export async function assessSpecialistTest(ownerId:string,templateId:string,testId:string,raw:unknown){
 const input=z.object({commandId:uuid,assessment:z.enum(['satisfactory','needs_changes'])}).parse(raw);
 return db.begin(async(tx:any)=>{
  const [prior]=await tx`SELECT * FROM specialist_test_assessments WHERE id=${input.commandId}`;
  if(prior){if(prior.owner_id!==ownerId||prior.operation_id!==testId||prior.assessment!==input.assessment)throw new LifecycleConflict('Assessment identifier changed.');return readSpecialistDraft(ownerId,templateId,tx);}
  const rows=await tx`UPDATE specialist_operations SET assessment=${input.assessment} WHERE id=${testId} AND template_id=${templateId} AND owner_id=${ownerId} AND kind='test' AND status IN ('succeeded','failed') RETURNING id`;
  if(!rows.length)throw new LifecycleConflict('Test has not finished or is unavailable.');
  await tx`INSERT INTO specialist_test_assessments(id,operation_id,owner_id,assessment) VALUES(${input.commandId},${testId},${ownerId},${input.assessment})`;
  return readSpecialistDraft(ownerId,templateId,tx);
 });
}

export async function proposeSpecialistNextStep(ownerId:string,companionId:string,runId:string,commandId:string,raw:unknown){
 const value=z.object({kind:z.enum(['profile','connections','test','publish']),message:z.string().trim().min(1).max(2000),providers:z.array(z.string().min(1).max(100)).max(8).default([])}).parse(raw);
 return db.begin(async(tx:any)=>{
  const [draft]=await tx`SELECT d.template_id FROM specialist_drafts d JOIN companions c ON c.id=d.companion_id JOIN runs r ON r.companion_id=c.id WHERE c.id=${companionId} AND c.owner_id=${ownerId} AND c.retired_at IS NULL AND r.id=${runId} AND r.status IN ('running','needs_input') AND NOT r.cancel_requested FOR UPDATE OF d`;
  if(!draft)throw new LifecycleConflict('Open an active specialist configuration conversation first.');
  await tx`INSERT INTO specialist_guidance(id,template_id,run_id,kind,message,providers) VALUES(${commandId},${draft.template_id},${runId},${value.kind},${value.message},${value.providers}::jsonb) ON CONFLICT(id) DO NOTHING`;
  return {shown:true,kind:value.kind,instructions:'The card is displayed in chat. Wait for the human to complete this step.'};
 });
}
