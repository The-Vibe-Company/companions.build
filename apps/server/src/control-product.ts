import {listTemplateRevisions,rollbackTemplate} from './templates';
import {z} from 'zod';
import {registerControl} from './control';
import {startPluginConnection,addCustomPlugin,disconnectPlugin,listPluginCatalog} from './plugins';
import {routineHistory,enqueueBackground} from './automations';
import {handleTriggers} from './triggers';
import {handleDelivery} from './delivery';
import {handleMaintenance} from './maintenance';
import {db,createCompanion} from './store';
import {config} from './config';
import {handleAutomations} from './automation-routes';
const uuid=z.string().uuid();
async function maintenanceRequest(ownerId:string,companionId:string,suffix:string,method='GET',body?:unknown){
 return (await handleMaintenance(new Request(`http://control/api/maintenance/companions/${companionId}${suffix}`,{method,...(body===undefined?{}:{body:JSON.stringify(body)})}),ownerId))!.json();
}
registerControl({
 maintenance:async context=>(await handleMaintenance(new Request('http://control/api/maintenance'),context.ownerId))!.json(),
 maintenance_inspect:async(context,raw)=>maintenanceRequest(context.ownerId,z.object({companionId:uuid}).parse(raw).companionId,''),
 maintenance_history:async(context,raw)=>maintenanceRequest(context.ownerId,z.object({companionId:uuid}).parse(raw).companionId,'/actions'),
 maintenance_prepare:async(context,raw)=>maintenanceRequest(context.ownerId,z.object({companionId:uuid}).parse(raw).companionId,'/prepare','POST'),
 maintenance_configure:async(context,raw)=>{const {companionId,configuration}=z.object({companionId:uuid,configuration:z.record(z.string(),z.unknown())}).parse(raw);return maintenanceRequest(context.ownerId,companionId,'','PATCH',configuration);},
 maintenance_task:async(context,raw)=>{const {companionId,prompt}=z.object({companionId:uuid,prompt:z.string().min(1).max(50_000)}).parse(raw);return maintenanceRequest(context.ownerId,companionId,'/tasks','POST',{clientMessageId:context.commandId,prompt});},
 template_history:async(context,raw)=>({revisions:await listTemplateRevisions(context.ownerId,z.object({templateId:uuid}).parse(raw).templateId)}),
 template_rollback:async(context,raw)=>{const {templateId,...input}=z.object({templateId:uuid,targetRevision:z.number().int().positive(),expectedRevision:z.number().int().positive()}).parse(raw);return rollbackTemplate(context.ownerId,templateId,input);},
 companion_create:async(context,raw)=>{
  if(context.isChild)return {error:'Ask your parent to create Companions.'};
  const input=z.object({name:z.string().trim().min(1).max(80),instructions:z.string().max(20_000).default('')}).parse(raw);
  return createCompanion(context.ownerId,{...input,prepare:true,provider:config.boxKey&&config.boxTemplate?'box':'local'});
 },
 plugin_catalog:async()=>({plugins:listPluginCatalog()}),
 plugin_connect:async(context,raw)=>{const input=z.object({serverId:z.string(),label:z.string().max(80).default('')}).parse(raw);return startPluginConnection(context.ownerId,input.serverId,input.label);},
 plugin_custom:async(context,raw)=>addCustomPlugin(context.ownerId,raw),
 plugin_disconnect:async(context,raw)=>{await disconnectPlugin(context.ownerId,z.object({accountId:uuid}).parse(raw).accountId);return {ok:true};},
 routine_history:async(context,raw)=>routineHistory(context.companionId,z.object({id:uuid}).parse(raw).id),
 routine_test:async(context,raw)=>{
  const {id}=z.object({id:uuid}).parse(raw);const [routine]=await db`SELECT prompt FROM routines WHERE id=${id} AND companion_id=${context.companionId}`;
  if(!routine)return {error:'Routine not found.'};
  return {runId:await enqueueBackground({companionId:context.companionId,clientMessageId:context.commandId,content:routine.prompt,source:'routine'})};
 },
 trigger_test:async(context,raw)=>{
  const {id,payload}=z.object({id:uuid,payload:z.unknown()}).parse(raw);
  return (await handleTriggers(new Request(`http://control/api/companions/${context.companionId}/triggers/${id}/test`,{method:'POST',body:JSON.stringify(payload)}),context.ownerId))!.json();
 },
 trigger_history:async(context,raw)=>{
  const {id}=z.object({id:uuid}).parse(raw);
  return (await handleTriggers(new Request(`http://control/api/companions/${context.companionId}/triggers/${id}/deliveries`),context.ownerId))!.json();
 },
 task_cancel:async(context,raw)=>{
  const {runId}=z.object({runId:uuid}).parse(raw);
  const [run]=await db`SELECT r.companion_id FROM runs r JOIN companions c ON c.id=r.companion_id WHERE r.id=${runId} AND c.owner_id=${context.ownerId}`;
  if(!run)return {error:'Task not found.'};
  return (await handleAutomations(new Request(`http://control/api/companions/${run.companion_id}/runs/${runId}/cancel`,{method:'POST'}),context.ownerId))!.json();
 },
 deliveries:async context=>(await handleDelivery(new Request('http://control/api/deliveries'),context.ownerId))!.json(),
 delivery_prepare:async(context,raw)=>{
  if(context.isChild)return {error:'Ask your parent to deliver Companions.'};
  return (await handleDelivery(new Request('http://control/api/deliveries',{method:'POST',body:JSON.stringify({...z.record(z.string(),z.unknown()).parse(raw),companionId:context.companionId,clientDeliveryId:context.commandId})}),context.ownerId))!.json();
 },
});
