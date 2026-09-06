import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from './store';
import { encrypt } from './config';
import { LifecycleConflict } from './templates';
export async function spawnChild(ownerId:string,parentId:string,parentRunId:string|null,commandId:string,input:unknown,sql:any=db){
 const value=z.object({templateId:z.string().uuid(),prompt:z.string().min(1).max(50_000)}).parse(input);
 return sql.begin(async(tx:any)=>{
  const [parent]=await tx`SELECT * FROM companions WHERE id=${parentId} AND owner_id=${ownerId} AND parent_id IS NULL AND NOT temporary AND retired_at IS NULL FOR UPDATE`;
  if(!parent)throw new LifecycleConflict('Only an available permanent parent can launch an agent.');
  const [prior]=await tx`SELECT d.target_id,d.run_id,r.content,c.template_id FROM delegations d JOIN runs r ON r.id=d.run_id JOIN companions c ON c.id=d.target_id WHERE d.id=${commandId} AND d.parent_id=${parentId}`;
  if(prior){if(prior.content!==value.prompt||prior.template_id!==value.templateId)throw new LifecycleConflict('Request identifier changed.');return {companionId:prior.target_id,runId:prior.run_id};}
  if(parentRunId&&!(await tx`SELECT id FROM runs WHERE id=${parentRunId} AND companion_id=${parentId}`).length)throw new LifecycleConflict('Parent task unavailable.');
  const [template]=await tx`SELECT t.*,p.max_children FROM agent_templates t JOIN template_permissions p ON p.template_id=t.id WHERE t.id=${value.templateId} AND t.owner_id=${ownerId} AND p.parent_id=${parentId}`;
  if(!template)throw new LifecycleConflict('Template is not authorized.');
  const [count]=await tx`SELECT count(*)::int AS count FROM companions WHERE parent_id=${parentId} AND template_id=${value.templateId} AND retired_at IS NULL`;
  if(count.count>=template.max_children)throw new LifecycleConflict('The authorized child limit has been reached.');
  const childId=crypto.randomUUID(),runId=crypto.randomUUID();
  await tx`INSERT INTO companions(id,owner_id,name,instructions,avatar,provider,create_key,agent_secret,parent_id,temporary,prepare_requested,template_id,template_revision,snapshot_name)
   VALUES(${childId},${ownerId},${template.name},${template.instructions},${template.avatar},${parent.provider},${crypto.randomUUID()},${encrypt(randomBytes(32).toString('hex'))},${parentId},true,true,${template.id},${template.revision},${template.snapshot_name})`;
  await tx`INSERT INTO runs(id,companion_id,client_message_id,content,lane,source) VALUES(${runId},${childId},${commandId},${value.prompt},'background','delegation')`;
  await tx`INSERT INTO delegations(id,parent_id,parent_run_id,target_id,run_id) VALUES(${commandId},${parentId},${parentRunId},${childId},${runId})`;
  return {companionId:childId,runId};
 });
}
export async function delegateTask(ownerId:string,parentId:string,parentRunId:string,commandId:string,input:unknown,sql:any=db){
 const value=z.object({companionId:z.string().uuid(),prompt:z.string().min(1).max(50_000)}).parse(input);
 return sql.begin(async(tx:any)=>{
  // Ordered row locks keep simultaneous A -> B and B -> A requests from deadlocking.
  const actors=await tx`SELECT id FROM companions WHERE id IN (${parentId},${value.companionId}) AND owner_id=${ownerId} AND retired_at IS NULL AND NOT temporary ORDER BY id FOR UPDATE`;
  if(parentId===value.companionId||actors.length!==2)throw new LifecycleConflict('Choose another available permanent Companion.');
  const [prior]=await tx`SELECT d.run_id,d.target_id,r.content FROM delegations d JOIN runs r ON r.id=d.run_id WHERE d.id=${commandId} AND d.parent_id=${parentId}`;
  if(prior){if(prior.target_id!==value.companionId||prior.content!==value.prompt)throw new LifecycleConflict('Request identifier changed.');return {companionId:prior.target_id,runId:prior.run_id};}
  if(!(await tx`SELECT id FROM runs WHERE id=${parentRunId} AND companion_id=${parentId}`).length)throw new LifecycleConflict('Parent task unavailable.');
  const runId=crypto.randomUUID();
  await tx`INSERT INTO runs(id,companion_id,client_message_id,content,lane,source) VALUES(${runId},${value.companionId},${commandId},${value.prompt},'background','delegation')`;
  await tx`INSERT INTO delegations(id,parent_id,parent_run_id,target_id,run_id) VALUES(${commandId},${parentId},${parentRunId},${value.companionId},${runId})`;
  return {companionId:value.companionId,runId};
 });
}
export async function delegationStatus(ownerId:string,runId:string,sql:any=db){
 const [row]=await sql`SELECT d.id,d.target_id AS "companionId",d.run_id AS "runId",r.status,r.result_text AS "resultText",r.error,d.files_saved_at AS "filesSavedAt",d.returned_run_id AS "returnedRunId" FROM delegations d JOIN companions c ON c.id=d.parent_id JOIN runs r ON r.id=d.run_id WHERE d.run_id=${runId} AND c.owner_id=${ownerId}`;
 return row??null;
}
