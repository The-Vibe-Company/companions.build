import {randomBytes} from 'node:crypto';
import {encrypt} from './config';
import {recordTemplateRevision} from './templates';
import type {LifecycleMachines} from './lifecycle';
import {requestMachineAdmissionInTransaction} from './admission';
import {deferRejectedBoxStart} from './specialist-provider';
import {BoxError} from '../../../packages/box/client';

export interface SpecialistMachines extends LifecycleMachines {
 freezeSpecialist?(companion:any,beforeEffect?:()=>Promise<void>):Promise<void>;
 createSpecialistImage?(companion:any,checkpoint:(id:string)=>Promise<void>,beforeEffect?:()=>Promise<void>):Promise<boolean>;
 sanitizeSpecialistImage?(companion:any,sourceId:string,beforeEffect?:()=>Promise<void>):Promise<void>;
}
type Authority={assertLeader():Promise<void>;checkpoint<T>(fn:(sql:any)=>Promise<T>):Promise<T>};
/** Each provider intent is checkpointed before submission; ambiguous captures are only observed. */
export async function progressSpecialistDrafts(sql:any,machines:SpecialistMachines,executor:Authority,admit:(companion:any,kind:string)=>Promise<boolean>=async()=>true,sourceId:string|null=null,filesDurable:(run:any)=>Promise<boolean>=async()=>true){
 const operations=await sql`SELECT o.*,d.companion_id AS source_id,d.base_revision,d.name,d.instructions,d.init_script,
  t.avatar,t.model_id FROM specialist_operations o JOIN specialist_drafts d ON d.template_id=o.template_id
  JOIN agent_templates t ON t.id=o.template_id WHERE (${sourceId}::uuid IS NULL OR d.companion_id=${sourceId}) AND o.status IN ('queued','freezing','capturing','preparing','running') ORDER BY o.created_at LIMIT 20`;
 for(const op of operations){
  const authority:Authority={
   async assertLeader(){
    await executor.assertLeader();
    const [current]=await sql`SELECT id FROM specialist_operations WHERE id=${op.id} AND status IN ('queued','freezing','capturing','preparing','running')`;
    if(!current)throw Error('operation_stopped');
   },
   checkpoint:fn=>executor.checkpoint(async tx=>{
    // Cancellation and admission take this same lock before the operation row.
    await tx`SELECT pg_advisory_xact_lock(721440140)`;
    const [current]=await tx`SELECT id FROM specialist_operations WHERE id=${op.id} AND status IN ('queued','freezing','capturing','preparing','running') FOR UPDATE`;
    if(!current)throw Error('operation_stopped');
    return fn(tx);
   }),
  };
  const fail=async(message:string)=>authority.checkpoint(async tx=>{
   await tx`UPDATE specialist_operations SET status='failed',error=${message},finished_at=now() WHERE id=${op.id}`;
   await tx`UPDATE specialist_drafts SET status='error',error=${message} WHERE template_id=${op.template_id}`;
   await tx`UPDATE companions SET archive_requested_at=COALESCE(archive_requested_at,now()),prepare_requested=false WHERE id=${op.image_companion_id} AND box_id IS NOT NULL`;
  });
  try{
   await authority.assertLeader();
   const [source]=await sql`SELECT * FROM companions WHERE id=${op.source_id} AND owner_id=${op.owner_id} AND retired_at IS NULL`;
   if(!source){await fail('Configuration machine is unavailable.');continue;}
   if(source.provider!=='box'||!machines.freezeSpecialist||!machines.createSpecialistImage||!machines.sanitizeSpecialistImage){await fail('Prepared disk publication requires the Box runtime.');continue;}
   if(op.status==='queued'){
    if(source.desktop_taken)continue;
    if((await sql`SELECT id FROM runs WHERE companion_id=${source.id} AND status IN ('queued','preparing','running','needs_input') LIMIT 1`).length)continue;
    if(!source.box_id||source.archived_at){await authority.checkpoint(async tx=>{await tx`UPDATE companions SET prepare_requested=true,archive_requested_at=null WHERE id=${source.id}`;});continue;}
    await authority.checkpoint(async tx=>{await tx`UPDATE specialist_operations SET status='freezing' WHERE id=${op.id} AND status='queued'`;});
    continue;
   }
   if(op.status==='freezing'){
    await authority.assertLeader();await machines.freezeSpecialist(source,()=>authority.assertLeader());
    await authority.checkpoint(async tx=>{
     await tx`UPDATE companions SET endpoint_secret=null,config_digest=null,prepare_requested=false WHERE id=${source.id}`;
     await tx`UPDATE specialist_operations SET status='capturing',capture_attempted_at=now() WHERE id=${op.id}`;
    });
    await authority.assertLeader();
    if(await machines.snapshotStatus(op.source_snapshot_name)==='missing'){await authority.assertLeader();await machines.snapshot(source,op.source_snapshot_name);}
    continue;
   }
   if(!op.image_companion_id){
    const state=await machines.snapshotStatus(op.source_snapshot_name);
    if(state==='failed'){await fail('Draft capture failed; the published version is unchanged.');continue;}
    if(state!=='ready'){
     if(op.capture_attempted_at&&Date.now()-new Date(op.capture_attempted_at).getTime()>600_000)await fail('Draft capture could not be confirmed. Inspect before requesting another capture.');
     continue;
    }
    if(!source.archived_at){await authority.checkpoint(async tx=>{await tx`UPDATE companions SET archive_requested_at=COALESCE(archive_requested_at,now()),prepare_requested=false WHERE id=${source.id}`;});continue;}
    const imageId=crypto.randomUUID();
    await authority.checkpoint(async tx=>{
     await tx`INSERT INTO companions(id,owner_id,name,instructions,provider,create_key,agent_secret,avatar,temporary,snapshot_name)
      VALUES(${imageId},${op.owner_id},${op.name},'', 'box',${crypto.randomUUID()},${encrypt(randomBytes(32).toString('hex'))},${op.avatar},true,${op.source_snapshot_name})`;
     await tx`UPDATE specialist_operations SET image_companion_id=${imageId},status='preparing' WHERE id=${op.id}`;
    });continue;
   }
   const [image]=await sql`SELECT * FROM companions WHERE id=${op.image_companion_id}`;
   if(!op.sanitized_at){
    if(!await admit(image,'capture'))continue;
    await authority.assertLeader();
    if(!image.box_id&&!image.create_started_at)await authority.checkpoint(async tx=>{
     await tx`UPDATE companions SET create_started_at=now(),preparation_started_at=now() WHERE id=${image.id}`;
    });
    if(!await machines.createSpecialistImage(image,async id=>{
     // A late successful create still needs its identity recorded for cancellation cleanup.
     await executor.checkpoint(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(721440140)`;
      const [state]=await tx`SELECT status FROM specialist_operations WHERE id=${op.id} FOR UPDATE`;
      const stopped=!state||['failed','succeeded'].includes(state.status);
      await tx`UPDATE companions SET box_id=${id},create_started_at=COALESCE(create_started_at,now()),
       archive_requested_at=CASE WHEN ${stopped} THEN COALESCE(archive_requested_at,now()) ELSE archive_requested_at END WHERE id=${image.id}`;
      if(stopped)await tx`UPDATE machine_admission_requests SET state='cancelling',released_at=null,waiting_reason='archive_pending' WHERE companion_id=${image.id} AND state IN ('admitted','cancelled')`;
     });image.box_id=id;
    },()=>authority.assertLeader()))continue;
    await authority.assertLeader();await machines.sanitizeSpecialistImage(image,source.id,()=>authority.assertLeader());
    await authority.checkpoint(async tx=>{await tx`UPDATE specialist_operations SET sanitized_at=now(),image_capture_attempted_at=now() WHERE id=${op.id}`;});
    await authority.assertLeader();
    if(await machines.snapshotStatus(op.snapshot_name)==='missing'){await authority.assertLeader();await machines.snapshot(image,op.snapshot_name);}
    continue;
   }
   const captured=await machines.snapshotStatus(op.snapshot_name);
   if(captured==='failed'){await fail('Prepared image capture failed.');continue;}
   if(captured!=='ready'){
    if(op.image_capture_attempted_at&&Date.now()-new Date(op.image_capture_attempted_at).getTime()>600_000)await fail('Prepared image could not be confirmed.');
    continue;
   }
   if(!image.archived_at){await authority.checkpoint(async tx=>{await tx`UPDATE companions SET archive_requested_at=COALESCE(archive_requested_at,now()),prepare_requested=false WHERE id=${image.id}`;});continue;}
   if(op.kind==='publish'){
    await authority.checkpoint(async tx=>{
     const [current]=await tx`SELECT generation FROM specialist_drafts WHERE template_id=${op.template_id} FOR UPDATE`;
     if(current?.generation!==op.generation)throw Error('draft_changed');
     const [published]=await tx`UPDATE agent_templates SET name=${op.name},instructions=${op.instructions},init_script=${op.init_script},snapshot_name=${op.snapshot_name},prepared_disk_snapshot=${op.snapshot_name},software_build_id=null,software_result_id=null,skill_bundle_id=null,source_companion_id=${op.source_id},has_published=true,revision=revision+1,updated_at=now()
      WHERE id=${op.template_id} AND revision=${op.base_revision} RETURNING revision`;
     if(!published)throw Error('template_changed');
     await recordTemplateRevision(tx,op.template_id);
     await tx`UPDATE template_revisions SET init_script=${op.init_script} WHERE template_id=${op.template_id} AND revision=${published.revision}`;
     await tx`DELETE FROM specialist_connections WHERE template_id=${op.template_id}`;
     await tx`INSERT INTO specialist_connections(template_id,slot,account_id,provider,label,server_id)
      SELECT ${op.template_id},p.id::text,p.id,p.provider,p.label,p.server_id FROM companion_plugins cp JOIN plugin_accounts p ON p.id=cp.account_id AND p.owner_id=${op.owner_id} WHERE cp.companion_id=${op.source_id}`;
     await tx`INSERT INTO specialist_revision_connections SELECT template_id,${published.revision},slot,account_id,required,provider,label,server_id FROM specialist_connections WHERE template_id=${op.template_id}`;
     await tx`UPDATE specialist_operations SET status='succeeded',finished_at=now() WHERE id=${op.id}`;
     await tx`UPDATE specialist_drafts SET status='editing',base_revision=${published.revision},error=null WHERE template_id=${op.template_id}`;
    });continue;
   }
   if(!op.run_id){
    await authority.checkpoint(async tx=>{
     const childId=crypto.randomUUID(),runId=crypto.randomUUID();
     await tx`INSERT INTO companions(id,owner_id,name,instructions,init_script,provider,create_key,agent_secret,avatar,temporary,snapshot_name,template_id,template_revision,model_id,prepare_requested)
      VALUES(${childId},${op.owner_id},${op.name},${op.instructions},${op.init_script},'box',${crypto.randomUUID()},${encrypt(randomBytes(32).toString('hex'))},${op.avatar},true,${op.snapshot_name},${op.template_id},${op.base_revision},${op.model_id},true)`;
     await tx`INSERT INTO companion_plugins(companion_id,account_id) SELECT ${childId},account_id FROM companion_plugins WHERE companion_id=${op.source_id}`;
     await tx`INSERT INTO runs(id,companion_id,client_message_id,content) VALUES(${runId},${childId},${op.id},${op.prompt})`;
     await tx`INSERT INTO messages(id,companion_id,run_id,role,content) VALUES(${crypto.randomUUID()},${childId},${runId},'user',${op.prompt})`;
     await tx`UPDATE specialist_operations SET test_companion_id=${childId},run_id=${runId},status='running' WHERE id=${op.id}`;
     const admission=await requestMachineAdmissionInTransaction(tx,op.owner_id,{requestId:op.id,companionId:childId,kind:'test'});
     if(admission.state==='refused')throw Error('queue_full');
    });continue;
   }
   const [run]=await sql`SELECT * FROM runs WHERE id=${op.run_id}`;
   if(run&&['succeeded','failed','interrupted','cancelled'].includes(run.status)){
    if(!op.test_files_saved_at){
     if(!await filesDurable(run))continue;
     await authority.checkpoint(async tx=>{await tx`UPDATE specialist_operations SET test_files_saved_at=now() WHERE id=${op.id}`;});
    }
    const [tested]=await sql`SELECT archived_at FROM companions WHERE id=${op.test_companion_id}`;
    if(!tested?.archived_at){await authority.checkpoint(async tx=>{await tx`UPDATE companions SET archive_requested_at=COALESCE(archive_requested_at,now()),prepare_requested=false WHERE id=${op.test_companion_id}`;});continue;}
    await authority.checkpoint(async tx=>{
    await tx`UPDATE specialist_operations SET status=${run.status==='succeeded'?'succeeded':'failed'},finished_at=now() WHERE id=${op.id}`;
    await tx`UPDATE specialist_drafts SET status='editing' WHERE template_id=${op.template_id}`;
   });
   }
  }catch(error){
   if(error instanceof Error&&error.message==='operation_stopped')continue;
   await executor.assertLeader();
   if(op.image_companion_id&&await deferRejectedBoxStart(sql,op.image_companion_id,error))continue;
   if(error instanceof BoxError&&['box_snapshot_limit','box_snapshot_saving'].includes(error.code)){
    await fail(error.code==='box_snapshot_limit'?'The provider snapshot limit was reached. Review retained snapshot capacity before retrying; the published version is unchanged.':'The provider is already saving this snapshot. Inspect its state before retrying; the published version is unchanged.');continue;
   }
   if(error instanceof Error&&['image_creation_needs_reconciliation','image_preparation_failed'].includes(error.message)){
    await fail(error.message==='image_creation_needs_reconciliation'?'The image creation could not be confirmed within the provider idempotency window. Reconcile the existing request before retrying.':'The image machine failed to prepare. The published specialist is unchanged.');continue;
   }
   if(error instanceof Error&&error.message==='capture_policy_requires_review'){
    await fail('Snapshot exclusions need review. Remove active .boxignore or .oneignore rules that could omit prepared files, then request the test or publication again.');continue;
   }
   if(error instanceof Error&&['capture_admission_refused','queue_full','draft_changed','template_changed'].includes(error.message)){
    await fail(error.message==='capture_admission_refused'||error.message==='queue_full'?'Preparation stopped because no queue place is available or the admission was cancelled. Retry explicitly.':'The draft or publication changed. Review the current version before publishing.');continue;
   }
   // Captures with submitted identities stay observable. Other failures have no automatic replay of work.
   if(op.status!=='capturing'&&op.status!=='preparing'&&op.status!=='freezing')await fail('Specialist preparation could not be completed. The previous publication is unchanged.');
  }
 }
}
