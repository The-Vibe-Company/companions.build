import {randomBytes} from 'node:crypto';
import {encrypt} from './config';
import {recordTemplateRevision} from './templates';
import type {LifecycleMachines} from './lifecycle';

export interface SpecialistMachines extends LifecycleMachines {
 freezeSpecialist?(companion:any):Promise<void>;
 createSpecialistImage?(companion:any,checkpoint:(id:string)=>Promise<void>):Promise<boolean>;
 sanitizeSpecialistImage?(companion:any,sourceId:string):Promise<void>;
}
type Authority={assertLeader():Promise<void>;checkpoint<T>(fn:(sql:any)=>Promise<T>):Promise<T>};
/** Each provider intent is checkpointed before submission; ambiguous captures are only observed. */
export async function progressSpecialistDrafts(sql:any,machines:SpecialistMachines,authority:Authority,admit:(companion:any,kind:string)=>Promise<boolean>=async()=>true,sourceId:string|null=null,filesDurable:(run:any)=>Promise<boolean>=async()=>true){
 const operations=await sql`SELECT o.*,d.companion_id AS source_id,d.base_revision,d.name,d.instructions,d.init_script,
  t.avatar,t.model_id FROM specialist_operations o JOIN specialist_drafts d ON d.template_id=o.template_id
  JOIN agent_templates t ON t.id=o.template_id WHERE (${sourceId}::uuid IS NULL OR d.companion_id=${sourceId}) AND o.status IN ('queued','freezing','capturing','preparing','running') ORDER BY o.created_at LIMIT 20`;
 for(const op of operations){
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
    await authority.assertLeader();await machines.freezeSpecialist(source);
    await authority.checkpoint(async tx=>{
     await tx`UPDATE companions SET endpoint_secret=null,config_digest=null,prepare_requested=false WHERE id=${source.id}`;
     await tx`UPDATE specialist_operations SET status='capturing',capture_attempted_at=now() WHERE id=${op.id}`;
    });
    await authority.assertLeader();
    if(await machines.snapshotStatus(op.source_snapshot_name)==='missing')await machines.snapshot(source,op.source_snapshot_name);
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
    if(!await machines.createSpecialistImage(image,async id=>{await authority.checkpoint(async tx=>{await tx`UPDATE companions SET box_id=${id},create_started_at=COALESCE(create_started_at,now()) WHERE id=${image.id}`;});image.box_id=id;}))continue;
    await authority.assertLeader();await machines.sanitizeSpecialistImage(image,source.id);
    await authority.checkpoint(async tx=>{await tx`UPDATE specialist_operations SET sanitized_at=now(),image_capture_attempted_at=now() WHERE id=${op.id}`;});
    await authority.assertLeader();
    if(await machines.snapshotStatus(op.snapshot_name)==='missing')await machines.snapshot(image,op.snapshot_name);
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
  }catch{
   // Captures with submitted identities stay observable. Other failures have no automatic replay of work.
   if(op.status!=='capturing'&&op.status!=='preparing'&&op.status!=='freezing')await fail('Specialist preparation could not be completed. The previous publication is unchanged.');
  }
 }
}
