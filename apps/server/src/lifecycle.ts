import { z } from 'zod';
import { db } from './store';
import { config, decrypt, encrypt } from './config';
import { prepareBox, prepareLocal, agentRequest, environmentDigest, pauseMachine, archiveMachine } from './machines';
import { BoxClient, BoxError } from '../../../packages/box/client';
import { adoptTemplate, allowTemplate, listTemplates, saveTemplate, recordTemplateRevision, LifecycleConflict } from './templates';
import { spawnChild, delegateTask } from './delegation';
import type { ControlHandler } from './control';
import {billingConfiguration,productActivation} from './billing';
export const SUBSCRIPTION_REQUIRED='subscription_required: An active subscription is required to start new work.';
/** Unconfigured local development remains usable; hosted execution fails closed. */
export async function ownerMayStartWork(ownerId:string){
 if(process.env.NODE_ENV!=='production'&&billingConfiguration().mode!=='stripe')return true;
 return (await productActivation(ownerId)).allowed;
}
const terminal=['succeeded','failed','cancelled','interrupted'];
const provider=config.boxKey?new BoxClient(config.boxKey):null;
export async function migrateLifecycle(sql:any=db){await sql.unsafe(await Bun.file(new URL('./lifecycle.sql',import.meta.url)).text());}
export type UsageEvent={id:string,companionId:string,ownerId:string,event:'starting'|'ready'|'archived',at:Date};
export interface LifecycleHooks {
 canStartWork?(ownerId:string):Promise<boolean>;
 /** Called only by the executor. Persist all declared output bytes and return true after verification. */
 filesDurable?(run:any):Promise<boolean>;
 recordUsage?(event:UsageEvent):Promise<void>;
}
export interface LifecycleMachines {
 prepare(companion:any,checkpoint:(id:string)=>Promise<void>,configured:()=>Promise<void>):Promise<string|null>;
 health(endpoint:string,token:string):Promise<any>;
 pause(companion:any,paused:boolean):Promise<void>;
 archive(companion:any):Promise<boolean>;
 snapshot(companion:any,name:string):Promise<void>;
 snapshotStatus(name:string):Promise<'missing'|'pending'|'ready'|'failed'>;
}
const machines:LifecycleMachines={
 prepare:(companion,checkpoint,configured)=>companion.provider==='local'?prepareLocal(companion):prepareBox(companion,checkpoint,configured),
 health:(endpoint,token)=>agentRequest(endpoint,token,'/health'),pause:pauseMachine,archive:archiveMachine,
 async snapshot(companion,name){if(!provider)throw Error('box_not_configured');await provider.snapshot(companion.box_id,name);},
 async snapshotStatus(name){
  if(!provider)throw Error('box_not_configured');
  try {const data=await provider.getSnapshot(name);const status=data.snapshot?.status??data.namedSnapshot?.status??data.status;return status==='ready'?'ready':status==='failed'?'failed':'pending';}
  catch(error){if(error instanceof BoxError&&error.status===404)return 'missing';throw error;}
 },
};
export async function requestPreparation(ownerId:string,companionId:string,sql:any=db){
 const [row]=await sql`UPDATE companions SET prepare_requested=true,error=null WHERE id=${companionId} AND owner_id=${ownerId} AND retired_at IS NULL AND archive_requested_at IS NULL RETURNING id,status,ready_at AS "readyAt"`;
 return row??null;
}
export async function requestDesktop(ownerId:string,companionId:string,taken:boolean,sql:any=db){
 const [row]=await sql`UPDATE companions SET desktop_taken=${taken},prepare_requested=prepare_requested OR ${taken},error=null WHERE id=${companionId} AND owner_id=${ownerId} AND retired_at IS NULL AND archive_requested_at IS NULL RETURNING id,desktop_taken AS "taken",desktop_paused_at AS "pausedAt"`;
 return row??null;
}
/** API entry point: authorization and durable intents only, no machine contact. */
export async function handleLifecycle(request:{operation:string;companionId?:string;commandId?:string;runId?:string;input?:unknown},ownerId:string,sql:any=db):Promise<any>{
 const id=request.companionId;
 switch(request.operation){
  case 'templates': return listTemplates(ownerId,sql);
  case 'template_save': {
   if(id){const [actor]=await sql`SELECT parent_id,temporary FROM companions WHERE id=${id} AND owner_id=${ownerId} AND retired_at IS NULL`;if(!actor||actor.parent_id||actor.temporary)throw new LifecycleConflict('Only a permanent Companion can manage templates.');}
   return saveTemplate(ownerId,request.input,sql);
  }
 }
 if(!id)throw new LifecycleConflict('Companion required.');
 const [actor]=await sql`SELECT id,parent_id,temporary FROM companions WHERE id=${id} AND owner_id=${ownerId} AND retired_at IS NULL`;
 if(!actor)throw new LifecycleConflict('Companion unavailable.');
 if(['prepare','open_desktop','spawn','delegate','adopt_template'].includes(request.operation)&&!await ownerMayStartWork(ownerId))throw new LifecycleConflict(SUBSCRIPTION_REQUIRED);
 switch(request.operation){
  case 'prepare':case 'open_desktop':return requestPreparation(ownerId,id,sql);
  case 'desktop_takeover':return requestDesktop(ownerId,id,true,sql);
  case 'desktop_release':return requestDesktop(ownerId,id,false,sql);
  case 'template_permission':return allowTemplate(ownerId,id,request.input,sql);
  case 'spawn':case 'adopt_template':case 'delegate':{
   const command=z.string().uuid().parse(request.commandId);
   if(request.operation==='spawn')return spawnChild(ownerId,id,request.runId??null,command,request.input,sql);
   if(request.operation==='adopt_template')return adoptTemplate(ownerId,id,command,request.input,sql);
   return delegateTask(ownerId,id,z.string().uuid().parse(request.runId),command,request.input,sql);
  }
  default:throw new LifecycleConflict('Unknown lifecycle operation.');
 }
}
export const lifecycleControlHandlers:Record<string,ControlHandler>=Object.fromEntries(
 ['templates','template_save','template_permission','spawn','adopt_template','delegate','prepare','desktop_takeover','desktop_release'].map(operation=>[operation,
  (context:any,input:unknown)=>handleLifecycle({operation,companionId:context.companionId,runId:context.runId,commandId:context.commandId,input},context.ownerId)]));
async function usage(sql:any,companion:any,event:UsageEvent['event']){
 await sql`INSERT INTO machine_usage_events(id,companion_id,owner_id,event) VALUES(${crypto.randomUUID()},${companion.id},${companion.owner_id},${event})`;
}
/** Caller owns the reserved executor connection. Every external request has durable intent first. */
export async function progressLifecycle(sql:any=db,hooks:LifecycleHooks={},machine:LifecycleMachines=machines,scope?:{companionId:string;leaderPid:number}){
 const companionId=scope?.companionId??null;
 async function assertLeader(connection:any=sql){
  const [lock]=await connection`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=COALESCE(${scope?.leaderPid??null}::int,pg_backend_pid()) AND objid=721440139 AND granted) AS owned`;
  if(!lock.owned)throw Error('Executor ownership required');
 }
 await assertLeader();
 // External preparation runs concurrently; SQL transactions on the reserved connection
 // remain serialized and fenced so one failure cannot roll back another machine's identity.
 let checkpoints:Promise<unknown>=Promise.resolve();
 function checkpoint<T>(body:(tx:any)=>Promise<T>):Promise<T>{
  const result=checkpoints.then(()=>sql.begin(async(tx:any)=>{
   await assertLeader(tx);
   const value=await body(tx);await assertLeader(tx);return value;
  })) as Promise<T>;
  checkpoints=result.catch(()=>undefined);return result;
 }
 // Preparation and takeover are independent of chat. Paused daemons are never health-probed.
 const pending=await sql`SELECT * FROM companions WHERE (${companionId}::uuid IS NULL OR id=${companionId}) AND retired_at IS NULL AND (prepare_requested OR desktop_taken OR desktop_paused_at IS NOT NULL) ORDER BY created_at LIMIT 50`;
 let next=0;
 const preparation=await Promise.allSettled(Array.from({length:Math.min(8,pending.length)},async()=>{
  for(;;){const companion=pending[next++];if(!companion)return;await prepare(companion);}
 }));
 const failed=preparation.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
 async function prepare(companion:any){
  try {
   if(companion.desktop_paused_at){
    if(!companion.desktop_taken){await assertLeader();await machine.pause(companion,false);await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET desktop_paused_at=null,error=null WHERE id=${companion.id}`;});}
    return;
   }
   if(companion.prepare_requested&&!companion.archive_requested_at&&!await (hooks.canStartWork??ownerMayStartWork)(companion.owner_id)){
    await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET prepare_requested=false,preparation_started_at=null,status=CASE WHEN status='ready' THEN status ELSE 'error' END,error=${SUBSCRIPTION_REQUIRED} WHERE id=${companion.id}`;});
    companion.prepare_requested=false;
   }
   if(companion.prepare_requested&&!companion.archive_requested_at){
    if(!companion.preparation_started_at){
     await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET preparation_started_at=now(),create_started_at=COALESCE(create_started_at,now()),status='preparing',error=null WHERE id=${companion.id}`;await usage(tx,companion,'starting');});
     companion.preparation_started_at=new Date();
    }
    if(Date.now()-new Date(companion.preparation_started_at).getTime()>5*60_000){await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET prepare_requested=false,preparation_started_at=null,status='error',error='Machine preparation timed out. Request preparation to retry.' WHERE id=${companion.id}`;});return;}
    const digest=environmentDigest(companion.agent_secret,companion.provider);
    await checkpoint(async()=>{}); // Fence each provider attempt, including subsequent readiness polls.
    const endpoint=await machine.prepare(companion,async id=>{await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET box_id=${id} WHERE id=${companion.id}`;});companion.box_id=id;},async()=>{await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET config_digest=${digest} WHERE id=${companion.id}`;});});
    if(!endpoint)return;
    try{await assertLeader();if(!(await machine.health(endpoint,decrypt(companion.agent_secret)))?.ready)throw Error('agent_not_ready');}
    catch{await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET endpoint_secret=null WHERE id=${companion.id}`;});return;}
    await checkpoint(async(tx:any)=>{
     await tx`UPDATE companions SET prepare_requested=false,preparation_started_at=null,status='ready',error=null,endpoint_secret=${encrypt(endpoint)},config_digest=${digest},ready_at=now(),archived_at=null WHERE id=${companion.id}`;
     await usage(tx,companion,'ready');
    });
    companion.endpoint_secret=encrypt(endpoint);companion.status='ready';
   }
   if(companion.desktop_taken&&companion.endpoint_secret&&companion.status==='ready'){
    await assertLeader();await machine.pause(companion,true);
    await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET desktop_paused_at=now(),error=null WHERE id=${companion.id}`;});
   }
  }catch{await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET error=${companion.desktop_taken?'Desktop takeover could not be confirmed. The agent may still be running.':'Machine preparation is temporarily unavailable.'} WHERE id=${companion.id}`;});}
 }
 // A submitted snapshot name is only observed on recovery; an ambiguous POST is never repeated.
 for(const candidate of await sql`SELECT k.*,c.box_id,c.provider,c.owner_id FROM template_candidates k JOIN companions c ON c.id=k.source_companion_id WHERE (${companionId}::uuid IS NULL OR c.id=${companionId}) AND k.status IN ('queued','capturing','ready') AND NOT c.desktop_taken AND c.desktop_paused_at IS NULL ORDER BY k.requested_at LIMIT 50`){
  try{
   if(candidate.status==='queued'){
    if(!await (hooks.canStartWork??ownerMayStartWork)(candidate.owner_id)){await checkpoint(async(tx:any)=>{await tx`UPDATE template_candidates SET status='failed',error=${SUBSCRIPTION_REQUIRED} WHERE id=${candidate.id}`;});continue;}
    if(!candidate.box_id)continue;
    if((await sql`SELECT id FROM runs WHERE companion_id=${candidate.source_companion_id} AND status IN ('queued','preparing','running','needs_input') LIMIT 1`).length)continue;
    await checkpoint(async(tx:any)=>{await tx`UPDATE template_candidates SET status='capturing',attempted_at=now() WHERE id=${candidate.id}`;});
    await assertLeader();const exists=await machine.snapshotStatus(candidate.snapshot_name);
    if(exists==='missing'){
     if(!await (hooks.canStartWork??ownerMayStartWork)(candidate.owner_id)){await checkpoint(async(tx:any)=>{await tx`UPDATE template_candidates SET status='failed',error=${SUBSCRIPTION_REQUIRED} WHERE id=${candidate.id}`;});continue;}
     await assertLeader();await machine.snapshot(candidate,candidate.snapshot_name);
    }
   }
   await assertLeader();const state=await machine.snapshotStatus(candidate.snapshot_name);
   if(state==='failed'||(candidate.attempted_at&&Date.now()-new Date(candidate.attempted_at).getTime()>10*60_000&&state!=='ready')){
    await checkpoint(async(tx:any)=>{await tx`UPDATE template_candidates SET status='failed',error='Snapshot could not be confirmed. Request a new capture.' WHERE id=${candidate.id}`;});continue;
   }
   if(state!=='ready')continue;
   await checkpoint(async(tx:any)=>{
    await tx`UPDATE template_candidates SET status='ready',ready_at=COALESCE(ready_at,now()) WHERE id=${candidate.id}`;
    const [activated]=await tx`UPDATE agent_templates SET snapshot_name=${candidate.snapshot_name},source_companion_id=${candidate.source_companion_id},revision=revision+1,updated_at=now() WHERE id=${candidate.template_id} AND owner_id=${candidate.owner_id} AND revision=${candidate.expected_revision} RETURNING id`;
    if(activated)await recordTemplateRevision(tx,candidate.template_id);
    await tx`UPDATE template_candidates SET status=${activated?'activated':'failed'},error=${activated?null:'Template changed during capture; the existing template was preserved.'} WHERE id=${candidate.id}`;
   });
  }catch{/* Durable capturing intent remains observable; no blind POST retry. */}
 }
 // Snapshot source retention and output durability precede all child archive requests.
 for(const delegation of await sql`SELECT d.*,r.status,r.result_text,r.error,c.owner_id,c.temporary FROM delegations d JOIN runs r ON r.id=d.run_id JOIN companions c ON c.id=d.target_id WHERE (${companionId}::uuid IS NULL OR d.target_id=${companionId}) AND d.finished_at IS NULL AND r.status IN ('succeeded','failed','cancelled','interrupted') ORDER BY d.created_at LIMIT 50`){
  if(!delegation.files_saved_at){
   await assertLeader();
   if(!hooks.filesDurable||!await hooks.filesDurable({...delegation,id:delegation.run_id,companion_id:delegation.target_id}).catch(()=>false))continue;
   await checkpoint(async(tx:any)=>{await tx`UPDATE delegations SET files_saved_at=now() WHERE id=${delegation.id}`;});
  }
  if(!delegation.returned_run_id){
   const parentCanStart=await (hooks.canStartWork??ownerMayStartWork)(delegation.owner_id);
   await checkpoint(async(tx:any)=>{
    const [current]=await tx`SELECT * FROM delegations WHERE id=${delegation.id} FOR UPDATE`;
    if(current.returned_run_id)return;
    const result={status:delegation.status,text:delegation.result_text??null,error:delegation.error??null,runId:delegation.run_id,companionId:delegation.target_id};
    const [parent]=await tx`SELECT id FROM companions WHERE id=${delegation.parent_id} AND owner_id=${delegation.owner_id} AND retired_at IS NULL`;
    if(!parent||!parentCanStart){await tx`UPDATE delegations SET result=${result},finished_at=now() WHERE id=${delegation.id}`;if(delegation.temporary)await tx`UPDATE companions SET archive_requested_at=COALESCE(archive_requested_at,now()),prepare_requested=false WHERE id=${delegation.target_id}`;return;}
    const returned=crypto.randomUUID();
    const content='Delegated task finished. Review this result and any retained files; if useful, adopt the child Box as a template before finishing this review.\n'+JSON.stringify(result);
    await tx`INSERT INTO runs(id,companion_id,client_message_id,content,lane,source) VALUES(${returned},${delegation.parent_id},${returned},${content},'background','delegation')`;
    await tx`UPDATE delegations SET result=${result},returned_run_id=${returned} WHERE id=${delegation.id}`;
   });
   continue;
  }
  const [review]=await sql`SELECT status FROM runs WHERE id=${delegation.returned_run_id}`;
  if(!terminal.includes(review?.status))continue;
  await checkpoint(async(tx:any)=>{
   const [child]=await tx`SELECT * FROM companions WHERE id=${delegation.target_id} FOR UPDATE`;
   if(child.temporary&&(await tx`SELECT id FROM template_candidates WHERE source_companion_id=${child.id} AND status IN ('queued','capturing','ready')`).length)return;
   await tx`UPDATE delegations SET finished_at=now() WHERE id=${delegation.id}`;
   if(child.temporary)await tx`UPDATE companions SET archive_requested_at=COALESCE(archive_requested_at,now()),prepare_requested=false WHERE id=${child.id}`;
  });
 }
 for(const companion of await sql`SELECT * FROM companions WHERE (${companionId}::uuid IS NULL OR id=${companionId}) AND temporary AND archive_requested_at IS NOT NULL AND retired_at IS NULL AND NOT desktop_taken AND desktop_paused_at IS NULL ORDER BY archive_requested_at LIMIT 50`){
  if((await sql`SELECT id FROM runs WHERE companion_id=${companion.id} AND status IN ('queued','preparing','running','needs_input') LIMIT 1`).length)continue;
  if((await sql`SELECT id FROM template_candidates WHERE source_companion_id=${companion.id} AND status IN ('queued','capturing','ready')`).length)continue;
  try{
   await assertLeader();if(!await machine.archive(companion))continue;
   await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET archived_at=now(),retired_at=now(),endpoint_secret=null,desktop_paused_at=null WHERE id=${companion.id}`;await usage(tx,companion,'archived');});
  }catch{await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET error='Child archive is awaiting provider confirmation.' WHERE id=${companion.id}`;});}
 }
 if(hooks.recordUsage)for(const event of await sql`SELECT * FROM machine_usage_events WHERE (${companionId}::uuid IS NULL OR companion_id=${companionId}) AND reported_at IS NULL ORDER BY occurred_at LIMIT 100`){
  try{await assertLeader();await hooks.recordUsage({id:event.id,companionId:event.companion_id,ownerId:event.owner_id,event:event.event,at:new Date(event.occurred_at)});await checkpoint(async(tx:any)=>{await tx`UPDATE machine_usage_events SET reported_at=now() WHERE id=${event.id}`;});}catch{/* Billing delivery retries independently. */}
 }
}
