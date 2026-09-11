import {progressRuntimeUpdate} from "./runtime-updates";
import {privateBetaEmails} from "./private-beta";
import {tracePreparation} from './preparation-trace';
import {progressRetirements} from './retirement';
import {handoffDelegationFiles} from './files';
import { db } from './store';
import { config, decrypt, encrypt } from './config';
import { prepareBox, prepareLocal, agentRequest, environmentDigest, pauseMachine, archiveMachine, machinePreparationReady, ExecutionStopped, MachineError, type EffectGuard, type DesktopMachineState } from './machines';
import { BoxClient, BoxError } from '../../../packages/box/client';
import {LifecycleConflict} from './lifecycle-errors';
import type { ControlHandler } from './control';
import {billingConfiguration,productActivation} from './billing';
import {progressDeliverySkillsForCompanion,stageDeliverySkills,type DeliverySkillDependencies} from './delivery-skills';
import {machineAdmissionAllowsEffect,progressMachineAdmissions,requestMachineAdmission} from './admission';
export const SUBSCRIPTION_REQUIRED='subscription_required: An active subscription is required to start new work.';
/** Unconfigured local development remains usable; hosted execution fails closed. */
export async function ownerMayStartWork(ownerId:string){
 if(privateBetaEmails()===null&&process.env.NODE_ENV!=='production'&&billingConfiguration().mode!=='stripe')return true;
 return (await productActivation(ownerId)).allowed;
}
const terminal=['succeeded','failed','cancelled','interrupted'];
const provider=config.boxKey?new BoxClient(config.boxKey):null;
export async function migrateLifecycle(sql:any=db){await sql.unsafe(await Bun.file(new URL('./lifecycle.sql',import.meta.url)).text());await sql.unsafe(await Bun.file(new URL('./desktop.sql',import.meta.url)).text());}
export type UsageEvent={id:string,companionId:string,ownerId:string,event:'starting'|'ready'|'archived',at:Date};
export interface LifecycleHooks {
 canStartWork?(ownerId:string):Promise<boolean>;
 /** Called only by the executor. Persist all declared output bytes and return true after verification. */
 filesDurable?(run:any):Promise<boolean>;
 recordUsage?(event:UsageEvent):Promise<void>;
 deliverySkills?:DeliverySkillDependencies;
 /** Product operations can hold a durable write/freeze lease that blocks idle archival. */
 canArchiveMachine?(companion:any):Promise<boolean>;
}
export interface LifecycleMachines {
 preparationReady?(companion:any,beforeEffect?:EffectGuard):Promise<boolean>;
 prepare(companion:any,checkpoint:(id:string)=>Promise<void>,configured:()=>Promise<void>,beforeEffect?:EffectGuard):Promise<string|null>;
 health(endpoint:string,token:string):Promise<any>;
 pause(companion:any,paused:boolean,beforeEffect?:EffectGuard):Promise<DesktopMachineState|void>;
 archive(companion:any,beforeEffect?:EffectGuard):Promise<boolean>;
 cancel?(companion:any,runId:string,beforeEffect:EffectGuard):Promise<boolean>;
 snapshot?(companion:any,name:string):Promise<void>;
 snapshotStatus?(name:string):Promise<'missing'|'pending'|'ready'|'failed'>;
}
const machines:LifecycleMachines={
 preparationReady:machinePreparationReady,
 prepare:(companion,checkpoint,configured,beforeEffect)=>companion.provider==='local'?prepareLocal(companion,true,beforeEffect):prepareBox(companion,checkpoint,configured,beforeEffect),
 health:(endpoint,token)=>agentRequest(endpoint,token,'/health'),pause:pauseMachine,archive:archiveMachine,
 async cancel(companion,runId,beforeEffect){
  await beforeEffect();const result=await agentRequest(decrypt(companion.endpoint_secret),decrypt(companion.agent_secret),`/runs/${runId}/cancel`,'POST');
  await beforeEffect();return terminal.includes(result?.status);
 },
};
export async function requestPreparation(ownerId:string,companionId:string,sql:any=db,requestId?:string){
 const [companion]=await sql`SELECT id,status,archived_at FROM companions WHERE id=${companionId} AND owner_id=${ownerId} AND retired_at IS NULL`;
 if(!companion)return null;
 const [open]=await sql`SELECT * FROM machine_admission_requests WHERE companion_id=${companionId} AND state IN ('queued','admitted','cancelling') ORDER BY requested_at DESC LIMIT 1`;
 if(open)return {id:companionId,status:companion.status,admission:{id:open.id,state:open.state,waitingReason:open.waiting_reason??null}};
 const admission=await requestMachineAdmission(ownerId,{requestId:requestId??crypto.randomUUID(),companionId,kind:companion.archived_at?'resume':'configuration'},sql);
 return {id:companionId,status:companion.status,admission};
}
export async function requestDesktop(ownerId:string,companionId:string,taken:boolean,sql:any=db,source:'human'|'agent'='human'){
 return sql.begin(async(tx:any)=>{
  await tx`SELECT pg_advisory_xact_lock(721440140)`;
  const [row]=await tx`UPDATE companions SET desktop_generation=desktop_generation+CASE WHEN desktop_taken<>${taken} THEN 1 ELSE 0 END, desktop_taken=${taken},prepare_requested=prepare_requested OR (${taken} AND (status<>'ready' OR endpoint_secret IS NULL OR archived_at IS NOT NULL)),desktop_checked_at=null,error=null WHERE id=${companionId} AND owner_id=${ownerId} AND retired_at IS NULL AND archive_requested_at IS NULL AND NOT (${source==='agent'&&!taken} AND desktop_taken) RETURNING id,desktop_taken AS "taken",desktop_paused_at AS "pausedAt",desktop_generation AS generation`;
  if(!row&&source==='agent'&&!taken)throw new LifecycleConflict('HUMAN_DESKTOP_RELEASE_REQUIRED');
  return row??null;
 });
}
/** API entry point: authorization and durable intents only, no machine contact. */
export async function handleLifecycle(request:{operation:string;companionId?:string;commandId?:string;runId?:string;input?:unknown;source?:'human'|'agent'},ownerId:string,sql:any=db):Promise<any>{
 const id=request.companionId;if(!id)throw new LifecycleConflict('Companion required.');
 const [actor]=await sql`SELECT id FROM companions WHERE id=${id} AND owner_id=${ownerId} AND retired_at IS NULL`;if(!actor)throw new LifecycleConflict('Companion unavailable.');
 if(['prepare','open_desktop'].includes(request.operation)&&!await ownerMayStartWork(ownerId))throw new LifecycleConflict(SUBSCRIPTION_REQUIRED);
 if(request.operation==='prepare'||request.operation==='open_desktop')return requestPreparation(ownerId,id,sql,request.commandId);
 if(request.operation==='desktop_takeover')return requestDesktop(ownerId,id,true,sql,request.source??'human');
 if(request.operation==='desktop_release')return requestDesktop(ownerId,id,false,sql,request.source??'human');
 throw new LifecycleConflict('Unknown lifecycle operation.');
}
export const lifecycleControlHandlers:Record<string,ControlHandler>=Object.fromEntries(['prepare','desktop_takeover','desktop_release'].map(operation=>[operation,(context:any,input:unknown)=>handleLifecycle({operation,companionId:context.companionId,runId:context.runId,commandId:context.commandId,input,source:'agent'},context.ownerId)]));
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
 if(companionId&&await progressRuntimeUpdate(sql,companionId,()=>assertLeader()))return;
 await progressMachineAdmissions(sql,{eligible:async()=>({eligible:true})});
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
 await progressRetirements(sql,companionId,machine,()=>assertLeader(),checkpoint,(tx,companion)=>usage(tx,companion,'archived'));
 // GUI coordination never pauses the Pi daemon or headless work. Periodic reconciliation
 // reopens a restarted fail-closed broker only to the current durable human intent.
 const pending=await sql`SELECT * FROM companions WHERE (${companionId}::uuid IS NULL OR id=${companionId}) AND retired_at IS NULL AND
   (prepare_requested OR ((desktop_boundary_version=1 OR desktop_taken) AND status='ready' AND endpoint_secret IS NOT NULL AND
   (desktop_checked_at IS NULL OR desktop_checked_at<now()-interval '30 seconds' OR
     (desktop_observed_generation IS DISTINCT FROM desktop_generation AND desktop_checked_at<now()-interval '2 seconds')))) ORDER BY created_at LIMIT 50`;
 let next=0;
 const preparation=await Promise.allSettled(Array.from({length:Math.min(8,pending.length)},async()=>{
  for(;;){const companion=pending[next++];if(!companion)return;await prepare(companion);}
 }));
 const failed=preparation.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
 async function prepare(companion:any){
  let machinePreparationActive=false;
  async function beforePrepareEffect(){
   await assertLeader();
   const [latest]=await sql`SELECT owner_id,box_id,desktop_paused_at,retired_at,archive_requested_at,
    EXISTS(SELECT 1 FROM runs WHERE companion_id=${companion.id} AND dispatched AND status IN ('preparing','running','needs_input')) AS active_execution
    FROM companions WHERE id=${companion.id}`;
   if(!latest||latest.owner_id!==companion.owner_id||latest.box_id!==companion.box_id||latest.retired_at||latest.archive_requested_at)throw new ExecutionStopped('Machine preparation authority changed');
   if(!await machineAdmissionAllowsEffect(companion.id,sql))throw new ExecutionStopped('Machine is waiting for admission');
   if(latest.active_execution)throw new ExecutionStopped('Machine preparation waits for active work');
   if(!await (hooks.canStartWork??ownerMayStartWork)(companion.owner_id))throw new ExecutionStopped(SUBSCRIPTION_REQUIRED);
   await assertLeader();
  }
  try {
   if(companion.prepare_requested){
    const [prior]=await sql`SELECT state FROM machine_admission_requests WHERE companion_id=${companion.id} AND state IN ('queued','admitted','cancelling')`;
    if(!prior){const admitted=await requestMachineAdmission(companion.owner_id,{requestId:crypto.randomUUID(),companionId:companion.id,kind:companion.archived_at?'resume':'configuration'},sql);if(admitted.state==='refused')await checkpoint(async tx=>{await tx`UPDATE companions SET prepare_requested=false,error='The machine queue is full. Request preparation again when a place is available.' WHERE id=${companion.id}`;});if(admitted.state!=='admitted')return;}
    else if(prior.state!=='admitted')return;
   }
   const digest=environmentDigest(companion.agent_secret,companion.provider);
   const reusable=companion.status==='ready'&&companion.endpoint_secret&&companion.box_id&&companion.config_digest===digest;
   if(companion.prepare_requested&&!companion.archive_requested_at&&!reusable&&!await (hooks.canStartWork??ownerMayStartWork)(companion.owner_id)){
    await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET prepare_requested=false,preparation_started_at=null,status=CASE WHEN status='ready' THEN status ELSE 'error' END,error=${SUBSCRIPTION_REQUIRED} WHERE id=${companion.id}`;});
    companion.prepare_requested=false;
   }
   // Keep explicit configuration intent pending until every dispatched session
   // is settled. GUI coordination below remains available while work continues.
   const [activity]=companion.prepare_requested?await sql`SELECT EXISTS(SELECT 1 FROM runs WHERE companion_id=${companion.id} AND dispatched AND status IN ('preparing','running','needs_input')) AS active`: [{active:false}];
   if(companion.prepare_requested&&!companion.archive_requested_at&&!activity.active){
    machinePreparationActive=true;
    if(machine.preparationReady&&!await machine.preparationReady(companion,beforePrepareEffect)){
     await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET status='preparing',error=${companion.baseImageError?'Base image publication is blocked: '+companion.baseImageError:'Base image publication is pending.'} WHERE id=${companion.id}`;});return;
    }
    if(!companion.preparation_started_at){
     const started=await checkpoint(async(tx:any)=>{const [value]=await tx`UPDATE companions SET preparation_started_at=now(),create_started_at=COALESCE(create_started_at,now()),status=CASE WHEN ${reusable} THEN status ELSE 'preparing' END,error=null WHERE id=${companion.id} RETURNING preparation_started_at,create_started_at`;if(!reusable)await usage(tx,companion,'starting');return value;});
     companion.preparation_started_at=started.preparation_started_at;companion.create_started_at=started.create_started_at;
    }
    if(Date.now()-new Date(companion.preparation_started_at).getTime()>5*60_000){await checkpoint(async(tx:any)=>{
     await tx`UPDATE companions SET prepare_requested=false,preparation_started_at=null,status='error',error='Machine preparation timed out. Request preparation to retry.' WHERE id=${companion.id}`;
     await tx`UPDATE runs SET status='failed',finished_at=now(),error='Preparation timed out. Send a new message to retry.' WHERE companion_id=${companion.id} AND status IN ('queued','preparing') AND NOT dispatched`;
    });return;}
    await checkpoint(async()=>{}); // Fence each provider attempt, including subsequent readiness polls.
    const endpoint=reusable?decrypt(companion.endpoint_secret):await machine.prepare(companion,async id=>{await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET box_id=${id} WHERE id=${companion.id}`;});companion.box_id=id;},async()=>{await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET config_digest=${digest} WHERE id=${companion.id}`;});},beforePrepareEffect);
    if(!endpoint)return;
    async function health(){
     await assertLeader();
     const value=await tracePreparation(companion.id,'lifecycle_health',()=>machine.health(endpoint!,decrypt(companion.agent_secret)),value=>value?.ready?'ready':'not_ready');
     if(!value?.ready)throw Error('agent_not_ready');return value;
    }
    try{
     let observed;
     try{observed=await health();}
     catch(error){
      // A newly prepared private preview can lag the service. Retry its health
      // once inside this independent job before repeating env/start/host work.
      // Invalid warm endpoints still enter ordinary repair immediately.
      const deadline=new Date(companion.preparation_started_at).getTime()+5*60_000;
      // Reserve both the delay and agentRequest's two-second health timeout.
      if(reusable||Date.now()+2_250>=deadline)throw error;
      await Bun.sleep(250);await beforePrepareEffect();
      if(Date.now()+2_000>=deadline)throw error;
      observed=await health();
     }
     companion.desktop_boundary_version=observed.desktopBoundaryVersion===1?1:0;
    }catch(error){if(error instanceof ExecutionStopped)throw error;await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET endpoint_secret=null WHERE id=${companion.id}`;});return;}
    const execution={sql,assertLeader,checkpoint};
    await stageDeliverySkills(companion.id,endpoint,decrypt(companion.agent_secret),hooks.deliverySkills,execution);
    const portable=await progressDeliverySkillsForCompanion(sql,companion.id,endpoint,decrypt(companion.agent_secret),hooks.deliverySkills,execution);
    await tracePreparation(companion.id,'ready_checkpoint',()=>checkpoint(async(tx:any)=>{
     await tx`UPDATE companions SET prepare_requested=${portable.pending>0},preparation_started_at=${portable.pending>0?companion.preparation_started_at:null},status='ready',error=${portable.pending>0?'Portable skills are waiting to be exported.':null},endpoint_secret=${encrypt(endpoint)},config_digest=${digest},ready_at=now(),archived_at=null,desktop_boundary_version=${companion.desktop_boundary_version} WHERE id=${companion.id}`;
     await tx`UPDATE companions SET machine_activity_at=COALESCE(machine_activity_at,now()) WHERE id=${companion.id}`;
     await tx`UPDATE machine_admission_requests SET state='completed',released_at=COALESCE(released_at,now()),waiting_reason=null WHERE companion_id=${companion.id} AND state='admitted'`;
     if(!reusable)await usage(tx,companion,'ready');
    }));
    companion.endpoint_secret=encrypt(endpoint);companion.status='ready';
    machinePreparationActive=false;
   }
   if((companion.desktop_taken||companion.desktop_boundary_version===1)&&companion.endpoint_secret&&companion.status==='ready'&&!companion.archive_requested_at){
    async function desktopGuard(){
     await assertLeader();
     const [current]=await sql`SELECT id FROM companions WHERE id=${companion.id} AND owner_id=${companion.owner_id} AND box_id IS NOT DISTINCT FROM ${companion.box_id}
       AND desktop_generation=${companion.desktop_generation} AND desktop_taken=${companion.desktop_taken} AND retired_at IS NULL AND archive_requested_at IS NULL`;
     if(!current)throw new ExecutionStopped('Desktop intent changed');
     await assertLeader();
    }
    await desktopGuard();
    const observed=await machine.pause(companion,companion.desktop_taken,desktopGuard);
    if(!observed||!observed.confirmed||observed.generation!==Number(companion.desktop_generation)||observed.taken!==companion.desktop_taken)throw Error('desktop_not_confirmed');
    await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET desktop_paused_at=CASE WHEN ${observed.taken} THEN COALESCE(desktop_paused_at,now()) ELSE NULL END,
      desktop_observed_generation=${observed.generation},desktop_broker_boot_id=${observed.bootId},desktop_checked_at=now(),error=null
      WHERE id=${companion.id} AND desktop_generation=${observed.generation} AND desktop_taken=${observed.taken}`;});
   }
  }catch(error){
   if(error instanceof ExecutionStopped)throw error;
   await assertLeader();
   // Once creation is checkpointed, readiness/configuration retries target the
   // same Box and remain bounded by the existing preparation deadline. In
   // particular, private preview registration can lag a successful service start.
   // An unconfirmed create still stops immediately rather than consuming starts.
   const terminalBoxFailure=machinePreparationActive&&companion.provider==='box'&&
    (error instanceof MachineError||(error instanceof BoxError&&!companion.box_id));
   if(terminalBoxFailure){
    const message=error instanceof BoxError&&error.code==='box_not_found'&&!companion.box_id
     ?'Machine image is unavailable. Request preparation to retry.'
     :!companion.box_id&&companion.create_started_at
      ?'Machine creation could not be confirmed. Request preparation to retry.'
      :'Machine preparation failed. Request preparation to retry.';
    await checkpoint(async(tx:any)=>{
     await tx`UPDATE companions SET prepare_requested=false,preparation_started_at=null,status='error',error=${message} WHERE id=${companion.id}`;
     await tx`UPDATE runs SET status='failed',finished_at=now(),error=${message} WHERE companion_id=${companion.id} AND status IN ('queued','preparing') AND NOT dispatched`;
    });return;
   }
   await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET desktop_checked_at=now(),error=${companion.desktop_taken?'Desktop takeover could not be confirmed. Desktop interactions may still be active.':'Machine preparation is temporarily unavailable.'} WHERE id=${companion.id} AND desktop_generation=${companion.desktop_generation}`;});
  }
 }
 // Persist delegated output before scheduling the parent's review task.
 for(const delegation of await sql`SELECT d.*,r.status,r.result_text,r.error,c.owner_id FROM delegations d JOIN runs r ON r.id=d.run_id JOIN companions c ON c.id=d.target_id WHERE (${companionId}::uuid IS NULL OR d.target_id=${companionId}) AND d.finished_at IS NULL AND r.status IN ('succeeded','failed','cancelled','interrupted') ORDER BY d.created_at LIMIT 50`){
  if(!delegation.files_saved_at){
   await assertLeader();
   if(!hooks.filesDurable||!await hooks.filesDurable({...delegation,id:delegation.run_id,companion_id:delegation.target_id}).catch(()=>false))continue;
   await checkpoint(async(tx:any)=>{await tx`UPDATE delegations SET files_saved_at=now() WHERE id=${delegation.id}`;});
  }
  if(!delegation.returned_run_id){
   const parentCanStart=await (hooks.canStartWork??ownerMayStartWork)(delegation.owner_id);
   await checkpoint(async(tx:any)=>{
    // Match retirement's owner graph lock, then lock computers before their delegation.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${delegation.owner_id},569))`;
    // Lock the parent before the target consistently with retirement.
    const [parent]=await tx`SELECT id,retired_at,archive_requested_at FROM companions WHERE owner_id=${delegation.owner_id} AND id=${delegation.parent_id} FOR UPDATE`;
    await tx`SELECT id FROM companions WHERE owner_id=${delegation.owner_id} AND id=${delegation.target_id} FOR UPDATE`;
    const [current]=await tx`SELECT * FROM delegations WHERE id=${delegation.id} FOR UPDATE`;
    if(!current||current.returned_run_id||current.finished_at)return;
    const result={status:delegation.status,text:delegation.result_text??null,error:delegation.error??null,runId:delegation.run_id,companionId:delegation.target_id};
    if(!parent||parent.retired_at||parent.archive_requested_at||!parentCanStart){await tx`UPDATE delegations SET result=${result},finished_at=now() WHERE id=${delegation.id}`;return;}
    const returned=crypto.randomUUID();
    const content='Delegated task finished. Review this result and any retained files.\n'+JSON.stringify(result);
    await tx`INSERT INTO runs(id,companion_id,client_message_id,content,lane,source) VALUES(${returned},${delegation.parent_id},${returned},${content},'background','delegation')`;
    await tx`UPDATE delegations SET result=${result},returned_run_id=${returned} WHERE id=${delegation.id}`;
    await handoffDelegationFiles(delegation.owner_id,delegation.id,returned,tx);
   });
   continue;
  }
  const [review]=await sql`SELECT status FROM runs WHERE id=${delegation.returned_run_id}`;
  if(!terminal.includes(review?.status))continue;
  await checkpoint(async(tx:any)=>{await tx`UPDATE delegations SET finished_at=now() WHERE id=${delegation.id}`;});
 }
 if(hooks.recordUsage)for(const event of await sql`SELECT * FROM machine_usage_events WHERE (${companionId}::uuid IS NULL OR companion_id=${companionId}) AND reported_at IS NULL ORDER BY occurred_at LIMIT 100`){
  try{await assertLeader();await hooks.recordUsage({id:event.id,companionId:event.companion_id,ownerId:event.owner_id,event:event.event,at:new Date(event.occurred_at)});await checkpoint(async(tx:any)=>{await tx`UPDATE machine_usage_events SET reported_at=now() WHERE id=${event.id}`;});}catch{/* Billing delivery retries independently. */}
 }
}
