import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from './store';
import { encrypt } from './config';
import { LifecycleConflict } from './templates';
import { requestRunResume } from './automations';
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
  await tx`INSERT INTO companions(id,owner_id,name,instructions,avatar,model_id,provider,create_key,agent_secret,parent_id,temporary,prepare_requested,template_id,template_revision,snapshot_name)
   VALUES(${childId},${ownerId},${template.name},${template.instructions},${template.avatar},${template.model_id},${parent.provider},${crypto.randomUUID()},${encrypt(randomBytes(32).toString('hex'))},${parentId},true,true,${template.id},${template.revision},${template.snapshot_name})`;
  await tx`INSERT INTO runs(id,companion_id,client_message_id,content,lane,source) VALUES(${runId},${childId},${commandId},${value.prompt},'background','delegation')`;
  await tx`INSERT INTO delegations(id,parent_id,parent_run_id,target_id,run_id) VALUES(${commandId},${parentId},${parentRunId},${childId},${runId})`;
  return {companionId:childId,runId};
 });
}
export async function delegateTask(ownerId:string,parentId:string,parentRunId:string,commandId:string,input:unknown,sql:any=db){
 const value=z.object({companionId:z.string().uuid(),prompt:z.string().min(1).max(50_000)}).parse(input);
 return sql.begin(async(tx:any)=>{
  // One owner-scoped graph mutation at a time makes the reachability check race-free.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId},569))`;
  // Ordered row locks keep simultaneous A -> B and B -> A requests from deadlocking.
  const actors=await tx`SELECT id FROM companions WHERE id IN (${parentId},${value.companionId}) AND owner_id=${ownerId} AND retired_at IS NULL AND NOT temporary ORDER BY id FOR UPDATE`;
  if(parentId===value.companionId||actors.length!==2)throw new LifecycleConflict('Choose another available permanent Companion.');
  const [prior]=await tx`SELECT d.run_id,d.target_id,r.content FROM delegations d JOIN runs r ON r.id=d.run_id WHERE d.id=${commandId} AND d.parent_id=${parentId}`;
  if(prior){if(prior.target_id!==value.companionId||prior.content!==value.prompt)throw new LifecycleConflict('Request identifier changed.');return {companionId:prior.target_id,runId:prior.run_id};}
  if(!(await tx`SELECT id FROM runs WHERE id=${parentRunId} AND companion_id=${parentId}`).length)throw new LifecycleConflict('Parent task unavailable.');
  const [cycle]=await tx`WITH RECURSIVE reachable(id) AS (
   SELECT d.target_id FROM delegations d JOIN runs active ON active.id=d.run_id WHERE d.parent_id=${value.companionId} AND d.finished_at IS NULL AND active.status IN ('queued','preparing','running','needs_input')
   UNION
   SELECT d.target_id FROM delegations d JOIN runs active ON active.id=d.run_id JOIN reachable r ON d.parent_id=r.id WHERE d.finished_at IS NULL AND active.status IN ('queued','preparing','running','needs_input')
  ) SELECT id FROM reachable WHERE id=${parentId} LIMIT 1`;
  if(cycle)throw new LifecycleConflict('Delegation would create a circular wait.');
  const runId=crypto.randomUUID();
  await tx`INSERT INTO runs(id,companion_id,client_message_id,content,lane,source) VALUES(${runId},${value.companionId},${commandId},${value.prompt},'background','delegation')`;
  await tx`INSERT INTO delegations(id,parent_id,parent_run_id,target_id,run_id) VALUES(${commandId},${parentId},${parentRunId},${value.companionId},${runId})`;
  return {companionId:value.companionId,runId};
 });
}
export async function delegationStatus(ownerId:string,runId:string,sql:any=db,parentId?:string){
 const [row]=await sql`SELECT d.id,d.target_id AS "companionId",d.run_id AS "runId",r.status,r.result_text AS "resultText",r.error,d.files_saved_at AS "filesSavedAt",d.returned_run_id AS "returnedRunId",
  q.id AS "questionId",q.question,q.options
  FROM delegations d JOIN companions c ON c.id=d.parent_id JOIN companions target ON target.id=d.target_id AND target.owner_id=c.owner_id JOIN runs r ON r.id=d.run_id AND r.companion_id=target.id
  LEFT JOIN LATERAL(SELECT id,question,options FROM task_questions WHERE companion_id=d.target_id AND run_id=d.run_id AND answer IS NULL ORDER BY created_at,id LIMIT 1)q ON true
  WHERE d.run_id=${runId} AND c.owner_id=${ownerId} AND c.parent_id IS NULL AND NOT c.temporary AND c.retired_at IS NULL
   AND (${parentId??null}::uuid IS NULL OR d.parent_id=${parentId??null})`;
 if(!row)return null;
 const {questionId,question,options,...status}=row;
 return {...status,pendingQuestion:questionId?{id:questionId,companionId:row.companionId,question,options}:null};
}
export async function answerDelegationQuestion(ownerId:string,parentId:string,runId:string,questionId:string,answer:string,sql:any=db){
 return sql.begin(async(tx:any)=>{
  const [row]=await tx`SELECT q.answer,d.target_id,r.status FROM delegations d
   JOIN companions parent ON parent.id=d.parent_id AND parent.owner_id=${ownerId} AND parent.retired_at IS NULL
   JOIN companions target ON target.id=d.target_id AND target.owner_id=parent.owner_id AND target.retired_at IS NULL
   JOIN runs r ON r.id=d.run_id AND r.companion_id=d.target_id
   JOIN task_questions q ON q.id=${questionId} AND q.run_id=d.run_id AND q.companion_id=d.target_id
   WHERE d.parent_id=${parentId} AND parent.parent_id IS NULL AND NOT parent.temporary
    AND d.run_id=${runId} AND d.finished_at IS NULL FOR UPDATE OF q`;
  if(!row)throw new LifecycleConflict('Delegated question unavailable.');
  if(row.answer){if(row.answer!==answer)throw new LifecycleConflict('This question already has an answer.');return {ok:true};}
  if(!['running','needs_input'].includes(row.status))throw new LifecycleConflict('This delegated task is no longer waiting.');
  await tx`UPDATE task_questions SET answer=${answer},answered_at=now() WHERE id=${questionId}`;
  await requestRunResume(row.target_id,runId,tx);return {ok:true};
 });
}
