import {createHash} from 'node:crypto';
import {db} from './store';
import {agentRequest} from './machines';
import {machinePlugins} from './plugins';
import {filesForAgent,storeAgentOutput} from './files';
import {applyControl} from './control';
import type {ExecutorHooks} from './executor';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const configured=new Map<string,string>();
async function owner(run:any){
 const [row]=await db`SELECT owner_id FROM companions WHERE id=${run.companion_id} AND retired_at IS NULL`;
 if(!row)throw Error('COMPANION_ACCESS_REVOKED');return row.owner_id as string;
}
async function syncConfiguration(run:any,endpoint:string,token:string,observedGeneration?:string){
 const plugins=await machinePlugins(run.companion_id);const generation=hash(JSON.stringify(plugins));
 if(configured.get(endpoint)!==generation||observedGeneration!==undefined&&observedGeneration!==generation){
  await agentRequest(endpoint,token,'/configuration','PUT',{generation,plugins});configured.set(endpoint,generation);
 }
}
export const productHooks:ExecutorHooks={
 async canPrepareRun(run){
  if(!run.attachment_count)return true;
  const [row]=await db`SELECT count(*)::int AS count FROM attachments WHERE companion_id=${run.companion_id} AND run_id=${run.id} AND kind='user_upload'`;
  return row.count===run.attachment_count;
 },
 async prepareRun(run,endpoint,token){
  const ownerId=await owner(run);await syncConfiguration(run,endpoint,token);
  if(run.attachment_count){
   const files=await filesForAgent({ownerId,companionId:run.companion_id,runId:run.id});const paths:string[]=[];
   for(const file of files){
    const result=await agentRequest(endpoint,token,`/files/inbox/${run.id}/${file.attachment.position}`,'PUT',{name:file.attachment.filename,sha256:file.attachment.sha256,data:Buffer.from(file.bytes).toString('base64')});
    if(!result?.path)throw Error('FILE_STAGING_FAILED');paths.push(result.path);
   }
   run.content+='\n\nAttached files in your workspace:\n'+paths.join('\n');
  }
 },
 async observeRun(run,endpoint,token){
  const ownerId=await owner(run);
  const control=await agentRequest(endpoint,token,'/control');
  if(control){
   await syncConfiguration(run,endpoint,token,control.generation);
   for(const command of control.requests??[]){
    const result=await applyControl(run.companion_id,command) as any;
    if(result.pendingQuestionId){
     const [question]=await db`SELECT answer FROM task_questions WHERE id=${result.pendingQuestionId} AND run_id=${command.runId}`;
     if(!question?.answer){
      const suspended=await agentRequest(endpoint,token,`/runs/${command.runId}/suspend`,'POST');
      if(suspended?.status==='needs_input')await db`UPDATE runs SET status='needs_input' WHERE id=${command.runId} AND status='running'`;
      continue;
     }
     const [current]=await db`SELECT status FROM runs WHERE id=${command.runId}`;
     if(current?.status!=='running')continue;
     await agentRequest(endpoint,token,`/control/${command.id}/result`,'POST',{answer:question.answer});
    }else await agentRequest(endpoint,token,`/control/${command.id}/result`,'POST',result);
   }
  }
  const outbox=await agentRequest(endpoint,token,`/files/outbox?runId=${run.id}`);
  for(const file of outbox?.files??[]){
   const [saved]=await db`SELECT id FROM attachments WHERE run_id=${run.id} AND client_file_id=${file.id}`;
   if(saved)continue;
   const output=await agentRequest(endpoint,token,`/files/outbox/${file.id}`);const bytes=Buffer.from(output.data,'base64');
   if(hash(bytes)!==file.sha256)throw Error('OUTBOX_INTEGRITY_FAILED');
   await storeAgentOutput({ownerId,companionId:run.companion_id,runId:run.id,clientFileId:file.id,position:file.position,filename:file.name,bytes});
  }
 },
};

import {registerControl} from './control';
import {listPluginAccounts,selectedPlugins,attachPlugin} from './plugins';
import {listRoutines,createRoutine,updateRoutine,deleteRoutine,routineInput,enqueueBackground} from './automations';
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
 delegate:async(context,input)=>{
  const value=z.object({companionId:z.string().uuid(),prompt:z.string().min(1).max(50_000)}).parse(input);
  const [target]=await db`SELECT id FROM companions WHERE id=${value.companionId} AND owner_id=${context.ownerId} AND retired_at IS NULL AND id<>${context.companionId}`;
  if(!target)return{error:'Choose another available Companion.'};
  const runId=await enqueueBackground({companionId:target.id,clientMessageId:context.commandId,content:value.prompt,source:'delegation'});
  return{runId,companionId:target.id};
 },
 task_status:async(context,input)=>{
  const {runId}=z.object({runId:z.string().uuid()}).parse(input);
  const [run]=await db`SELECT r.id,r.status,r.result_text AS "resultText",r.error FROM runs r JOIN companions c ON c.id=r.companion_id WHERE r.id=${runId} AND c.owner_id=${context.ownerId}`;
  return run??{error:'Task not found.'};
 },
});
