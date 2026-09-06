import {beforeAll,afterEach,expect,test} from 'bun:test';
import {db,migrate,createCompanion} from '../src/store';
import {acquireExecutor} from '../src/executor';
import {BoxObserver,observeBox,type ObservedBox} from '../src/box-observation';
import {billableBoxIntervals,recordCompletedUsage} from '../src/usage';
import {BoxClient} from '../../../packages/box/client';
const owner='00000000-0000-4000-8000-000000000001',ids:string[]=[];
const at=(seconds:number)=>new Date(Date.UTC(2026,0,1)+seconds*1000);
beforeAll(async()=>{await migrate();});
afterEach(async()=>{for(const id of ids.splice(0))await db`UPDATE companions SET retired_at=now() WHERE id=${id}`;});
async function fixture(provider:'box'|'local'='box',ownerId=owner):Promise<ObservedBox>{
 const c=await createCompanion(ownerId,{name:'Observed',instructions:'',provider,prepare:false});ids.push(c.id);
 const readyId=crypto.randomUUID(),boxId='owned-'+crypto.randomUUID();
 await db`UPDATE companions SET status='ready',box_id=${boxId},ready_at=${at(0)},endpoint_secret='opaque-existing-endpoint' WHERE id=${c.id}`;
 await db`INSERT INTO machine_usage_events(id,companion_id,owner_id,event,occurred_at) VALUES(${readyId},${c.id},${ownerId},'ready',${at(0)})`;
 return {id:c.id,owner_id:ownerId,box_id:boxId,ready_event_id:readyId,ready_at:at(0)};
}
async function leader(){const sql=await acquireExecutor();if(!sql)throw Error('Test leader unavailable');const [{pid}]=await sql`SELECT pg_backend_pid() AS pid`;return {sql,pid,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};}
async function interval(c:ObservedBox,now=at(86400)){return (await billableBoxIntervals(db,now)).find((row:any)=>row.id===c.ready_event_id)!;}
function gate(){let release!:()=>void;return {promise:new Promise<void>(resolve=>{release=resolve;}),release:()=>release()};}
async function until(check:()=>boolean){const end=Date.now()+2000;while(Date.now()<end){if(check())return;await Bun.sleep(5);}throw Error('Expected checkpoint did not arrive');}

test('late external archive closes only confirmed uptime, clears the endpoint and never duplicates billing',async()=>{
 const c=await fixture(),lock=await leader();let gets=0;
 try{
  await observeBox(c,lock.pid,async id=>{gets++;return {id,state:'ready',archiveAfter:at(120).toISOString()};},db,()=>at(60));
  expect((await interval(c)).seconds).toBe(60);
  await observeBox(c,lock.pid,async id=>{gets++;return {id,state:'archived',archiveAfter:at(120).toISOString(),updatedAt:at(86400).toISOString()};},db,()=>at(86400));
  await observeBox(c,lock.pid,async()=>{throw Error('Already archived Box must not be read again');},db,()=>at(86401));
  const events=await db`SELECT occurred_at FROM machine_usage_events WHERE closes_ready_event_id=${c.ready_event_id}`;
  expect(events).toHaveLength(1);expect(new Date(events[0].occurred_at)).toEqual(at(60));
  expect((await db`SELECT status,endpoint_secret FROM companions WHERE id=${c.id}`)[0]).toEqual({status:'archived',endpoint_secret:null});
  expect(await interval(c)).toMatchObject({seconds:60,closed:true});expect(gets).toBe(2);
  await recordCompletedUsage();await recordCompletedUsage();
  const [{quantity}]=await db`SELECT sum(quantity)::int AS quantity FROM usage_ledger WHERE operation_id LIKE ${'box-time:'+c.ready_event_id+':%'}`;
  expect(quantity).toBe(60);
 }finally{await lock.close();}
});

test('a long controller outage never bills unknown hours even if the next GET is ready',async()=>{
 const c=await fixture(),lock=await leader();
 try{
  expect((await interval(c)).seconds).toBe(0);
  const ready=async(id:string)=>({id,state:'ready',archiveAfter:at(200000).toISOString()});
  await observeBox(c,lock.pid,ready,db,()=>at(60));expect((await interval(c)).seconds).toBe(60);
  await observeBox(c,lock.pid,ready,db,()=>at(86400));expect((await interval(c,at(200000))).seconds).toBe(60);
  await observeBox(c,lock.pid,ready,db,()=>at(86460));expect((await interval(c,at(200000))).seconds).toBe(120);
 }finally{await lock.close();}
});

test('known TTL caps ongoing time and a new ready generation never backfills the old gap',async()=>{
 const c=await fixture(),lock=await leader();
 try{
  await observeBox(c,lock.pid,async id=>({id,state:'ready',archiveAfter:at(30).toISOString()}),db,()=>at(60));
  expect((await interval(c)).seconds).toBe(30);
  await db`INSERT INTO machine_usage_events(id,companion_id,owner_id,event,occurred_at) VALUES(${crypto.randomUUID()},${c.id},${owner},'ready',${at(10000)})`;
  expect(await interval(c)).toMatchObject({seconds:30,closed:true});
 }finally{await lock.close();}
});

test('an authoritative internal archive retains its exact final partial minute',async()=>{
 const c=await fixture();
 await db`INSERT INTO machine_usage_events(id,companion_id,owner_id,event,occurred_at) VALUES(${crypto.randomUUID()},${c.id},${owner},'archived',${at(75)})`;
 expect(await interval(c)).toMatchObject({seconds:75,closed:true});
});

test('a late internal finalization of an observed cycle cannot bill an unconfirmed outage',async()=>{
 const c=await fixture(),lock=await leader();
 try{
  await observeBox(c,lock.pid,async id=>({id,state:'ready'}),db,()=>at(60));
  await db`INSERT INTO machine_usage_events(id,companion_id,owner_id,event,occurred_at) VALUES(${crypto.randomUUID()},${c.id},${owner},'archived',${at(86400)})`;
  expect(await interval(c)).toMatchObject({seconds:60,closed:true});
 }finally{await lock.close();}
});

test('owner, provider, Box identity and ready generation fence provider observation',async()=>{
 const c=await fixture(),local=await fixture('local'),lock=await leader();let gets=0;
 try{
  const get=async(id:string)=>{gets++;return {id,state:'ready'};};
  for(const invalid of [{...c,owner_id:crypto.randomUUID()},local,{...c,box_id:'foreign-box'},{...c,ready_event_id:crypto.randomUUID()}])await observeBox(invalid,lock.pid,get,db,()=>at(60));
  expect(gets).toBe(0);
  await expect(observeBox(c,lock.pid,async()=>({id:'wrong-returned-id',state:'archived'}),db,()=>at(60))).rejects.toThrow('identity mismatch');
  await observeBox(c,lock.pid,async id=>{
   await db`INSERT INTO machine_usage_events(id,companion_id,owner_id,event,occurred_at) VALUES(${crypto.randomUUID()},${c.id},${owner},'ready',${at(100)})`;
   return {id,state:'archived'};
  },db,()=>at(60));
  expect((await db`SELECT status FROM companions WHERE id=${c.id}`)[0].status).toBe('ready');
  expect((await db`SELECT observed_at FROM box_observations WHERE ready_event_id=${c.ready_event_id}`)[0].observed_at).toBeNull();
  expect((await billableBoxIntervals(db,at(100))).some((row:any)=>row.id===local.ready_event_id)).toBe(false);
 }finally{await lock.close();}
});

test('a provider reply after leader loss cannot checkpoint an archive',async()=>{
 const c=await fixture(),lock=await leader();
 try{
  await expect(observeBox(c,lock.pid,async id=>{await lock.sql`SELECT pg_advisory_unlock(721440139)`;return {id,state:'archived'};},db,()=>at(60))).rejects.toThrow('Executor ownership lost');
  expect((await db`SELECT status FROM companions WHERE id=${c.id}`)[0].status).toBe('ready');
 }finally{await lock.close();}
});

test('observer scheduling returns during a stalled GET and permits only one network job',async()=>{
 await fixture();const blocked=gate(),lock=await leader();let gets=0,now=at(60);
 const observer=new BoxObserver(db,async id=>{gets++;await blocked.promise;return {id,state:'ready'};},()=>now);
 try{
  await observer.schedule(lock.sql);await until(()=>gets===1);
  now=at(3600);await observer.schedule(lock.sql);expect(gets).toBe(1);
  // The reserved runtime connection stays usable while the provider is stalled.
  expect((await lock.sql`SELECT 1 AS ready`)[0].ready).toBe(1);
 }finally{blocked.release();await observer.close();await lock.close();}
});

test('Box GET exposes only valid safe timestamps and uses no wake endpoint',async()=>{
 const requests:{url:string;method:string}[]=[];
 const client=new BoxClient('test',(async(input:URL|RequestInfo,init?:RequestInit)=>{
  requests.push({url:String(input),method:init?.method??'GET'});
  return Response.json({box:{id:'owned',state:'ready',archiveAfter:at(120).toISOString(),updatedAt:'opaque secret invalid date',secret:'must not escape'}});
 }) as typeof fetch);
 const box=await client.get('owned');expect(box.archiveAfter).toBe(at(120).toISOString());expect(box.updatedAt).toBeUndefined();expect(box).not.toHaveProperty('secret');
 expect(requests).toEqual([{url:'https://ascii.dev/api/box/v1/boxes/owned',method:'GET'}]);
});
