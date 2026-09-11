import {beforeAll,beforeEach,afterEach,expect,test} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage,listCompanions,detail} from '../src/store';
import {configureProviderMachineLimits,requestMachineAdmission,progressMachineAdmissions,machineAdmissionAllowsEffect} from '../src/admission';
import {retireCompanion} from '../src/retirement';
import {progressLifecycle,requestPreparation,type LifecycleMachines} from '../src/lifecycle';
import {acquireExecutor} from '../src/executor';
import {encrypt} from '../src/config';
import {createDiscussion,acceptDiscussionMessage,answerDiscussionQuestion} from '../src/discussions';
import {applyControl} from '../src/control';
import '../src/runtime-product';
let owner:string;
const generous={active:1000,startsPerMinute:1000,startsPerHour:10000,startsPerDay:100000};
beforeAll(()=>migrate());
beforeEach(async()=>{owner=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${owner},'Permanent companion fixture',${owner+'@example.test'},true)`;});
afterEach(async()=>{
 await configureProviderMachineLimits(generous);
 await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id IN(SELECT id FROM companions WHERE owner_id=${owner}) AND status IN('queued','preparing','running','needs_input')`;
 await db`UPDATE machine_admission_requests SET state='cancelled',released_at=now() WHERE owner_id=${owner} AND state IN('queued','admitted','cancelling')`;
 await db`UPDATE companions SET retired_at=now(),archived_at=now(),prepare_requested=false WHERE owner_id=${owner}`;
});
const companion=()=>createCompanion(owner,{name:'Permanent designer',provider:'local',prepare:false});
async function leader(){const sql=await acquireExecutor();if(!sql)throw Error('Executor unavailable');const [{pid}]=await sql`SELECT pg_backend_pid() AS pid`;return{sql,pid,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};}

test('provider admission reserves capacity before machine creation and admits waiting work after release',async()=>{
 const a=await companion(),b=await companion();
 const [baseline]=await db`SELECT count(*)::int AS n FROM companions WHERE retired_at IS NULL AND archived_at IS NULL AND (endpoint_secret IS NOT NULL OR box_id IS NOT NULL OR create_started_at IS NOT NULL)`;
 await configureProviderMachineLimits({...generous,active:baseline.n+1});
 const inputs=[a,b].map(c=>({requestId:crypto.randomUUID(),companionId:c.id,kind:'configuration' as const}));
 const results=await Promise.all(inputs.map(input=>requestMachineAdmission(owner,input)));
 expect(results.filter(r=>r.state==='admitted')).toHaveLength(1);expect(results.filter(r=>r.state==='queued')).toHaveLength(1);
 const admitted=results.find(r=>r.state==='admitted')!,queued=results.find(r=>r.state==='queued')!;
 expect(await machineAdmissionAllowsEffect(queued.companionId)).toBe(false);
 expect(await requestMachineAdmission(owner,inputs.find(i=>i.companionId===admitted.companionId)!)).toEqual(admitted);
 await expect(requestMachineAdmission(owner,{...inputs.find(i=>i.companionId===admitted.companionId)!,kind:'resume'})).rejects.toThrow('changed');
 await db`UPDATE machine_admission_requests SET state='completed',released_at=now() WHERE id=${admitted.id}`;
 await db`UPDATE companions SET retired_at=now(),prepare_requested=false WHERE id=${admitted.companionId}`;
 await progressMachineAdmissions();
 expect((await db`SELECT state FROM machine_admission_requests WHERE id=${queued.id}`)[0].state).toBe('admitted');
 expect(await machineAdmissionAllowsEffect(queued.companionId)).toBe(true);
});

test('an admitted archived resume reserves one provider slot before the ready checkpoint',async()=>{
 const a=await companion(),b=await companion(),fresh=await companion();
 for(const c of [a,b])await db`UPDATE companions SET provider='box',box_id=${'archived-'+c.id},archived_at=now(),create_started_at=now(),status='archived' WHERE id=${c.id}`;
 const [baseline]=await db`SELECT count(*)::int AS n FROM companions WHERE retired_at IS NULL AND archived_at IS NULL AND (endpoint_secret IS NOT NULL OR box_id IS NOT NULL OR create_started_at IS NOT NULL)`;
 await configureProviderMachineLimits({...generous,active:baseline.n+1});
 const first=await requestMachineAdmission(owner,{requestId:crypto.randomUUID(),companionId:a.id,kind:'resume'});
 expect(first.state).toBe('admitted');
 expect((await db`SELECT archived_at FROM companions WHERE id=${a.id}`)[0].archived_at).not.toBeNull();
 const waiting=await Promise.all([requestMachineAdmission(owner,{requestId:crypto.randomUUID(),companionId:b.id,kind:'resume'}),requestMachineAdmission(owner,{requestId:crypto.randomUUID(),companionId:fresh.id,kind:'configuration'})]);
 expect(waiting.map(r=>[r.state,r.waitingReason])).toEqual([['queued','provider_active_limit'],['queued','provider_active_limit']]);
 await db`UPDATE companions SET archived_at=null,status='ready' WHERE id=${a.id}`;
 await progressMachineAdmissions();
 expect(await db`SELECT id FROM machine_admission_requests WHERE owner_id=${owner} AND state='admitted'`).toHaveLength(1);
 await db`UPDATE machine_admission_requests SET state='completed',released_at=now() WHERE id=${first.id}`;
 await db`UPDATE companions SET archived_at=now(),status='archived',prepare_requested=false WHERE id=${a.id}`;
 await progressMachineAdmissions();
 expect(await db`SELECT id FROM machine_admission_requests WHERE owner_id=${owner} AND state='admitted'`).toHaveLength(1);
 expect(await db`SELECT id FROM machine_admission_requests WHERE owner_id=${owner} AND state='queued'`).toHaveLength(1);
});

test('retirement preserves history and another companion, and requires observed archive before settling dispatched work',async()=>{
 const a=await companion(),b=await companion(),run=await acceptMessage(owner,a.id,crypto.randomUUID(),'Keep my history');
 await db`UPDATE companions SET provider='box',box_id=${'fixture-'+a.id},create_started_at=now(),status='ready',endpoint_secret=${encrypt('http://fixture.invalid')} WHERE id=${a.id}`;
 await db`UPDATE runs SET status='running',dispatched=true WHERE id=${run}`;
 expect(await retireCompanion('another-owner',a.id)).toBeNull();
 await retireCompanion(owner,a.id);const [intent]=await db`SELECT retired_at,archive_requested_at FROM companions WHERE id=${a.id}`;
 await retireCompanion(owner,a.id);expect((await db`SELECT retired_at,archive_requested_at FROM companions WHERE id=${a.id}`)[0]).toEqual(intent);
 expect((await listCompanions(owner)).map((c:any)=>c.id)).toEqual([b.id]);
 expect((await detail(owner,a.id))?.messages).toHaveLength(1);expect(await requestPreparation(owner,a.id)).toBeNull();
 let confirmed=false,calls=0;
 const machine:LifecycleMachines={async snapshot(){throw Error('Unexpected snapshot');},async snapshotStatus(){throw Error('Unexpected snapshot status');},async prepare(){throw Error('Unexpected preparation');},async health(){throw Error('Unexpected health');},async pause(){throw Error('Unexpected GUI change');},async archive(c,guard){await guard?.();expect(c.id).toBe(a.id);calls++;return confirmed;}};
 const l=await leader();try{
  await progressLifecycle(l.sql,{},machine,{companionId:a.id,leaderPid:l.pid});
  expect((await db`SELECT status,cancel_requested FROM runs WHERE id=${run}`)[0]).toMatchObject({status:'running',cancel_requested:true});
  confirmed=true;await progressLifecycle(l.sql,{},machine,{companionId:a.id,leaderPid:l.pid});
  expect((await db`SELECT status FROM runs WHERE id=${run}`)[0].status).toBe('cancelled');
  expect((await db`SELECT status,box_id,endpoint_secret FROM companions WHERE id=${a.id}`)[0]).toMatchObject({status:'archived',box_id:'fixture-'+a.id,endpoint_secret:null});
  await progressLifecycle(l.sql,{},machine,{companionId:a.id,leaderPid:l.pid});expect(calls).toBe(2);
  expect(await db`SELECT id FROM machine_usage_events WHERE companion_id=${a.id} AND event='archived'`).toHaveLength(1);
  expect((await db`SELECT retired_at FROM companions WHERE id=${b.id}`)[0].retired_at).toBeNull();
 }finally{await l.close();}
});

test('unknown machine creation remains unresolved on retirement without issuing another provider effect',async()=>{
 const c=await companion();await db`UPDATE companions SET provider='box',create_started_at=now() WHERE id=${c.id}`;await retireCompanion(owner,c.id);
 let effects=0;const machine:LifecycleMachines={async snapshot(){throw Error('Unexpected snapshot');},async snapshotStatus(){throw Error('Unexpected snapshot status');},async prepare(){effects++;return null;},async health(){effects++;return{};},async pause(){effects++;},async archive(){effects++;return true;}};
 const l=await leader();try{await progressLifecycle(l.sql,{},machine,{companionId:c.id,leaderPid:l.pid});
  expect(effects).toBe(0);expect((await db`SELECT archived_at,error FROM companions WHERE id=${c.id}`)[0]).toMatchObject({archived_at:null,error:expect.stringContaining('reconciled')});
 }finally{await l.close();}
});

test('a companion question and its answer are idempotent and scoped to its discussion',async()=>{
 const c=await companion(),d=await createDiscussion(owner,{clientCreationId:crypto.randomUUID()}),other=await createDiscussion(owner,{clientCreationId:crypto.randomUUID()});
 const run=await acceptDiscussionMessage(owner,d.id,{clientMessageId:crypto.randomUUID(),content:'Ask',targetCompanionId:c.id});
 await db`UPDATE runs SET status='running',dispatched=true WHERE id=${run.runId}`;
 const command={id:crypto.randomUUID(),runId:run.runId,operation:'ask_user',input:{question:'Which project?',options:['A','B']}};
 expect(await applyControl(c.id,command)).toEqual({pendingQuestionId:command.id});expect(await applyControl(c.id,command)).toEqual({pendingQuestionId:command.id});
 await expect(answerDiscussionQuestion(owner,other.id,command.id,'B')).rejects.toThrow();
 await expect(answerDiscussionQuestion('other-owner',d.id,command.id,'B')).rejects.toThrow();
 expect((await db`SELECT answer FROM task_questions WHERE id=${command.id}`)[0].answer).toBeNull();
 await answerDiscussionQuestion(owner,d.id,command.id,'A');await answerDiscussionQuestion(owner,d.id,command.id,'A');
 await expect(answerDiscussionQuestion(owner,d.id,command.id,'B')).rejects.toThrow('already');
 expect((await db`SELECT resume_requested_at FROM runs WHERE id=${run.runId}`)[0].resume_requested_at).not.toBeNull();
});

test('companion task controls cannot inspect or cancel work in another discussion',async()=>{
 const c=await companion(),a=await createDiscussion(owner,{clientCreationId:crypto.randomUUID()}),b=await createDiscussion(owner,{clientCreationId:crypto.randomUUID()});
 const first=await acceptDiscussionMessage(owner,a.id,{clientMessageId:crypto.randomUUID(),content:'Current work',targetCompanionId:c.id});
 const second=await acceptDiscussionMessage(owner,b.id,{clientMessageId:crypto.randomUUID(),content:'Private other discussion',targetCompanionId:c.id});
 await db`UPDATE runs SET status='running',dispatched=true WHERE id IN(${first.runId},${second.runId})`;
 const invoke=(operation:string,input:unknown)=>applyControl(c.id,{id:crypto.randomUUID(),runId:first.runId,operation,input});
 expect(await invoke('task_status',{runId:second.runId})).toHaveProperty('error');
 expect(await invoke('task_cancel',{runId:second.runId})).toHaveProperty('error');
 expect((await db`SELECT cancel_requested FROM runs WHERE id=${second.runId}`)[0].cancel_requested).toBe(false);
 expect(await invoke('task_status',{runId:first.runId})).toMatchObject({id:first.runId,status:'running'});
});
