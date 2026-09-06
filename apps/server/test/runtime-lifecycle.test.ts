import {beforeAll,afterEach,expect,test} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {acquireExecutor,tick,persistObservation} from '../src/executor';
import {migrateLifecycle,type LifecycleMachines} from '../src/lifecycle';
import {encrypt} from '../src/config';
import {productHooks} from '../src/runtime-product';
const owner='00000000-0000-4000-8000-000000000001',ids:string[]=[];
beforeAll(async()=>{await migrate();await migrateLifecycle();await db.unsafe('ALTER TABLE runs ADD COLUMN IF NOT EXISTS preview_text text; ALTER TABLE runs ADD COLUMN IF NOT EXISTS usage jsonb');});
afterEach(async()=>{for(const id of ids.splice(0)){await db`UPDATE companions SET retired_at=now(),prepare_requested=false,desktop_taken=false,desktop_paused_at=null WHERE id=${id}`;await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id} AND status IN ('queued','preparing','running','needs_input')`;}});
async function companion(){const c=await createCompanion(owner,{name:'Runtime lifecycle fixture',instructions:'',provider:'box'});ids.push(c.id);await db`UPDATE companions SET prepare_requested=false WHERE id=${c.id}`;return c.id as string;}
async function leader(){const sql=await acquireExecutor();if(!sql)throw Error('Test executor missing');return {sql,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};}
function machines(endpoint:string,events:string[],companionId:string):LifecycleMachines{return {async prepare(c,checkpoint){if(c.id!==companionId)return null;events.push('prepare '+(c.snapshot_name??'base'));await checkpoint('fixture-box');return endpoint;},async health(){events.push('health');return {ready:true};},async pause(_c,taken){events.push('pause '+taken);},async archive(){events.push('archive');return true;},async snapshot(){events.push('snapshot');},async snapshotStatus(){return 'pending';}};}

test('executor prepares the pinned snapshot before dispatch and pauses admission plus observation during takeover',async()=>{
 const id=await companion(),events:string[]=[];let puts=0,submittedModel:string|undefined;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){events.push(req.method+' '+new URL(req.url).pathname);if(req.method==='PUT'){puts++;submittedModel=(await req.json() as any).modelId;}return Response.json(new URL(req.url).pathname==='/health'?{ready:true,activeRuns:{main:null,background:null}}:{status:'running'});}});
 const endpoint=`http://127.0.0.1:${daemon.port}`,fake=machines(endpoint,events,id),lock=await leader();
 try{
  await db`UPDATE companions SET model_id='fixture-model',snapshot_name='private-pinned-template',template_id=${crypto.randomUUID()} WHERE id=${id}`;
  const run=await acceptMessage(owner,id,crypto.randomUUID(),'Work');await tick(lock.sql,{lifecycleMachines:fake});
  expect(events[0]).toBe('prepare private-pinned-template');expect(puts).toBe(1);expect(submittedModel).toBe('fixture-model');
  await db`UPDATE companions SET desktop_taken=true WHERE id=${id}`;events.length=0;
  const queued=await acceptMessage(owner,id,crypto.randomUUID(),'Queue during takeover');await tick(lock.sql,{lifecycleMachines:fake});
  expect(events).toEqual(['pause true']);expect((await db`SELECT status FROM runs WHERE id=${queued}`)[0].status).toBe('queued');
  events.length=0;await tick(lock.sql,{lifecycleMachines:fake});expect(events).toEqual([]);
  await db`UPDATE companions SET desktop_taken=false WHERE id=${id}`;await tick(lock.sql,{lifecycleMachines:fake});
  expect(events[0]).toBe('pause false');expect(events).toContain('GET /runs/'+run);
 }finally{await lock.close();daemon.stop(true);}
});

test('a takeover arriving during tool configuration prevents prompt dispatch atomically',async()=>{
 const id=await companion(),events:string[]=[];
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){events.push(req.method);return Response.json({ready:true});}});
 const lock=await leader();
 try{const run=await acceptMessage(owner,id,crypto.randomUUID(),'Work');await tick(lock.sql,{lifecycleMachines:machines(`http://127.0.0.1:${daemon.port}`,events,id),async prepareRun(){await db`UPDATE companions SET desktop_taken=true WHERE id=${id}`;}});
  expect(events).not.toContain('PUT');expect((await db`SELECT dispatched FROM runs WHERE id=${run}`)[0].dispatched).toBe(false);
 }finally{await lock.close();daemon.stop(true);}
});

test('final outbox is harvested after terminal observation before settlement',async()=>{
 const id=await companion(),run=await acceptMessage(owner,id,crypto.randomUUID(),'Return file');let completed=false,collected=false;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){completed=true;return Response.json({status:'succeeded',text:'Done'});}}),lock=await leader();
 try{await db`UPDATE companions SET endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${id}`;await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${run}`;
  await tick(lock.sql,{async observeRun(){expect(completed).toBe(false);},async beforeSettle(){expect(completed).toBe(true);expect((await db`SELECT status FROM runs WHERE id=${run}`)[0].status).toBe('running');collected=true;}});
  expect(collected).toBe(true);expect((await db`SELECT status FROM runs WHERE id=${run}`)[0].status).toBe('succeeded');
 }finally{await lock.close();daemon.stop(true);}
});

test('file durability requires a confirmed terminal request and a valid complete listing',async()=>{
 const id=await companion(),run=await acceptMessage(owner,id,crypto.randomUUID(),'Work');let mode='missing';
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const path=new URL(req.url).pathname;if(path.startsWith('/runs/'))return Response.json({status:mode==='running'?'running':'succeeded'});return mode==='missing'?new Response(null,{status:404}):Response.json({files:[]});}});
 try{
  await db`UPDATE companions SET endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${id}`;await db`UPDATE runs SET status='succeeded',dispatched=true WHERE id=${run}`;
  const input={id:run,companion_id:id};await expect(productHooks.lifecycle!.filesDurable!(input)).rejects.toThrow();
  mode='running';expect(await productHooks.lifecycle!.filesDurable!(input)).toBe(false);
  mode='terminal';expect(await productHooks.lifecycle!.filesDurable!(input)).toBe(true);
  await db`UPDATE companions SET desktop_taken=true WHERE id=${id}`;expect(await productHooks.lifecycle!.filesDurable!(input)).toBe(false);
 }finally{daemon.stop(true);}
});

test('preview and measured usage persist only on the response root with validated values',async()=>{
 const id=await companion(),root=await acceptMessage(owner,id,crypto.randomUUID(),'Root'),steer=await acceptMessage(owner,id,crypto.randomUUID(),'Steer'),lock=await leader();
 const usage={input:10,output:20,cacheRead:3,cacheWrite:4,totalTokens:37,costUsd:0.01};
 try{await persistObservation(lock.sql,{id:root,companion_id:id},{responseRootId:root,previewText:'Working',usage});await persistObservation(lock.sql,{id:steer,companion_id:id},{responseRootId:root,previewText:'Duplicate',usage});
  expect((await db`SELECT preview_text,usage FROM runs WHERE id=${root}`)[0]).toMatchObject({preview_text:'Working',usage});expect((await db`SELECT usage FROM runs WHERE id=${steer}`)[0].usage).toBeNull();
  await persistObservation(lock.sql,{id:root,companion_id:id},{usage:{...usage,costUsd:-5}});expect((await db`SELECT usage FROM runs WHERE id=${root}`)[0].usage).toEqual(usage);
 }finally{await lock.close();}
});

test('child file durability checks actual stored bytes, not only attachment metadata',async()=>{
 const id=await companion(),run=await acceptMessage(owner,id,crypto.randomUUID(),'Return file'),fileId=crypto.randomUUID();
 const bytes=Buffer.from('Durable child output'),sha256=(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');let stored=bytes;
 const object=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){return new Response(req.method==='HEAD'?null:stored,{headers:{'content-length':String(stored.length),'content-type':'text/plain'}});}});
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){return Response.json(new URL(req.url).pathname.startsWith('/runs/')?{status:'succeeded'}:{files:[{id:fileId,position:0,name:'result.txt',sha256,size:bytes.length}]});}});
 const env={S3_ENDPOINT:`http://127.0.0.1:${object.port}`,S3_ACCESS_KEY_ID:'fixture',S3_SECRET_ACCESS_KEY:'fixture-secret',S3_BUCKET_FILES:'lifecycle-fixtures'};
 const prior=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 try{
  await db`UPDATE companions SET endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${id}`;
  await db`UPDATE runs SET status='succeeded',dispatched=true WHERE id=${run}`;
  await db`INSERT INTO attachments(id,client_file_id,owner_id,companion_id,run_id,kind,position,filename,content_type,byte_size,sha256,storage_key) VALUES(${crypto.randomUUID()},${fileId},${owner},${id},${run},'agent_output',0,'result.txt','text/plain',${bytes.length},${sha256},'fixture-result')`;
  expect(await productHooks.lifecycle!.filesDurable!({id:run,companion_id:id})).toBe(true);
  stored=Buffer.from('Corrupt stored bytes');await expect(productHooks.lifecycle!.filesDurable!({id:run,companion_id:id})).rejects.toThrow('OUTBOX_STORAGE_INTEGRITY_FAILED');
 }finally{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}daemon.stop(true);object.stop(true);}
});
