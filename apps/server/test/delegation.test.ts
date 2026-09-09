import {beforeAll,expect,test} from 'bun:test';
import {acceptMessage,createCompanion,db,migrate} from '../src/store';
import {answerDelegationQuestion,delegateTask,delegationStatus} from '../src/delegation';
import {LifecycleConflict} from '../src/templates';
import {controlHandlers,type ControlContext} from '../src/control';
import '../src/runtime-product';

const owner='00000000-0000-4000-8000-000000000001';
beforeAll(async()=>{await migrate();});
async function companion(name:string){return createCompanion(owner,{name,instructions:'',provider:'local',prepare:false});}
async function parentRun(companionId:string){return (await acceptMessage(owner,companionId,crypto.randomUUID(),'Coordinate delegated work'))!;}

test('active directed delegations reject multi-Companion and concurrent circular waits',async()=>{
 const a=await companion('Cycle A'),b=await companion('Cycle B'),c=await companion('Cycle C');
 const aRun=await parentRun(a.id),bRun=await parentRun(b.id),cRun=await parentRun(c.id);
 await delegateTask(owner,a.id,aRun,crypto.randomUUID(),{companionId:b.id,prompt:'A to B'});
 await delegateTask(owner,b.id,bRun,crypto.randomUUID(),{companionId:c.id,prompt:'B to C'});
 await expect(delegateTask(owner,c.id,cRun,crypto.randomUUID(),{companionId:a.id,prompt:'C to A'})).rejects.toThrow('circular wait');
 expect(Number((await db`SELECT count(*)::int AS count FROM delegations WHERE parent_id IN (${a.id},${b.id},${c.id})`)[0].count)).toBe(2);

 const x=await companion('Concurrent X'),y=await companion('Concurrent Y'),xRun=await parentRun(x.id),yRun=await parentRun(y.id);
 const attempts=await Promise.allSettled([
  delegateTask(owner,x.id,xRun,crypto.randomUUID(),{companionId:y.id,prompt:'X to Y'}),
  delegateTask(owner,y.id,yRun,crypto.randomUUID(),{companionId:x.id,prompt:'Y to X'}),
 ]);
 expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 expect(attempts.filter(result=>result.status==='rejected')).toHaveLength(1);
});

test('a later active parent run can inspect and answer only its correlated child question',async()=>{
 const parent=await companion('Question parent'),target=await companion('Question target'),unrelated=await companion('Unrelated'),other=crypto.randomUUID();
 await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${other},'Other owner',${other+'@example.test'},true)`;
 const parentTask=await parentRun(parent.id),unrelatedTask=await parentRun(unrelated.id);
 const delegated=await delegateTask(owner,parent.id,parentTask,crypto.randomUUID(),{companionId:target.id,prompt:'Ask if unclear'});
 await db`UPDATE runs SET status='needs_input' WHERE id=${delegated.runId}`;
 const questionId=crypto.randomUUID(),foreignQuestion=crypto.randomUUID();
 await db`INSERT INTO task_questions(id,companion_id,run_id,question,options) VALUES(${questionId},${target.id},${delegated.runId},'Which color?',${['Blue','Green']})`;
 const otherRun=await parentRun(target.id);await db`INSERT INTO task_questions(id,companion_id,run_id,question,options) VALUES(${foreignQuestion},${target.id},${otherRun},'Unrelated?',${[]})`;

 await db`UPDATE runs SET status='succeeded' WHERE id=${parentTask}`;
 const laterParentTask=await parentRun(parent.id);
 await db`UPDATE runs SET status='running' WHERE id=${laterParentTask}`;
 const context:ControlContext={ownerId:owner,companionId:parent.id,runId:laterParentTask,commandId:crypto.randomUUID(),isChild:false};
 expect(await controlHandlers.task_status!(context,{runId:delegated.runId})).toMatchObject({status:'needs_input',pendingQuestion:{id:questionId,companionId:target.id,question:'Which color?',options:['Blue','Green']}});
 expect(await delegationStatus(owner,delegated.runId,db,parent.id)).toMatchObject({status:'needs_input',pendingQuestion:{id:questionId}});
 expect(await delegationStatus(owner,delegated.runId,db,unrelated.id)).toBeNull();
 expect(await delegationStatus(other,delegated.runId)).toBeNull();
 expect(await controlHandlers.task_status!(context,{runId:unrelatedTask})).toEqual({error:'Task not found.'});
 await expect(answerDelegationQuestion(other,parent.id,delegated.runId,questionId,'Blue')).rejects.toBeInstanceOf(LifecycleConflict);
 await expect(answerDelegationQuestion(owner,unrelated.id,delegated.runId,questionId,'Blue')).rejects.toBeInstanceOf(LifecycleConflict);
 await expect(answerDelegationQuestion(owner,parent.id,delegated.runId,foreignQuestion,'Blue')).rejects.toBeInstanceOf(LifecycleConflict);
 expect(await controlHandlers.task_answer!(context,{runId:delegated.runId,questionId,answer:'Blue'})).toEqual({ok:true});
 expect(await answerDelegationQuestion(owner,parent.id,delegated.runId,questionId,'Blue')).toEqual({ok:true});
 await expect(answerDelegationQuestion(owner,parent.id,delegated.runId,questionId,'Green')).rejects.toThrow('already has an answer');
 expect((await db`SELECT answer,resume_requested_at FROM task_questions q JOIN runs r ON r.id=q.run_id WHERE q.id=${questionId}`)[0]).toMatchObject({answer:'Blue'});
 expect((await db`SELECT resume_requested_at FROM runs WHERE id=${delegated.runId}`)[0].resume_requested_at).not.toBeNull();
});

test('parent agents cannot answer a destructive App confirmation for a delegated task',async()=>{
 const parent=await companion('Approval parent'),target=await companion('Approval target');
 const run=await parentRun(parent.id),delegated=await delegateTask(owner,parent.id,run,crypto.randomUUID(),{companionId:target.id,prompt:'Operate project'});
 await db`UPDATE runs SET status='needs_input' WHERE id=${delegated.runId}`;
 const questionId=crypto.randomUUID();
 await db`INSERT INTO control_commands(id,companion_id,run_id,operation) VALUES(${questionId},${target.id},${delegated.runId},'app_tool_confirm')`;
 await db`INSERT INTO task_questions(id,companion_id,run_id,question,options) VALUES(${questionId},${target.id},${delegated.runId},'Approve redeploy?',${['Approve this call','Decline']})`;
 await expect(answerDelegationQuestion(owner,parent.id,delegated.runId,questionId,'Approve this call')).rejects.toThrow('human answer');
 expect((await db`SELECT answer FROM task_questions WHERE id=${questionId}`)[0].answer).toBeNull();
});
