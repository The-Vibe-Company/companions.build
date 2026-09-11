import {beforeAll,afterEach,test,expect} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {encrypt} from '../src/config';
import {acquireExecutor,claimQueuedRuns} from '../src/executor';
import {progressRuntimeUpdate,type RuntimeUpdateMachine} from '../src/runtime-updates';
const owner='00000000-0000-4000-8000-000000000001',ids:string[]=[];
const version='a'.repeat(64),hash='b'.repeat(64);
beforeAll(()=>migrate());
afterEach(async()=>{for(const id of ids.splice(0)){
 await db`UPDATE runtime_updates SET state='failed',finished_at=now() WHERE companion_id=${id} AND finished_at IS NULL`;
 await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id} AND status IN ('queued','preparing','running','needs_input')`;
 await db`UPDATE companions SET retired_at=now(),prepare_requested=false WHERE id=${id}`;
}});
async function fixture(){
 const c=await createCompanion(owner,{name:'Runtime update',provider:'box',prepare:false});ids.push(c.id);
 await db`UPDATE companions SET status='ready',box_id=${'bx_'+c.id},endpoint_secret=${encrypt('http://fixture')},ready_at=now() WHERE id=${c.id}`;
 const sql=await acquireExecutor();if(!sql)throw Error('test leader missing');
 let healthyVersion:string|null=null,applied=0,staged=0,inspected=0;
 const machine:RuntimeUpdateMachine={release:{schemaVersion:1,id:version,protocolVersion:1,stateVersion:1,files:[],bundle:[]},installerHash:hash,
  async health(){return {ready:true,runtimeVersion:healthyVersion,maintenanceSupported:true,activeRunId:null,activeRuns:{main:null,background:null},parkedRuns:[]};},
  async drain(){},async undrain(){},
  async stage(){staged++;return {state:'staged'};},
  async apply(){applied++;healthyVersion=version;return {state:'succeeded'};},
  async inspect(){inspected++;return {state:'succeeded'};},
 };
 return {c,sql,machine,counts:()=>({applied,staged,inspected}),version:(v:string|null)=>{healthyVersion=v;},
  async run(){return progressRuntimeUpdate(db,c.id,async()=>{const [r]=await sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND objid=721440139 AND granted) AS owned`;if(!r.owned)throw Error('lease lost');},machine,()=>Date.now()+600_000);},
  async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};
}
test('same Box receives one update; messages arriving during staging stay persisted and queued',async()=>{
 const f=await fixture();let message:string|null|undefined;
 const other=await createCompanion(owner,{name:'Other stays available',provider:'local',prepare:false});ids.push(other.id);
 const original=f.machine.stage;
 f.machine.stage=async(job,guard)=>{
  expect(job.box_id).toBe('bx_'+f.c.id);
  const [saved]=await db`SELECT state FROM runtime_updates WHERE id=${job.id}`;expect(saved.state).toBe('staging');
  message=await acceptMessage(owner,f.c.id,crypto.randomUUID(),'arrived during update');
  const otherMessage=await acceptMessage(owner,other.id,crypto.randomUUID(),'Other can continue');
  await claimQueuedRuns(f.sql);
  expect((await db`SELECT status FROM runs WHERE id=${otherMessage}`)[0].status).toBe('preparing');
  expect((await db`SELECT status,dispatched FROM runs WHERE id=${message}`)[0]).toMatchObject({status:'queued',dispatched:false});
  return original(job,guard);
 };
 try{
  await f.run();await f.run();expect(f.counts()).toEqual({applied:1,staged:1,inspected:0});
  expect((await db`SELECT box_id,runtime_version,runtime_update_status FROM companions WHERE id=${f.c.id}`)[0]).toMatchObject({box_id:'bx_'+f.c.id,runtime_version:version,runtime_update_status:'current'});
  await claimQueuedRuns(f.sql);expect((await db`SELECT status FROM runs WHERE id=${message}`)[0].status).toBe('preparing');
 }finally{await f.close();}
});
for(const state of ['running','needs_input','preparing'])test(`defers ${state} work without touching the machine`,async()=>{
 const f=await fixture();try{
  const id=await acceptMessage(owner,f.c.id,crypto.randomUUID(),'existing');await db`UPDATE runs SET status=${state},dispatched=true WHERE id=${id}`;
  await f.run();expect(f.counts()).toEqual({applied:0,staged:0,inspected:0});
  expect((await db`SELECT runtime_update_status FROM companions WHERE id=${f.c.id}`)[0].runtime_update_status).toBe('deferred');
 }finally{await f.close();}
});
test('lost apply response reconciles its durable update instead of applying twice',async()=>{
 const f=await fixture();const original=f.machine.apply;
 f.machine.apply=async(job,guard)=>{await original(job,guard);throw Error('lost response');};
 try{
  await f.run();expect((await db`SELECT runtime_update_status FROM companions WHERE id=${f.c.id}`)[0].runtime_update_status).toBe('blocked');
  await f.run();expect(f.counts()).toEqual({applied:1,staged:1,inspected:1});
  expect((await db`SELECT runtime_update_status FROM companions WHERE id=${f.c.id}`)[0].runtime_update_status).toBe('current');
 }finally{await f.close();}
});
test('unconfirmed installation never releases new messages or replays apply',async()=>{
 const f=await fixture();let calls=0;
 f.machine.apply=async()=>{calls++;throw Error('lost response');};f.machine.inspect=async()=>({state:'not_started'});
 try{
  await f.run();await f.run();const message=await acceptMessage(owner,f.c.id,crypto.randomUUID(),'keep queued');await claimQueuedRuns(f.sql);
  expect(calls).toBe(1);expect((await db`SELECT status,dispatched FROM runs WHERE id=${message}`)[0]).toMatchObject({status:'queued',dispatched:false});
 }finally{await f.close();}
});
test('unsafe ephemeral data defers without install; confirmed rollback keeps previous runtime usable',async()=>{
 const f=await fixture();f.machine.stage=async()=>({state:'deferred',code:'EPHEMERAL_DATA_PRESENT'});
 try{
  await f.run();expect(f.counts().applied).toBe(0);
  expect((await db`SELECT runtime_update_status,runtime_update_error FROM companions WHERE id=${f.c.id}`)[0]).toMatchObject({runtime_update_status:'deferred',runtime_update_error:'EPHEMERAL_DATA_PRESENT'});
  await db`UPDATE companions SET runtime_update_checked_at=null WHERE id=${f.c.id}`;
  f.machine.stage=async()=>({state:'staged'});f.machine.apply=async()=>({state:'rolled_back'});await f.run();
  expect((await db`SELECT runtime_update_status FROM companions WHERE id=${f.c.id}`)[0].runtime_update_status).toBe('failed');
  const message=await acceptMessage(owner,f.c.id,crypto.randomUUID(),'continue');await claimQueuedRuns(f.sql);
  expect((await db`SELECT status FROM runs WHERE id=${message}`)[0].status).toBe('preparing');
 }finally{await f.close();}
});
test('archived machines are not woken by automatic updates',async()=>{
 const f=await fixture();try{
  await db`UPDATE companions SET archived_at=now() WHERE id=${f.c.id}`;await f.run();expect(f.counts()).toEqual({applied:0,staged:0,inspected:0});
 }finally{await f.close();}
});
