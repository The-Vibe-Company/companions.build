import {beforeAll,afterEach,expect,test} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {acquireExecutor,tick,LifecycleCoordinator,RunCoordinator,runExecution} from '../src/executor';
import {config,encrypt,decrypt} from '../src/config';
import {prepareBox,ExecutionStopped} from '../src/machines';
import {BoxClient} from '../../../packages/box/client';
import {productHooks} from '../src/runtime-product';
import {controlHandlers} from '../src/control';
const owner='00000000-0000-4000-8000-000000000001',ids:string[]=[];
beforeAll(async()=>{await migrate();});
afterEach(async()=>{for(const id of ids.splice(0)){await db`UPDATE companions SET retired_at=now(),prepare_requested=false WHERE id=${id}`;await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id} AND status IN ('queued','preparing','running','needs_input')`;}});
function gate(){let release!:()=>void;return {promise:new Promise<void>(resolve=>{release=resolve;}),release:()=>release()};}
async function until(check:()=>Promise<boolean>|boolean){const end=Date.now()+3000;while(Date.now()<end){if(await check())return;await Bun.sleep(5);}throw Error('Expected checkpoint did not arrive');}
async function leader(){const sql=await acquireExecutor();if(!sql)throw Error('No test leader');const [{pid}]=await sql`SELECT pg_backend_pid() AS pid`;return {sql,pid,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};}
async function companion(endpoint:string){const c=await createCompanion(owner,{name:'Concurrent',instructions:'',provider:'box',prepare:false});ids.push(c.id);await db`UPDATE companions SET status='ready',endpoint_secret=${encrypt(endpoint)},box_id=${'owned-'+c.id},ready_at=now() WHERE id=${c.id}`;return (await db`SELECT * FROM companions WHERE id=${c.id}`)[0];}
async function running(c:any,lane='main'){const id=await acceptMessage(owner,c.id,crypto.randomUUID(),'Existing');await db`UPDATE runs SET status='running',dispatched=true,started_at=now(),lane=${lane} WHERE id=${id}`;return {id,companion_id:c.id,owner_id:owner,lane,endpoint_secret:c.endpoint_secret,box_id:c.box_id};}

test('blocked background and main observations do not delay a native steer or another warm chat',async()=>{
 const blocked=gate(),lock=await leader(),lifecycle=new LifecycleCoordinator(),runs=new RunCoordinator();let blockedCount=0,puts=0;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){if(new URL(req.url).pathname==='/health')return Response.json({ready:true});if(req.method==='PUT'){puts++;return Response.json({status:'running'});}return Response.json({status:'succeeded',text:'finished'});}});
 try{
  const c=await companion(`http://127.0.0.1:${daemon.port}`),other=await companion(`http://127.0.0.1:${daemon.port}`);
  const main=await running(c),background=await running(c,'background');
  const hooks={async observeRun(run:any){if([main.id,background.id].includes(run.id)){blockedCount++;await blocked.promise;}}};
  await tick(lock.sql,hooks,lifecycle,runs);await until(()=>blockedCount===2);
  const steer=await acceptMessage(owner,c.id,crypto.randomUUID(),'Steer now'),warm=await acceptMessage(owner,other.id,crypto.randomUUID(),'Warm now');
  await tick(lock.sql,hooks,lifecycle,runs);await until(()=>puts===2);
  await until(()=>runs.activeCount===2);
  await tick(lock.sql,hooks,lifecycle,runs);
  await until(async()=>{const [{count}]=await db`SELECT count(*)::int AS count FROM runs WHERE id IN (${steer},${warm}) AND status='succeeded'`;return count===1;});
  // Another main result may wait behind the same Companion's observation, but admission never does.
  expect((await db`SELECT dispatched FROM runs WHERE id=${steer}`)[0].dispatched).toBe(true);
  expect((await db`SELECT result_text FROM runs WHERE id=${warm}`)[0].result_text).toBe('finished');
 }finally{blocked.release();await runs.close();await lifecycle.close();await lock.close();daemon.stop(true);}
});

test('a stalled PUT is never observed as missing or reissued by subsequent ticks',async()=>{
 const blocked=gate(),lock=await leader(),lifecycle=new LifecycleCoordinator(),runs=new RunCoordinator();let puts=0,gets=0;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){if(new URL(req.url).pathname==='/health')return Response.json({ready:true});if(req.method==='PUT'){puts++;await blocked.promise;return Response.json({status:'running'});}gets++;return Response.json({status:'running'});}});
 try{
  const c=await companion(`http://127.0.0.1:${daemon.port}`),id=await acceptMessage(owner,c.id,crypto.randomUUID(),'One durable prompt');
  await tick(lock.sql,{},lifecycle,runs);await until(()=>puts===1);
  await tick(lock.sql,{},lifecycle,runs);await tick(lock.sql,{},lifecycle,runs);
  expect(puts).toBe(1);expect(gets).toBe(0);expect((await db`SELECT status FROM runs WHERE id=${id}`)[0].status).toBe('running');
 }finally{blocked.release();await runs.close();await lifecycle.close();await lock.close();daemon.stop(true);}
});

for(const change of ['leader','retirement','endpoint'] as const)test(`${change} change after GET control prevents configuration, command effects and result delivery`,async()=>{
 const lock=await leader(),blocked=gate();let getStarted=false,effects=0,mutations=0;
 const previous=controlHandlers.configure;controlHandlers.configure=async()=>{effects++;return {ok:true};};
 let run:any,commandId=crypto.randomUUID();
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){if(req.method!=='GET')mutations++;if(new URL(req.url).pathname==='/control'){getStarted=true;await blocked.promise;return Response.json({requests:[{id:commandId,runId:run.id,operation:'configure',input:{name:'Late'}}]});}return Response.json({files:[]});}});
 try{
  const endpoint=`http://127.0.0.1:${daemon.port}`,c=await companion(endpoint);run=await running(c);
  const promise=productHooks.observeRun!(run,endpoint,decrypt(c.agent_secret),runExecution(run,lock.pid)).then(()=>null,error=>error);
  await until(()=>getStarted);
  if(change==='leader')await lock.sql`SELECT pg_advisory_unlock(721440139)`;
  else if(change==='retirement')await db`UPDATE companions SET retired_at=now() WHERE id=${c.id}`;
  else await db`UPDATE companions SET endpoint_secret=${encrypt('http://new-generation')} WHERE id=${c.id}`;
  blocked.release();expect(await promise).toBeInstanceOf(ExecutionStopped);
  expect(effects).toBe(0);expect(mutations).toBe(0);expect(await db`SELECT id FROM control_commands WHERE id=${commandId}`).toHaveLength(0);
 }finally{blocked.release();controlHandlers.configure=previous;await lock.close();daemon.stop(true);}
});

for(const barrier of ['archived_get','ready_get','file_write'] as const)test(`Box preparation stops after leader loss at ${barrier}`,async()=>{
 const lock=await leader(),c=await companion('http://unused'),before=config.boxTemplate;config.boxTemplate='test-template';const effects:string[]=[];
 const client=new BoxClient('isolated-fake',(async(input:URL|RequestInfo,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname,method=init?.method??'GET';
  if(method==='GET'){
   if(barrier!=='file_write')await lock.sql`SELECT pg_advisory_unlock(721440139)`;
   return Response.json({box:{id:c.box_id,state:barrier==='archived_get'?'archived':'ready'}});
  }
  effects.push(method+' '+path);
  if(path.endsWith('/files'))await lock.sql`SELECT pg_advisory_unlock(721440139)`;
  return Response.json({success:true,exitCode:0,stdout:''});
 }) as typeof fetch);
 try{
  const execution=runExecution({companion_id:c.id,owner_id:owner},lock.pid);
  await expect(prepareBox({...c,endpoint_secret:null},async()=>{},async()=>{},execution.assertActive,client)).rejects.toBeInstanceOf(ExecutionStopped);
  expect(effects.length).toBe(barrier==='file_write'?1:0);expect(effects.some(effect=>effect.includes('/commands')||effect.includes('/resume'))).toBe(false);
 }finally{config.boxTemplate=before;await lock.close();}
});

test('job limits reserve admission capacity and never duplicate an inflight request across phases',async()=>{
 const coordinator=new RunCoordinator(),blocked=gate();let calls=0;
 const group=(kind:string,i:number,status:string)=>[`${i}:${kind}`,[{id:kind+i,lane:kind==='background'?'background':'main',status}]] as [string,any[]];
 try{
  const groups=[...Array.from({length:12},(_,i)=>group('background',i,'running')),...Array.from({length:12},(_,i)=>group('main_observation',i,'running')),...Array.from({length:12},(_,i)=>group('main_admission',i,'preparing'))];
  const progress=async()=>{calls++;await blocked.promise;};coordinator.schedule(groups,progress);coordinator.schedule(groups,progress);
  expect(calls).toBe(24);expect(coordinator.activeCount).toBe(24);
  coordinator.schedule([['new-phase',[{id:'main_admission0',lane:'main',status:'running'}]]],progress);expect(calls).toBe(24);
 }finally{blocked.release();await coordinator.close();}
});

test('startup migration and executor acquisition share one DDL lock order',async()=>{
 const [,sql]=await Promise.all([migrate(),acquireExecutor()]);expect(sql).not.toBeNull();
 if(sql){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}
});

test('a stale health reply cannot cancel work or clear the replacement endpoint',async()=>{
 const blocked=gate(),lock=await leader(),lifecycle=new LifecycleCoordinator(),runs=new RunCoordinator();let checking=false,mutations=0;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){if(req.method==='GET'){checking=true;await blocked.promise;return Response.json({ready:true,activeRunId:crypto.randomUUID()});}mutations++;return Response.json({});}});
 try{
  const c=await companion(`http://127.0.0.1:${daemon.port}`),next=encrypt('http://replacement-generation');await acceptMessage(owner,c.id,crypto.randomUUID(),'Pending');
  await tick(lock.sql,{},lifecycle,runs);await until(()=>checking);
  await db`UPDATE companions SET endpoint_secret=${next} WHERE id=${c.id}`;blocked.release();await runs.close();
  expect(mutations).toBe(0);expect((await db`SELECT endpoint_secret FROM companions WHERE id=${c.id}`)[0].endpoint_secret).toBe(next);
 }finally{blocked.release();await runs.close();await lifecycle.close();await lock.close();daemon.stop(true);}
});

test('revocation during Box preparation prevents the next cost-producing effect',async()=>{
 const blocked=gate(),lock=await leader(),lifecycle=new LifecycleCoordinator();let allowed=true,observing=false,effects=0;
 try{
  const c=await companion('http://not-prepared');await db`UPDATE companions SET endpoint_secret=null,prepare_requested=true WHERE id=${c.id}`;
  const hooks={async canStartWork(){return allowed;},lifecycleMachines:{async prepare(_c:any,_checkpoint:any,_configured:any,beforeEffect?:()=>Promise<void>){await beforeEffect!();observing=true;await blocked.promise;await beforeEffect!();effects++;return null;},async health(){return {ready:true};},async pause(){},async archive(){return true;},async snapshot(){},async snapshotStatus(){return 'ready' as const;}}};
  await lifecycle.schedule(lock.sql,hooks);await until(()=>observing);allowed=false;blocked.release();await lifecycle.close();expect(effects).toBe(0);
 }finally{blocked.release();await lifecycle.close();await lock.close();}
});
