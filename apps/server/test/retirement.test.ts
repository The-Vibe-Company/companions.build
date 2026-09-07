import {beforeAll,afterEach,test,expect} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage,detail,listCompanions} from '../src/store';
import {retireCompanion} from '../src/retirement';
import {progressLifecycle,type LifecycleMachines,requestPreparation} from '../src/lifecycle';
import {acquireExecutor,LifecycleCoordinator} from '../src/executor';
import {archiveMachine,ExecutionStopped} from '../src/machines';
import {encrypt} from '../src/config';
import {saveTemplate} from '../src/templates';
import {delegateTask} from '../src/delegation';
import {handler} from '../src/api';
import {setMagicLinkDeliveryForTests} from '../src/auth';
import {createRoutine,testRoutine} from '../src/automations';
import {handleTriggers,handleWebhook} from '../src/triggers';
const owner='00000000-0000-4000-8000-000000000001';
const owned:string[]=[];
beforeAll(async()=>{await migrate();});
afterEach(async()=>{
 for(const id of owned.splice(0)){
  await db`UPDATE companions SET retired_at=now(),archive_requested_at=now(),archived_at=now(),prepare_requested=false WHERE id=${id}`;
  await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id} AND status IN ('queued','preparing','running','needs_input')`;
  await db`UPDATE template_candidates SET status='failed' WHERE source_companion_id=${id} AND status IN ('queued','capturing','ready')`;
 }
});
async function fixture(ownerId=owner){const c=await createCompanion(ownerId,{name:'Removal fixture',provider:'box',prepare:false});owned.push(c.id);return c.id as string;}
async function prepared(id:string){await db`UPDATE companions SET box_id=${'test-'+id},create_started_at=now(),status='ready',endpoint_secret=${encrypt('http://fixture.invalid')},ready_at=now() WHERE id=${id}`;}
function fake(){
 const calls:string[]=[];let archived=false,snapshot:'missing'|'pending'|'ready'|'failed'='ready';
 const machine:LifecycleMachines={
  async prepare(){throw Error('Unexpected prepare');},async health(){throw Error('Unexpected health');},async pause(){throw Error('Unexpected desktop change');},async snapshot(){throw Error('Unexpected snapshot POST');},
  async snapshotStatus(){calls.push('snapshot GET');return snapshot;},
  async archive(c,guard){await guard?.();calls.push('archive '+c.id);return archived;},
 };
 return {machine,calls,setArchived(value:boolean){archived=value;},setSnapshot(value:typeof snapshot){snapshot=value;}};
}
async function leader(){const sql=await acquireExecutor();if(!sql)throw Error('Missing executor');const [{pid}]=await sql`SELECT pg_backend_pid() AS pid`;return {sql,pid,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};}
async function signIn(){
 let link='';setMagicLinkDeliveryForTests(message=>{link=message.url;});
 const response=await handler(new Request('http://127.0.0.1:4310/api/auth/sign-in/magic-link',{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:4310'},body:JSON.stringify({email:`remove-${crypto.randomUUID()}@example.test`,callbackURL:'/'})}));
 expect(response.status).toBe(200);const verified=await handler(new Request(link,{redirect:'manual'}));
 const cookie=verified.headers.get('set-cookie')!.split(';')[0];const me=await handler(new Request('http://127.0.0.1:4310/api/me',{headers:{cookie}}));return {cookie,id:(await me.json() as any).user.id};
}

test('DELETE is authenticated, owner-scoped and idempotent; owned children retire but profiles and delivered copies survive',async()=>{
 const alice=await signIn(),bob=await signIn();const parent=await fixture(alice.id),child=await fixture(alice.id),delivered=await fixture(bob.id);
 await db`UPDATE companions SET parent_id=${parent},temporary=true WHERE id IN (${child},${delivered})`;
 const run=await acceptMessage(alice.id,parent,crypto.randomUUID(),'Keep this history');
 const template=await saveTemplate(alice.id,{name:'Saved profile',instructions:'Keep these instructions'});
 await db`UPDATE agent_templates SET source_companion_id=${parent} WHERE id=${template.id}`;
 const delivery=crypto.randomUUID();await db`INSERT INTO companion_deliveries(id,source_owner_id,source_companion_id,recipient_email,profile_snapshot,expires_at,client_delivery_id,request_fingerprint,status,accepted_by,delivered_companion_id)
 VALUES(${delivery},${alice.id},${parent},'delivered@example.test',${{name:'Delivered profile'}},now()+interval '1 day',${crypto.randomUUID()},${'a'.repeat(64)},'accepted',${bob.id},${delivered})`;
 await createRoutine(parent,{name:'Schedule',prompt:'Work',cron:'0 9 * * *',timezone:'UTC',enabled:true});
 const created=await handleTriggers(new Request(`http://control/api/companions/${parent}/triggers`,{method:'POST',body:JSON.stringify({name:'Hook',prompt:'Work',source:'generic',mode:'direct'})}),alice.id);
 const trigger=await created!.json() as any;
 const url=`http://127.0.0.1:4310/api/companions/${parent}`;
 expect((await handler(new Request(url,{method:'DELETE'}))).status).toBe(401);
 expect((await handler(new Request(url,{method:'DELETE',headers:{cookie:bob.cookie}}))).status).toBe(404);
 const remove=()=>handler(new Request(url,{method:'DELETE',headers:{cookie:alice.cookie}}));
 const result=await remove();expect(result.status).toBe(202);expect(await result.json()).toEqual({deleted:true,companionIds:[parent,child]});
 const [before]=await db`SELECT retired_at,archive_requested_at FROM companions WHERE id=${parent}`;
 expect((await remove()).status).toBe(202);expect((await db`SELECT retired_at,archive_requested_at FROM companions WHERE id=${parent}`)[0]).toEqual(before);
 expect((await listCompanions(alice.id)).some((c:any)=>c.id===parent)).toBe(false);
 expect((await detail(alice.id,parent))?.messages).toHaveLength(1);
 expect(await acceptMessage(alice.id,parent,crypto.randomUUID(),'Rejected')).toBeNull();
 expect(await requestPreparation(alice.id,parent)).toBeNull();
 expect((await handler(new Request(url+'/messages',{method:'POST',headers:{cookie:alice.cookie,'content-type':'application/json'},body:JSON.stringify({clientMessageId:crypto.randomUUID(),content:'Rejected'})}))).status).toBe(404);
 expect((await db`SELECT status FROM runs WHERE id=${run}`)[0].status).toBe('cancelled');
 expect((await db`SELECT retired_at FROM companions WHERE id=${delivered}`)[0].retired_at).toBeNull();
 expect((await db`SELECT instructions,source_companion_id FROM agent_templates WHERE id=${template.id}`)[0]).toMatchObject({instructions:'Keep these instructions',source_companion_id:parent});
 expect((await db`SELECT status,delivered_companion_id FROM companion_deliveries WHERE id=${delivery}`)[0]).toMatchObject({status:'accepted',delivered_companion_id:delivered});
 expect((await db`SELECT enabled,next_fire_at FROM routines WHERE companion_id=${parent}`)[0]).toMatchObject({enabled:false,next_fire_at:null});
 expect((await handleWebhook(new Request(`http://control/api/webhooks/${trigger.trigger.id}`,{method:'POST',headers:{authorization:`Bearer ${trigger.secret}`},body:'{}'})))?.status).toBe(404);
});

test('retired active and parked runs become terminal only after guarded archive confirmation, including desktop takeover',async()=>{
 const id=await fixture();await prepared(id);const main=await acceptMessage(owner,id,crypto.randomUUID(),'Main'),background=await acceptMessage(owner,id,crypto.randomUUID(),'Background');
 await db`UPDATE runs SET status='running',dispatched=true WHERE id=${main}`;
 await db`UPDATE runs SET lane='background',status='needs_input',dispatched=true WHERE id=${background}`;
 await db`UPDATE companions SET desktop_taken=true,desktop_paused_at=now() WHERE id=${id}`;
 await retireCompanion(owner,id);const f=fake(),l=await leader();
 try{
  await progressLifecycle(l.sql,{},f.machine,{companionId:id,leaderPid:l.pid});
  expect((await db`SELECT status,cancel_requested FROM runs WHERE id=${main}`)[0]).toMatchObject({status:'running',cancel_requested:true});
  f.setArchived(true);await progressLifecycle(l.sql,{},f.machine,{companionId:id,leaderPid:l.pid});
  expect((await db`SELECT status FROM runs WHERE companion_id=${id}`).map((r:any)=>r.status)).toEqual(['cancelled','cancelled']);
  expect((await db`SELECT status,endpoint_secret,archived_at FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'archived',endpoint_secret:null,archived_at:expect.any(Date)});
  await progressLifecycle(l.sql,{},f.machine,{companionId:id,leaderPid:l.pid});
  expect(f.calls).toHaveLength(2);expect(await db`SELECT id FROM machine_usage_events WHERE companion_id=${id} AND event='archived'`).toHaveLength(1);
 }finally{await l.close();}
});

test('cancellation remains live during snapshot reconciliation; missing snapshots never cause a blind stop or capture replay',async()=>{
 const id=await fixture();await prepared(id);const run=await acceptMessage(owner,id,crypto.randomUUID(),'Active');await db`UPDATE runs SET status='needs_input',dispatched=true WHERE id=${run}`;
 const template=await saveTemplate(owner,{name:'Existing',instructions:'Preserved'});const candidate=crypto.randomUUID();
 await db`INSERT INTO template_candidates(id,template_id,source_companion_id,expected_revision,snapshot_name,status,attempted_at) VALUES(${candidate},${template.id},${id},1,${'removal-'+candidate},'capturing',now()-interval '11 minutes')`;
 await retireCompanion(owner,id);const f=fake();f.setSnapshot('missing');const cancelled:string[]=[];
 f.machine.cancel=async(c,runId,guard)=>{await guard();expect(c.endpoint_secret).toBeTruthy();cancelled.push(runId);return true;};
 const l=await leader();try{
  await progressLifecycle(l.sql,{},f.machine,{companionId:id,leaderPid:l.pid});
  expect(cancelled).toEqual([run!]);expect((await db`SELECT status FROM runs WHERE id=${run}`)[0].status).toBe('cancelled');
  expect(f.calls).toEqual(['snapshot GET']);expect((await db`SELECT error FROM companions WHERE id=${id}`)[0].error).toContain('reconciliation');
  f.setSnapshot('ready');f.setArchived(true);await progressLifecycle(l.sql,{},f.machine,{companionId:id,leaderPid:l.pid});
  expect((await db`SELECT status FROM template_candidates WHERE id=${candidate}`)[0].status).toBe('failed');
  expect((await db`SELECT revision,snapshot_name FROM agent_templates WHERE id=${template.id}`)[0]).toMatchObject({revision:1,snapshot_name:null});
  expect(f.calls.at(-1)).toBe('archive '+id);
 }finally{await l.close();}
});

test('removing a delegating parent requests cancellation without retiring the permanent target',async()=>{
 const parent=await fixture(),target=await fixture();const parentRun=await acceptMessage(owner,parent,crypto.randomUUID(),'Delegate');
 const child=await delegateTask(owner,parent,parentRun!,crypto.randomUUID(),{companionId:target,prompt:'Delegated work'});
 await db`UPDATE runs SET status='running',dispatched=true WHERE id=${child.runId}`;
 await retireCompanion(owner,parent);
 expect((await db`SELECT status,cancel_requested FROM runs WHERE id=${child.runId}`)[0]).toMatchObject({status:'running',cancel_requested:true});
 expect((await db`SELECT retired_at,archive_requested_at FROM companions WHERE id=${target}`)[0]).toMatchObject({retired_at:null,archive_requested_at:null});
});

test('a lost archive checkpoint retries observation without duplicate usage or history loss',async()=>{
 const id=await fixture();await prepared(id);const run=await acceptMessage(owner,id,crypto.randomUUID(),'Preserve me');await db`UPDATE runs SET dispatched=true,status='running' WHERE id=${run}`;await retireCompanion(owner,id);
 const f=fake();let physicallyStopped=false,stops=0;f.machine.archive=async(_c,guard)=>{await guard?.();if(!physicallyStopped){stops++;physicallyStopped=true;}return true;};
 await db.unsafe(`CREATE FUNCTION reject_retirement_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${id}'::uuid AND NEW.archived_at IS NOT NULL THEN RAISE EXCEPTION 'checkpoint fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_retirement_checkpoint BEFORE UPDATE ON companions FOR EACH ROW EXECUTE FUNCTION reject_retirement_checkpoint()`);
 const l=await leader();try{
  await progressLifecycle(l.sql,{},f.machine,{companionId:id,leaderPid:l.pid});
  expect((await db`SELECT archived_at FROM companions WHERE id=${id}`)[0].archived_at).toBeNull();
  await db.unsafe('DROP TRIGGER reject_retirement_checkpoint ON companions; DROP FUNCTION reject_retirement_checkpoint()');
  await progressLifecycle(l.sql,{},f.machine,{companionId:id,leaderPid:l.pid});
  expect(stops).toBe(1);expect(await db`SELECT id FROM machine_usage_events WHERE companion_id=${id} AND event='archived'`).toHaveLength(1);
  expect((await detail(owner,id))?.messages).toHaveLength(1);
 }finally{await db.unsafe('DROP TRIGGER IF EXISTS reject_retirement_checkpoint ON companions; DROP FUNCTION IF EXISTS reject_retirement_checkpoint()');await l.close();}
});

test('leadership loss while observing a retiring machine prevents the stop and checkpoint',async()=>{
 const id=await fixture();await prepared(id);await retireCompanion(owner,id);const f=fake(),l=await leader();let enter!:()=>void,release!:()=>void,stops=0;
 const entered=new Promise<void>(r=>enter=r),hold=new Promise<void>(r=>release=r);
 f.machine.archive=async(_c,guard)=>{await guard?.();enter();await hold;await guard?.();stops++;return true;};
 const work=progressLifecycle(l.sql,{},f.machine,{companionId:id,leaderPid:l.pid});
 try{await entered;await l.sql`SELECT pg_advisory_unlock(721440139)`;release();await expect(work).rejects.toThrow();expect(stops).toBe(0);expect((await db`SELECT archived_at FROM companions WHERE id=${id}`)[0].archived_at).toBeNull();}
 finally{release();await work.catch(()=>{});await l.close();}
});

test('the coordinator still schedules a retired never-started Companion without machine effects',async()=>{
 const id=await fixture();await retireCompanion(owner,id);const f=fake(),l=await leader(),coordinator=new LifecycleCoordinator();
 try{await coordinator.schedule(l.sql,{lifecycleMachines:f.machine});await coordinator.close();expect((await db`SELECT status FROM companions WHERE id=${id}`)[0].status).toBe('archived');expect(f.calls).toHaveLength(0);}
 finally{await coordinator.close();await l.close();}
});

test('local archive distinguishes a successful absence from transport failures and foreign containers',async()=>{
 const companion={id:crypto.randomUUID(),provider:'local'};const calls:string[][]=[];
 expect(await archiveMachine(companion,async()=>{},async args=>{calls.push(args);return '';})).toBe(true);expect(calls.map(c=>c[0])).toEqual(['ps']);
 await expect(archiveMachine(companion,async()=>{},async()=>{throw Error('Docker unavailable');})).rejects.toThrow('Docker unavailable');
 await expect(archiveMachine(companion,async()=>{},async args=>args[0]==='ps'?args[3].slice('name=^/'.length,-1):JSON.stringify([{Config:{Labels:{'companions.build.workspace':'foreign'}},State:{Running:true}}]))).rejects.toThrow('ownership');
 let effects=0;await expect(archiveMachine(companion,async()=>{throw new ExecutionStopped();},async()=>{effects++;return '';})).rejects.toBeInstanceOf(ExecutionStopped);expect(effects).toBe(0);
});

test('DELETE winning during snapshot observation prevents final template activation',async()=>{
 const id=await fixture();await prepared(id);const template=await saveTemplate(owner,{name:'Stable profile',instructions:'Original'}),candidate=crypto.randomUUID();
 await db`INSERT INTO template_candidates(id,template_id,source_companion_id,expected_revision,snapshot_name,status,attempted_at) VALUES(${candidate},${template.id},${id},1,${'removal-race-'+candidate},'capturing',now())`;
 await db`INSERT INTO portable_skill_exports(id,source_owner_id,source_companion_id,target_kind,source_template_id,target_revision,status) VALUES(${crypto.randomUUID()},${owner},${id},'template_revision',${template.id},2,'ready')`;
 const f=fake(),l=await leader();let observations=0;
 f.machine.snapshotStatus=async()=>{observations++;await retireCompanion(owner,id);return 'ready';};
 try{
  await progressLifecycle(l.sql,{},f.machine,{companionId:id,leaderPid:l.pid});
  expect(observations).toBe(1);
  expect((await db`SELECT revision,snapshot_name,source_companion_id FROM agent_templates WHERE id=${template.id}`)[0]).toMatchObject({revision:1,snapshot_name:null,source_companion_id:null});
  expect((await db`SELECT status FROM template_candidates WHERE id=${candidate}`)[0].status).toBe('failed');
  expect(await db`SELECT revision FROM template_revisions WHERE template_id=${template.id} AND revision=2`).toHaveLength(0);
 }finally{await l.close();}
});

async function waitUntil(check:()=>Promise<boolean>){const end=Date.now()+3000;while(Date.now()<end){if(await check())return;await Bun.sleep(5);}throw Error('Database barrier was not reached');}
async function pid(sql:any){return (await sql`SELECT pg_backend_pid() AS pid`)[0].pid as number;}
async function blocked(pid:number){return (await db`SELECT cardinality(pg_blocking_pids(${pid}))>0 AS blocked`)[0].blocked as boolean;}

test('routine test and Companion retirement share lock order without deadlock',async()=>{
 const id=await fixture(),routine=await createRoutine(id,{name:'Concurrent test',prompt:'Work',cron:'0 * * * *',timezone:'UTC',enabled:false});
 const blocker=await db.reserve(),remover=await db.reserve(),tester=await db.reserve();
 let release!:()=>void,entered!:()=>void;
 const hold=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 const removalPid=await pid(remover),testPid=await pid(tester);
 const held=blocker.begin(async tx=>{await tx`SELECT id FROM companions WHERE id=${id} FOR UPDATE`;entered();await hold;});
 let removal:Promise<any>|undefined,admission:Promise<any>|undefined;
 try{
  await ready;
  removal=retireCompanion(owner,id,remover);void removal.catch(()=>{});
  await waitUntil(()=>blocked(removalPid));
  admission=testRoutine(id,routine!.id,crypto.randomUUID(),tester);void admission.catch(()=>{});
  await waitUntil(()=>blocked(testPid));
  release();await held;
  expect(await removal).toMatchObject({deleted:true});
  expect(await admission).toBeNull();
  expect(await db`SELECT id FROM runs WHERE companion_id=${id}`).toHaveLength(0);
 }finally{release();await Promise.allSettled([held,removal,admission].filter(Boolean));blocker.release();remover.release();tester.release();}
});

test('a review admission racing DELETE cannot leave queued work on a retired parent',async()=>{
 const parent=await fixture(),target=await fixture(),parentRun=await acceptMessage(owner,parent,crypto.randomUUID(),'Delegate');
 const delegated=await delegateTask(owner,parent,parentRun!,crypto.randomUUID(),{companionId:target,prompt:'Finished work'});
 await db`UPDATE runs SET status='succeeded',result_text='Result',finished_at=now() WHERE id=${delegated.runId}`;
 await db`UPDATE delegations SET files_saved_at=now() WHERE run_id=${delegated.runId}`;
 const blocker=await db.reserve(),remover=await db.reserve(),l=await leader(),f=fake();
 const removerPid=await pid(remover);let deletionDone=false;
 await blocker`SELECT pg_advisory_lock(721440999)`;
 await db.unsafe(`CREATE FUNCTION hold_review_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.companion_id='${parent}'::uuid AND NEW.source='delegation' THEN PERFORM pg_advisory_xact_lock(721440999); END IF; RETURN NEW; END $$; CREATE TRIGGER hold_review_admission BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION hold_review_admission()`);
 let deletion:Promise<any>|undefined;
 const progression=progressLifecycle(l.sql,{},f.machine,{companionId:target,leaderPid:l.pid});void progression.catch(()=>{});
 try{
  await waitUntil(()=>blocked(l.pid));
  deletion=retireCompanion(owner,parent,remover).finally(()=>{deletionDone=true;});void deletion.catch(()=>{});
  await waitUntil(async()=>deletionDone||await blocked(removerPid));
  await blocker`SELECT pg_advisory_unlock(721440999)`;
  await progression;await deletion;
  expect(await db`SELECT id FROM runs WHERE companion_id=${parent} AND status IN ('queued','preparing','running','needs_input')`).toHaveLength(0);
  const [review]=await db`SELECT r.status FROM delegations d JOIN runs r ON r.id=d.returned_run_id WHERE d.run_id=${delegated.runId}`;
  expect(review?.status).toBe('cancelled');
 }finally{
  await blocker`SELECT pg_advisory_unlock(721440999)`;
  await Promise.allSettled([progression,deletion].filter(Boolean));
  await db.unsafe('DROP TRIGGER hold_review_admission ON runs; DROP FUNCTION hold_review_admission()');
  blocker.release();remover.release();await l.close();
 }
});

test('DELETE winning before a delayed delegation review preserves the result without another run',async()=>{
 const parent=await fixture(),target=await fixture(),parentRun=await acceptMessage(owner,parent,crypto.randomUUID(),'Delegate');
 const delegated=await delegateTask(owner,parent,parentRun!,crypto.randomUUID(),{companionId:target,prompt:'Finished work'});
 await db`UPDATE runs SET status='succeeded',result_text='Retained result',finished_at=now() WHERE id=${delegated.runId}`;
 await db`UPDATE delegations SET files_saved_at=now() WHERE run_id=${delegated.runId}`;
 const l=await leader();
 try{
  await progressLifecycle(l.sql,{canStartWork:async()=>{await retireCompanion(owner,parent);return true;}},fake().machine,{companionId:target,leaderPid:l.pid});
  expect((await db`SELECT returned_run_id,finished_at,result FROM delegations WHERE run_id=${delegated.runId}`)[0]).toMatchObject({returned_run_id:null,finished_at:expect.any(Date),result:expect.objectContaining({text:'Retained result'})});
  expect(await db`SELECT id FROM runs WHERE companion_id=${parent} AND source='delegation'`).toHaveLength(0);
 }finally{await l.close();}
});
