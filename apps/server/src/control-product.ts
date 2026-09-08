import {listTemplateRevisions,rollbackTemplate} from './templates';
import {updateSpecialistDraft,readSpecialistDraft,proposeSpecialistNextStep} from './specialist-drafts';
import {proposeSpecialistImprovement} from './specialist-improvements';
import {BoxClient} from '../../../packages/box/client';
import {renewMachineLease} from './admission';
import {z} from 'zod';
import {registerControl} from './control';
import {startPluginConnection,addCustomPlugin,disconnectPlugin,listPluginCatalog,checkPluginAccount} from './plugins';
import {routineHistory,testRoutine} from './automations';
import {handleTriggers} from './triggers';
import {handleDelivery} from './delivery';
import {handleMaintenance} from './maintenance';
import {db,createCompanion} from './store';
import {config} from './config';
import {handleAutomations} from './automation-routes';
import {prepareTemplateSoftware,softwareRootsSchema,templateSoftwareStatus} from './software';
const uuid=z.string().uuid();
async function maintenanceRequest(ownerId:string,companionId:string,suffix:string,method='GET',body?:unknown){
 return (await handleMaintenance(new Request(`http://control/api/maintenance/companions/${companionId}${suffix}`,{method,...(body===undefined?{}:{body:JSON.stringify(body)})}),ownerId))!.json();
}
registerControl({
 specialist_next_step:async(context,raw)=>proposeSpecialistNextStep(context.ownerId,context.companionId,context.runId,context.commandId,raw),
 specialist_keep_alive:async(context,raw)=>{
  const {companionId}=z.object({companionId:z.string().uuid()}).parse(raw);
  const [child]=await db`SELECT id FROM companions WHERE id=${companionId} AND parent_id=${context.companionId} AND owner_id=${context.ownerId} AND temporary AND retired_at IS NULL`;
  return child?await renewMachineLease(context.ownerId,companionId):{error:'Intervention is not owned by this parent.'};
 },
 specialist_configure:async(context,raw)=>{
  const [source]=await db`SELECT specialist_draft_id FROM companions WHERE id=${context.companionId} AND owner_id=${context.ownerId}`;
  if(!source?.specialist_draft_id)return {error:'Open the specialist configuration conversation first.'};
  if(!raw||!Object.keys(raw as object).length)return readSpecialistDraft(context.ownerId,source.specialist_draft_id);
  return updateSpecialistDraft(context.ownerId,source.specialist_draft_id,raw);
 },
 specialist_propose_improvement:async(context,raw)=>proposeSpecialistImprovement(context.ownerId,context.companionId,context.commandId,raw),
 specialist_install:async(context,raw)=>{
  const {packages}=z.object({packages:z.array(z.string().regex(/^[a-z0-9][a-z0-9+.-]{0,100}$/)).min(1).max(20)}).parse(raw);
  const [source]=await db`SELECT box_id,provider,specialist_draft_id FROM companions WHERE id=${context.companionId} AND owner_id=${context.ownerId} AND retired_at IS NULL`;
  if(!source?.specialist_draft_id||source.provider!=='box'||!source.box_id||!config.boxKey)return {error:'System packages can be prepared only in a Box specialist draft. Use user-space tools or ask the parent to prepare an improvement.'};
  // Control command is durably claimed before this executor-only effect. An unknown result is not replayed.
  const changed=await db`UPDATE specialist_drafts SET generation=generation+1 WHERE companion_id=${context.companionId} AND status IN ('editing','error') RETURNING template_id`;
  if(!changed.length)return {error:'The draft is busy; wait before installing.'};
  const box=new BoxClient(config.boxKey);
  await box.command(source.box_id,`sudo -n timeout --kill-after=5s 80s apt-get -y install -- ${packages.join(' ')} >/dev/null 2>&1`,90);
  return {installed:packages,recipe:{packages},verified:true};
 },
 maintenance:async context=>(await handleMaintenance(new Request('http://control/api/maintenance'),context.ownerId))!.json(),
 maintenance_inspect:async(context,raw)=>maintenanceRequest(context.ownerId,z.object({companionId:uuid}).parse(raw).companionId,''),
 maintenance_history:async(context,raw)=>maintenanceRequest(context.ownerId,z.object({companionId:uuid}).parse(raw).companionId,'/actions'),
 maintenance_prepare:async(context,raw)=>maintenanceRequest(context.ownerId,z.object({companionId:uuid}).parse(raw).companionId,'/prepare','POST'),
 maintenance_configure:async(context,raw)=>{const {companionId,configuration}=z.object({companionId:uuid,configuration:z.record(z.string(),z.unknown())}).parse(raw);return maintenanceRequest(context.ownerId,companionId,'','PATCH',configuration);},
 maintenance_task:async(context,raw)=>{const {companionId,prompt}=z.object({companionId:uuid,prompt:z.string().min(1).max(50_000)}).parse(raw);return maintenanceRequest(context.ownerId,companionId,'/tasks','POST',{clientMessageId:context.commandId,prompt});},
 template_history:async(context,raw)=>({revisions:await listTemplateRevisions(context.ownerId,z.object({templateId:uuid}).parse(raw).templateId)}),
 template_rollback:async(context,raw)=>{const {templateId,...input}=z.object({templateId:uuid,targetRevision:z.number().int().positive(),expectedRevision:z.number().int().positive()}).parse(raw);return rollbackTemplate(context.ownerId,templateId,input);},
 software_prepare:async(context,raw)=>{
  if(context.isChild)return {error:'Ask your parent to prepare template software.'};
  const input=z.object({templateId:uuid,expectedRevision:z.number().int().positive()}).extend(softwareRootsSchema.shape).strict().parse(raw);
  return prepareTemplateSoftware(context.ownerId,context.commandId,input);
 },
 software_status:async(context,raw)=>{
  if(context.isChild)return {error:'Ask your parent to inspect template software.'};
  const input=z.object({templateId:uuid,buildId:uuid.optional()}).strict().parse(raw);
  return templateSoftwareStatus(context.ownerId,input.templateId,input.buildId);
 },
 companion_create:async(context,raw)=>{
  if(context.isChild)return {error:'Ask your parent to create Companions.'};
  const input=z.object({name:z.string().trim().min(1).max(80),instructions:z.string().max(20_000).optional(),templateId:uuid.optional(),templateRevision:z.number().int().positive().optional()}).parse(raw);
  return createCompanion(context.ownerId,{...input,clientCreationId:context.commandId,prepare:true,provider:config.defaultProvider});
 },
 plugin_catalog:async()=>({plugins:listPluginCatalog()}),
 plugin_connect:async(context,raw)=>{const input=z.object({serverId:z.string(),label:z.string().max(80).default('')}).parse(raw);return startPluginConnection(context.ownerId,input.serverId,input.label);},
 plugin_custom:async(context,raw)=>addCustomPlugin(context.ownerId,raw),
 plugin_check:async(context,raw)=>({account:await checkPluginAccount(context.ownerId,z.object({accountId:uuid}).parse(raw).accountId)}),
 plugin_disconnect:async(context,raw)=>{await disconnectPlugin(context.ownerId,z.object({accountId:uuid}).parse(raw).accountId);return {ok:true};},
 routine_history:async(context,raw)=>routineHistory(context.companionId,z.object({id:uuid}).parse(raw).id),
 routine_test:async(context,raw)=>{
  const {id}=z.object({id:uuid}).parse(raw);
  const runId=await testRoutine(context.companionId,id,context.commandId);
  return runId?{runId}:{error:'Routine not found.'};
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
