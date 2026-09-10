import {beforeAll,afterEach,expect,test} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage,detail} from '../src/store';
import {acquireExecutor,tick,persistObservation} from '../src/executor';
import {migrateLifecycle,handleLifecycle,type LifecycleMachines} from '../src/lifecycle';
import {config,encrypt} from '../src/config';
import {productHooks} from '../src/runtime-product';
const owner='00000000-0000-4000-8000-000000000001',ids:string[]=[];
beforeAll(async()=>{await migrate();await migrateLifecycle();await db.unsafe('ALTER TABLE runs ADD COLUMN IF NOT EXISTS preview_text text; ALTER TABLE runs ADD COLUMN IF NOT EXISTS usage jsonb');});
afterEach(async()=>{for(const id of ids.splice(0)){await db`UPDATE companions SET retired_at=now(),prepare_requested=false,desktop_taken=false,desktop_paused_at=null WHERE id=${id}`;await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id} AND status IN ('queued','preparing','running','needs_input')`;}});
async function companion(){const c=await createCompanion(owner,{name:'Runtime lifecycle fixture',instructions:'',provider:'box'});ids.push(c.id);await db`UPDATE companions SET prepare_requested=false WHERE id=${c.id}`;return c.id as string;}
async function leader(){const sql=await acquireExecutor();if(!sql)throw Error('Test executor missing');return {sql,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};}
function machines(endpoint:string,events:string[],companionId:string):LifecycleMachines{return {async prepare(c,checkpoint){if(c.id!==companionId)return null;events.push('prepare '+(c.snapshot_name??'base'));await checkpoint('fixture-box');return endpoint;},async health(){events.push('health');return {ready:true,desktopBoundaryVersion:1};},async pause(c,taken){events.push('pause '+taken);return {generation:Number(c.desktop_generation),taken,confirmed:true,bootId:'fixture'};},async archive(){events.push('archive');return true;},async snapshot(){events.push('snapshot');},async snapshotStatus(){return 'pending';}};}

test('managed image publication can exceed five minutes before the same run prepares and dispatches',async()=>{
 const id=await companion(),events:string[]=[];let imageReady=false,puts=0,run='';
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const path=new URL(req.url).pathname;if(req.method==='PUT'){puts++;expect(path).toBe('/runs/'+run);}return Response.json(path==='/health'?{ready:true,activeRuns:{main:null,background:null}}:{status:'running'});}});
 const fake=machines(`http://127.0.0.1:${daemon.port}`,events,id);fake.preparationReady=async()=>imageReady;
 const lock=await leader();
 try{
  run=(await acceptMessage(owner,id,crypto.randomUUID(),'Wait for the managed image'))!;
  await tick(lock.sql,{lifecycleMachines:fake});
  await db`UPDATE runs SET started_at=now()-interval '3 hours' WHERE id=${run}`;
  await tick(lock.sql,{lifecycleMachines:fake});
  expect((await db`SELECT status,dispatched,prepared_at FROM runs WHERE id=${run}`)[0]).toMatchObject({status:'preparing',dispatched:false,prepared_at:null});
  expect((await db`SELECT preparation_started_at FROM companions WHERE id=${id}`)[0].preparation_started_at).toBeNull();
  imageReady=true;await tick(lock.sql,{lifecycleMachines:fake});
  expect(puts).toBe(1);
  expect((await db`SELECT id,status,dispatched,prepared_at FROM runs WHERE id=${run}`)[0]).toMatchObject({id:run,status:'running',dispatched:true,prepared_at:expect.any(Date)});
  await tick(lock.sql,{lifecycleMachines:fake});
  expect((await db`SELECT status FROM runs WHERE id=${run}`)[0].status).toBe('running');
 }finally{await lock.close();daemon.stop(true);}
});

test('post-ready run preparation still expires from its persisted preparation clock',async()=>{
 const id=await companion(),events:string[]=[];let requests=0;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){requests++;return Response.json({ready:true});}}),lock=await leader();
 try{
  await db`UPDATE companions SET status='ready',prepare_requested=false,box_id='ready-box',endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)},ready_at=now() WHERE id=${id}`;
  const run=await acceptMessage(owner,id,crypto.randomUUID(),'Bound post-ready work');
  await db`UPDATE runs SET status='preparing',started_at=now()-interval '10 minutes',prepared_at=now()-interval '6 minutes' WHERE id=${run}`;
  await tick(lock.sql,{lifecycleMachines:machines(`http://127.0.0.1:${daemon.port}`,events,id)});
  expect(requests).toBe(0);
  expect((await db`SELECT status,dispatched,error FROM runs WHERE id=${run}`)[0]).toMatchObject({status:'failed',dispatched:false,error:'Preparation timed out. Send a new message to retry.'});
 }finally{await lock.close();daemon.stop(true);}
});

test('executor prepares the pinned snapshot and continues admission and observation during GUI takeover',async()=>{
 const id=await companion(),events:string[]=[];let puts=0,submittedModel:string|undefined;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){events.push(req.method+' '+new URL(req.url).pathname);if(req.method==='PUT'){puts++;submittedModel=(await req.json() as any).modelId;}return Response.json(new URL(req.url).pathname==='/health'?{ready:true,activeRuns:{main:null,background:null}}:{status:'running'});}});
 const endpoint=`http://127.0.0.1:${daemon.port}`,fake=machines(endpoint,events,id),lock=await leader();
 try{
  await db`UPDATE companions SET model_id='fixture-model',snapshot_name='private-pinned-template',template_id=${crypto.randomUUID()} WHERE id=${id}`;
  const run=await acceptMessage(owner,id,crypto.randomUUID(),'Work');await tick(lock.sql,{lifecycleMachines:fake});
  expect(events[0]).toBe('prepare private-pinned-template');expect(puts).toBe(1);expect(submittedModel).toBe('fixture-model');
  await handleLifecycle({operation:'desktop_takeover',companionId:id},owner);events.length=0;
  const queued=await acceptMessage(owner,id,crypto.randomUUID(),'Queue during takeover');await tick(lock.sql,{lifecycleMachines:fake});
  expect(events).toContain('pause true');expect(events).toContain('GET /runs/'+run);expect((await db`SELECT status FROM runs WHERE id=${queued}`)[0].status).toBe('running');
  events.length=0;await tick(lock.sql,{lifecycleMachines:fake});expect(events).toContain('GET /runs/'+run);
  await handleLifecycle({operation:'desktop_release',companionId:id},owner);events.length=0;await tick(lock.sql,{lifecycleMachines:fake});
  expect(events[0]).toBe('pause false');expect(events).toContain('GET /runs/'+run);
 }finally{await lock.close();daemon.stop(true);}
});

test('GUI takeover arriving during tool configuration still permits headless prompt dispatch',async()=>{
 const id=await companion(),events:string[]=[];
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){events.push(req.method);return Response.json({ready:true});}});
 const lock=await leader();
 try{const run=await acceptMessage(owner,id,crypto.randomUUID(),'Work');await tick(lock.sql,{lifecycleMachines:machines(`http://127.0.0.1:${daemon.port}`,events,id),async prepareRun(){await db`UPDATE companions SET desktop_taken=true WHERE id=${id}`;}});
  expect(events).toContain('PUT');expect((await db`SELECT dispatched FROM runs WHERE id=${run}`)[0].dispatched).toBe(true);
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
  await db`UPDATE companions SET desktop_taken=true WHERE id=${id}`;expect(await productHooks.lifecycle!.filesDurable!(input)).toBe(true);
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


test('assistant messages survive polling, stale observations and settlement without duplicate final answers',async()=>{
 const id=await companion(),root=await acceptMessage(owner,id,crypto.randomUUID(),'Design together'),lock=await leader();
 const started=new Date(Date.now()+1).toISOString();
 const first={sequence:1,text:'I found two directions.',createdAt:started,complete:true};
 const partial={sequence:2,text:'Here is',createdAt:new Date(Date.now()+2).toISOString(),complete:false};
 let observed:any={responseRootId:root,status:'running',messageVersion:2,messages:[first,partial]};
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return Response.json(observed);}});
 try{
  await db`UPDATE companions SET endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${id}`;
  await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${root}`;
  await tick(lock.sql);await tick(lock.sql);
  let messages=(await detail(owner,id))!.messages.filter((m:any)=>m.role==='assistant');
  expect(messages.map((m:any)=>m.content)).toEqual([first.text,partial.text]);
  const stableIds=messages.map((m:any)=>m.id);
  const final={...partial,text:'Here is the agreed design.',complete:true};
  observed={...observed,status:'succeeded',text:final.text,messageVersion:3,messages:[first,final]};
  await tick(lock.sql);await tick(lock.sql);
  await persistObservation(lock.sql,{id:root,companion_id:id},{messageVersion:2,messages:[first,partial]});
  messages=(await detail(owner,id))!.messages.filter((m:any)=>m.role==='assistant');
  expect(messages.map((m:any)=>m.id)).toEqual(stableIds);
  expect(messages.map((m:any)=>m.content)).toEqual([first.text,final.text]);
  expect(messages.every((m:any)=>m.complete)).toBe(true);
  expect((await detail(owner,id))!.runs[0].status).toBe('succeeded');
 }finally{await lock.close();daemon.stop(true);}
});

test('interrupted and cancelled replies retain partial messages, while background and steering histories stay isolated',async()=>{
 const id=await companion(),root=await acceptMessage(owner,id,crypto.randomUUID(),'Root'),steer=await acceptMessage(owner,id,crypto.randomUUID(),'Steer'),lock=await leader();
 const message={sequence:1,text:'Visible before interruption',createdAt:new Date().toISOString(),complete:false};
 try{
  await persistObservation(lock.sql,{id:root,companion_id:id},{messageVersion:1,messages:[message]});
  await persistObservation(lock.sql,{id:steer,companion_id:id},{responseRootId:root,messageVersion:2,messages:[{...message,text:'Duplicate sibling'}]});
  await db`UPDATE runs SET status='interrupted' WHERE id=${root}`;
  expect((await detail(owner,id))!.messages.filter((m:any)=>m.role==='assistant').map((m:any)=>m.content)).toEqual([message.text]);
  const background=await acceptMessage(owner,id,crypto.randomUUID(),'Private background');
  await db`UPDATE runs SET lane='background' WHERE id=${background}`;
  await persistObservation(lock.sql,{id:background,companion_id:id},{messageVersion:1,messages:[{...message,text:'Private background update'}]});
  expect(await db`SELECT id FROM messages WHERE run_id=${background} AND role='assistant'`).toHaveLength(0);
  const cancelled=await acceptMessage(owner,id,crypto.randomUUID(),'Cancel me');
  await persistObservation(lock.sql,{id:cancelled,companion_id:id},{messageVersion:1,messages:[message]});
  await db`UPDATE runs SET status='cancelled' WHERE id=${cancelled}`;
  expect((await db`SELECT content FROM messages WHERE run_id=${cancelled} AND role='assistant'`)[0].content).toBe(message.text);
  await lock.sql`SELECT pg_advisory_unlock(721440139)`;
  await persistObservation(lock.sql,{id:root,companion_id:id},{messageVersion:3,messages:[{...message,text:'Former leader'}]});
  expect((await db`SELECT content FROM messages WHERE run_id=${root} AND role='assistant'`)[0].content).toBe(message.text);
 }finally{await lock.close();}
});


test('Fast persists the real provider before dispatch while existing agents receive their Responses profile',async()=>{
 const previous={testMode:config.testMode,modelProvider:config.modelProvider,modelId:config.modelId,modelGatewayUrl:config.modelGatewayUrl};
 const id=await companion(),events:string[]=[];let puts=0;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  if(req.method==='PUT'){
   puts++;const body=await req.json() as any;
   const [persisted]=await db`SELECT model_provider,model_id,dispatched FROM runs WHERE companion_id=${id} ORDER BY created_at DESC LIMIT 1`;
   expect(persisted).toMatchObject({model_provider:'deepseek',model_id:'deepseek-flash',dispatched:true});
   expect(body.modelId).toBe('gpt-5.6-sol');expect(body.modelGateway.token).toBeString();
  }
  return Response.json(new URL(req.url).pathname==='/health'?{ready:true,activeRuns:{main:null,background:null}}:{status:'running'});
 }}),lock=await leader();
 try{
  Object.assign(config,{testMode:false,modelProvider:'azure',modelId:'gpt-5.6-luna',modelGatewayUrl:'https://fixture.invalid/api/model-gateway'});
  await db`UPDATE companions SET model_id='deepseek-flash' WHERE id=${id}`;
  await acceptMessage(owner,id,crypto.randomUUID(),'Fast request');
  await tick(lock.sql,{lifecycleMachines:machines(`http://127.0.0.1:${daemon.port}`,events,id),canStartWork:async()=>true});
  expect(puts).toBe(1);
 }finally{Object.assign(config,previous);await lock.close();daemon.stop(true);}
});
