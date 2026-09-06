import {createHash} from 'node:crypto';
import {db} from './store';
import {agentRequest} from './machines';
import {machinePlugins} from './plugins';
import {filesForAgent,storeAgentOutput} from './files';
import {createObjectStorage} from './storage';
import {decrypt} from './config';
import {lifecycleControlHandlers,ownerMayStartWork} from './lifecycle';
import {recordUsage} from './billing';
import {stageTriggerContext} from './trigger-control';
import {applyControl} from './control';
import type {ExecutorHooks,RunExecution} from './executor';
import {answerDelegationQuestion,delegationStatus} from './delegation';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const configured=new Map<string,string>();
const controlBusy=new Set<string>();
async function owner(run:any){
 const [row]=await db`SELECT owner_id FROM companions WHERE id=${run.companion_id} AND retired_at IS NULL`;
 if(!row)throw Error('COMPANION_ACCESS_REVOKED');return row.owner_id as string;
}
async function syncConfiguration(run:any,endpoint:string,token:string,observedGeneration?:string,execution?:RunExecution){
 const request=execution?.requestAgent??agentRequest;
 const plugins=await machinePlugins(run.companion_id);const generation=hash(JSON.stringify(plugins));
 if(configured.get(endpoint)!==generation||observedGeneration!==undefined&&observedGeneration!==generation){
  await request(endpoint,token,'/configuration','PUT',{generation,plugins});configured.set(endpoint,generation);
 }
}
export const productHooks:ExecutorHooks={
 canStartWork:ownerMayStartWork,
 async canPrepareRun(run){
  if(!run.attachment_count)return true;
  const [row]=await db`SELECT count(*)::int AS count FROM attachments WHERE companion_id=${run.companion_id} AND run_id=${run.id} AND kind='user_upload'`;
  return row.count===run.attachment_count;
 },
 async prepareRun(run,endpoint,token,execution){
  const request=execution?.requestAgent??agentRequest;
  const ownerId=await owner(run);await syncConfiguration(run,endpoint,token,undefined,execution);
  await execution?.assertActive();await stageTriggerContext(run,endpoint,token,request);
  if(run.attachment_count||run.source==='delegation'){
   const files=await filesForAgent({ownerId,companionId:run.companion_id,runId:run.id});const paths:string[]=[];
   for(const file of files){
    const result=await request(endpoint,token,`/files/inbox/${run.id}/${file.attachment.position}`,'PUT',{name:file.attachment.filename,sha256:file.attachment.sha256,data:Buffer.from(file.bytes).toString('base64')});
    if(!result?.path)throw Error('FILE_STAGING_FAILED');paths.push(result.path);
   }
   if(paths.length)run.content+='\n\nAttached files in your workspace:\n'+paths.join('\n');
  }
 },
 async observeRun(run,endpoint,token,execution){
  await owner(run);
  const request=execution?.requestAgent??agentRequest;
  // The daemon outbox is shared by both lanes. A busy control reconciliation never blocks
  // the other lane's journal observation, and no concurrent poll can resolve an in-flight command.
  if(!controlBusy.has(run.companion_id)){
  controlBusy.add(run.companion_id);
  try{
  const control=await request(endpoint,token,'/control');
  if(control){
   await syncConfiguration(run,endpoint,token,control.generation,execution);
   for(const command of control.requests??[]){
    const result=await applyControl(run.companion_id,command,execution) as any;
    if(result.pendingQuestionId){
     const [question]=await db`SELECT answer FROM task_questions WHERE id=${result.pendingQuestionId} AND run_id=${command.runId}`;
     if(!question?.answer){
      const suspended=await request(endpoint,token,`/runs/${command.runId}/suspend`,'POST');
      if(suspended?.status==='needs_input'){const persist=(sql:any)=>sql`UPDATE runs SET status='needs_input' WHERE id=${command.runId} AND status='running'`;if(execution)await execution.checkpoint(persist);else await persist(db);}
      continue;
     }
     const [current]=await db`SELECT status FROM runs WHERE id=${command.runId}`;
     if(current?.status==='needs_input') {if(execution)await execution.checkpoint(tx=>requestRunResume(run.companion_id,command.runId,tx));else await requestRunResume(run.companion_id,command.runId);continue;}
     if(current?.status!=='running')continue;
     await request(endpoint,token,`/control/${command.id}/result`,'POST',{answer:question.answer});
    }else await request(endpoint,token,`/control/${command.id}/result`,'POST',result);
   }
  }
  }finally{controlBusy.delete(run.companion_id);}
  }
  await collectOutputs(run,endpoint,token,false,execution);
 },
 async beforeSettle(run,endpoint,token,execution){await collectOutputs(run,endpoint,token,false,execution);},
 lifecycle:{
  canStartWork:ownerMayStartWork,
  async recordUsage(event){await recordUsage({operationId:'box:'+event.id,ownerId:event.ownerId,companionId:event.companionId,category:'box_lifecycle',quantity:1,unit:'event',occurredAt:event.at,metadata:{event:event.event}});},
  async filesDurable(run){
   const [companion]=await db`SELECT endpoint_secret,agent_secret,desktop_taken,desktop_paused_at FROM companions WHERE id=${run.companion_id} AND retired_at IS NULL`;
   if(!companion||companion.desktop_taken||companion.desktop_paused_at)return false;
   const [task]=await db`SELECT dispatched FROM runs WHERE id=${run.id} AND companion_id=${run.companion_id}`;
   // A task cancelled before dispatch has no daemon outbox to retain.
   if(task&&!task.dispatched)return true;
   if(!companion.endpoint_secret)return false;
   const endpoint=decrypt(companion.endpoint_secret),token=decrypt(companion.agent_secret);
   const result=await agentRequest(endpoint,token,`/runs/${run.id}`);
   if(!result||!['succeeded','failed','interrupted','cancelled'].includes(result.status))return false;
   await collectOutputs(run,endpoint,token,true);
   return true;
  }
 },
};

import {registerControl} from './control';
import {listPluginAccounts,selectedPlugins,attachPlugin} from './plugins';
import {listRoutines,createRoutine,updateRoutine,deleteRoutine,routineInput,requestRunResume} from './automations';
import {z} from 'zod';
registerControl({
 routines:context=>listRoutines(context.companionId),
 routine_save:async(context,raw)=>{
  const input=z.object({id:z.string().uuid().optional()}).passthrough().parse(raw);const {id,...value}=input;
  return id?updateRoutine(context.companionId,id,routineInput.partial().parse(value)):createRoutine(context.companionId,routineInput.parse(value));
 },
 routine_delete:async(context,input)=>({deleted:await deleteRoutine(context.companionId,z.object({id:z.string().uuid()}).parse(input).id)}),
 plugins:async context=>({accounts:await listPluginAccounts(context.ownerId),selected:await selectedPlugins(context.ownerId,context.companionId)}),
 plugin_select:async(context,input)=>{const value=z.object({accountId:z.string().uuid(),enabled:z.boolean()}).parse(input);await attachPlugin(context.ownerId,context.companionId,value.accountId,value.enabled);return{ok:true};},
 task_status:async(context,input)=>{
  const {runId}=z.object({runId:z.string().uuid()}).parse(input);
  const delegated=await delegationStatus(context.ownerId,runId,db,context.companionId);
  if(delegated)return delegated;
  const [run]=await db`SELECT r.id,r.status,r.result_text AS "resultText",r.error FROM runs r JOIN companions c ON c.id=r.companion_id WHERE r.id=${runId} AND r.companion_id=${context.companionId} AND c.owner_id=${context.ownerId}`;
  return run??{error:'Task not found.'};
 },
 task_answer:async(context,input)=>{
  const value=z.object({runId:z.string().uuid(),questionId:z.string().uuid(),answer:z.string().trim().min(1).max(5000)}).parse(input);
  return answerDelegationQuestion(context.ownerId,context.companionId,value.runId,value.questionId,value.answer);
 },
});

registerControl(lifecycleControlHandlers);
/** Missing or malformed listings are not evidence that an outbox is empty. */
export async function collectOutputs(run:any,endpoint:string,token:string,verifyStored=false,execution?:RunExecution){
 const request=execution?.requestAgent??agentRequest;
 const ownerId=await owner(run);
 const outbox=z.object({files:z.array(z.object({id:z.string().uuid(),position:z.number().int().min(0).max(4),name:z.string().min(1).max(240),sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().min(1).max(10*1024*1024)})).max(5)}).parse(await request(endpoint,token,`/files/outbox?runId=${run.id}`));
 for(const file of outbox.files){
  let [saved]=await db`SELECT id,sha256,byte_size,storage_key FROM attachments WHERE companion_id=${run.companion_id} AND owner_id=${ownerId} AND run_id=${run.id} AND client_file_id=${file.id} AND kind='agent_output'`;
  if(saved&&(saved.sha256!==file.sha256||Number(saved.byte_size)!==file.size))throw Error('OUTBOX_INTEGRITY_FAILED');
  if(!saved){
   const output=await request(endpoint,token,`/files/outbox/${file.id}`);
   if(typeof output?.data!=='string')throw Error('OUTBOX_MISSING');
   const bytes=Buffer.from(output.data,'base64');
   if(bytes.length!==file.size||hash(bytes)!==file.sha256)throw Error('OUTBOX_INTEGRITY_FAILED');
   await execution?.assertActive();
   await storeAgentOutput({ownerId,companionId:run.companion_id,runId:run.id,clientFileId:file.id,position:file.position,filename:file.name,bytes});
   [saved]=await db`SELECT id,sha256,byte_size,storage_key FROM attachments WHERE companion_id=${run.companion_id} AND owner_id=${ownerId} AND run_id=${run.id} AND client_file_id=${file.id}`;
  }
  if(verifyStored){
   if(!saved)throw Error('OUTBOX_NOT_DURABLE');
   const bytes=new Uint8Array(await (await createObjectStorage().get(saved.storage_key)).arrayBuffer());
   if(bytes.length!==file.size||hash(bytes)!==file.sha256)throw Error('OUTBOX_STORAGE_INTEGRITY_FAILED');
  }
 }
}
