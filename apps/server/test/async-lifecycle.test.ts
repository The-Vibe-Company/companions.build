import {beforeAll,afterEach,expect,test} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {acquireExecutor,tick,LifecycleCoordinator} from '../src/executor';
import {encrypt} from '../src/config';
import type {LifecycleMachines} from '../src/lifecycle';
const owner='00000000-0000-4000-8000-000000000001',ids:string[]=[];
beforeAll(async()=>{await migrate();});
afterEach(async()=>{for(const id of ids.splice(0)){await db`UPDATE machine_usage_events SET reported_at=now() WHERE companion_id=${id}`;await db`UPDATE companions SET prepare_requested=false,retired_at=now() WHERE id=${id}`;await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id} AND status IN ('queued','preparing','running','needs_input')`;}});
async function companion(name:string){const c=await createCompanion(owner,{name,instructions:'',provider:'box',prepare:false});ids.push(c.id);return c.id as string;}
async function leader(){const sql=await acquireExecutor();if(!sql)throw Error('Test leader unavailable');return {sql,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};}
function gate(){let release!:()=>void;return {promise:new Promise<void>(resolve=>{release=resolve;}),release:()=>release()};}
function machine(prepare:LifecycleMachines['prepare']):LifecycleMachines{return {prepare,async health(){return {ready:true};},async pause(){},async archive(){return true;},async snapshot(){},async snapshotStatus(){return 'ready';}};}
async function until(check:()=>Promise<boolean>|boolean){const end=Date.now()+2000;while(Date.now()<end){if(await check())return;await Bun.sleep(5);}throw Error('Expected runtime checkpoint did not arrive');}

test('a stalled cold machine never holds warm chat dispatch or terminal reconciliation',async()=>{
 const cold=await companion('Cold'),warm=await companion('Warm'),blocked=gate(),lock=await leader(),coordinator=new LifecycleCoordinator();
 let attempts=0,coldStarted=false,coldReleased=false,puts=0;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const path=new URL(req.url).pathname;if(path==='/health')return Response.json({ready:true});if(req.method==='PUT'){puts++;return Response.json({status:'running'});}return Response.json({status:'succeeded',text:'Warm task finished'});}});
 const hooks={lifecycleMachines:machine(async c=>{expect(c.id).toBe(cold);attempts++;coldStarted=true;await blocked.promise;coldReleased=true;return 'http://cold-ready';})};
 try{
  await db`UPDATE companions SET prepare_requested=true,box_id='cold-existing-box' WHERE id=${cold}`;
  await db`UPDATE companions SET status='ready',endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)},box_id='warm-existing-box',ready_at=now() WHERE id=${warm}`;
  const run=await acceptMessage(owner,warm,crypto.randomUUID(),'Answer now');
  await tick(lock.sql,hooks,coordinator);await until(()=>coldStarted);
  expect(puts).toBe(1);expect(coldReleased).toBe(false);
  await tick(lock.sql,hooks,coordinator);
  expect((await db`SELECT status,result_text FROM runs WHERE id=${run}`)[0]).toMatchObject({status:'succeeded',result_text:'Warm task finished'});
  expect(coldReleased).toBe(false);expect(attempts).toBe(1);expect(coordinator.activeCount).toBe(1);
 }finally{blocked.release();await coordinator.close();await lock.close();daemon.stop(true);}
});

test('an asynchronous lifecycle checkpoint cannot mutate machine identity after the captured leader loses its lock',async()=>{
 const id=await companion('Fenced machine'),blocked=gate(),lock=await leader(),coordinator=new LifecycleCoordinator();let started=false;
 const hooks={lifecycleMachines:machine(async(_c,checkpoint)=>{started=true;await blocked.promise;await checkpoint('late-provider-result');return 'http://late';})};
 try{
  await db`UPDATE companions SET prepare_requested=true,box_id='original-known-box' WHERE id=${id}`;
  await tick(lock.sql,hooks,coordinator);await until(()=>started);
  await lock.sql`SELECT pg_advisory_unlock(721440139)`;
  await expect(tick(lock.sql,hooks,coordinator)).rejects.toThrow('Executor ownership lost');
  blocked.release();await coordinator.close();
  expect((await db`SELECT box_id,ready_at FROM companions WHERE id=${id}`)[0]).toMatchObject({box_id:'original-known-box',ready_at:null});
 }finally{blocked.release();await coordinator.close();await lock.close();}
});

test('asynchronous preparation is bounded and repeated scheduling never duplicates inflight jobs',async()=>{
 const companions=await Promise.all(Array.from({length:7},(_,i)=>companion('Pending '+i))),blocked=gate(),lock=await leader(),coordinator=new LifecycleCoordinator();let attempts=0;const seen=new Set<string>();
 const hooks={lifecycleMachines:machine(async c=>{attempts++;seen.add(c.id);await blocked.promise;return null;})};
 try{
  for(const id of companions)await db`UPDATE companions SET prepare_requested=true WHERE id=${id}`;
  await tick(lock.sql,hooks,coordinator);await until(()=>attempts===4);
  await tick(lock.sql,hooks,coordinator);expect(attempts).toBe(4);expect(coordinator.activeCount).toBe(4);
  blocked.release();await until(()=>coordinator.activeCount===0);
  await tick(lock.sql,hooks,coordinator);await until(()=>seen.size===7);
 }finally{blocked.release();await coordinator.close();await lock.close();}
});

test('persistent retirements beyond the scan limit cannot starve a new preparation',async()=>{
 const pending=await Promise.all(Array.from({length:100},(_,i)=>companion('Unconfirmed retirement '+i)));
 for(const id of pending)await db`UPDATE companions SET retired_at=now(),archive_requested_at=now(),create_started_at=now()-interval '1 day' WHERE id=${id}`;
 const fresh=await companion('New preparation'),lock=await leader(),coordinator=new LifecycleCoordinator();let attempts=0;
 const hooks={lifecycleMachines:machine(async c=>{expect(c.id).toBe(fresh);attempts++;return null;})};
 try{
  await db`UPDATE companions SET prepare_requested=true WHERE id=${fresh}`;
  for(let round=0;round<30&&!attempts;round++){
   await coordinator.schedule(lock.sql,hooks);
   await until(()=>coordinator.activeCount===0);
  }
  expect(attempts).toBe(1);
  expect((await db`SELECT count(*)::int AS count FROM companions WHERE id IN ${db(pending)} AND retired_at IS NOT NULL AND archived_at IS NULL`)[0].count).toBe(100);
 }finally{
  await coordinator.close();await lock.close();
  for(const id of pending)await db`UPDATE companions SET archived_at=now() WHERE id=${id}`;
 }
},10_000);
