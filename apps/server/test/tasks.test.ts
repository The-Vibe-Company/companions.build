import {beforeAll,test,expect} from 'bun:test';
import {db,migrate,createCompanion} from '../src/store';
import {handler} from '../src/api';
import {setMagicLinkDeliveryForTests} from '../src/auth';
import {cancelTask} from '../src/tasks';
import {handoffDelegationFiles} from '../src/files';

type Actor={id:string;cookie:string};
let alice:Actor,bob:Actor;
async function signIn():Promise<Actor>{
 let link='';setMagicLinkDeliveryForTests(message=>{link=message.url;});
 expect((await handler(new Request('http://127.0.0.1:4310/api/auth/sign-in/magic-link',{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:4310'},body:JSON.stringify({email:`tasks-${crypto.randomUUID()}@example.test`,callbackURL:'/'})}))).status).toBe(200);
 const verified=await handler(new Request(link,{redirect:'manual'})),cookie=verified.headers.get('set-cookie')!.split(';')[0];
 const me=await handler(new Request('http://127.0.0.1:4310/api/me',{headers:{cookie}}));return {cookie,id:(await me.json() as any).user.id};
}
beforeAll(async()=>{await migrate();alice=await signIn();bob=await signIn();});
async function companion(actor=alice){return (await createCompanion(actor.id,{name:'Activity fixture',provider:'box',prepare:false})).id as string;}
async function task(companionId:string,options:{status?:string;lane?:string;source?:string;content?:string;createdAt?:string}={}){
 const id=crypto.randomUUID();await db`INSERT INTO runs(id,companion_id,client_message_id,status,lane,source,content,created_at)
 VALUES(${id},${companionId},${crypto.randomUUID()},${options.status??'queued'},${options.lane??'main'},${options.source??'chat'},${options.content??'Task brief'},${options.createdAt??new Date().toISOString()}::timestamptz)`;return id;
}
const request=(actor:Actor|null,companionId:string,suffix='',method='GET')=>handler(new Request(`http://127.0.0.1:4310/api/companions/${companionId}/tasks${suffix}`,{method,headers:actor?{cookie:actor.cookie}:{}}));
const body=async(response:Response)=>{expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');return await response.json() as any;};

test('tasks API authenticates and scopes every list, detail and cancellation to owner and Companion',async()=>{
 const own=await companion(),other=await companion(),foreign=await companion(bob),ownTask=await task(own),otherTask=await task(other),foreignTask=await task(foreign);
 for(const [actor,id,suffix,method,status] of [
  [null,own,'','GET',401],[null,own,`/${ownTask}`,'GET',401],[null,own,`/${ownTask}/cancel`,'POST',401],
  [bob,own,'','GET',404],[bob,own,`/${ownTask}`,'GET',404],[bob,own,`/${ownTask}/cancel`,'POST',404],
  [alice,own,`/${otherTask}`,'GET',404],[alice,own,`/${otherTask}/cancel`,'POST',404],
  [alice,own,`/${foreignTask}`,'GET',404],[alice,own,`/${foreignTask}/cancel`,'POST',404],
 ] as const)expect((await request(actor,id,suffix,method)).status).toBe(status);
 const listed=await body(await request(alice,own));expect(listed.tasks.map((t:any)=>t.id)).toEqual([ownTask]);expect(listed.nextCursor).toBeNull();
 expect((await request(alice,own,'','POST')).status).toBe(405);
 expect((await request(alice,own,`/${ownTask}/cancel`,'GET')).status).toBe(405);
 expect((await request(alice,'invalid')).status).toBe(400);
});

test('cursor pagination preserves timestamp microseconds, ties and stable boundaries during new admission',async()=>{
 const id=await companion();
 for(let i=0;i<23;i++)await task(id,{createdAt:`2026-09-07T00:00:00.${i<10?'000001':'000002'}Z`,content:i===22?'é'.repeat(200):'Brief '+i,lane:i%2?'main':'background',source:i%2?'chat':'routine'});
 const expected=(await db`SELECT id FROM runs WHERE companion_id=${id} ORDER BY created_at DESC,id DESC`).map((r:any)=>r.id);
 const defaults=await body(await request(alice,id));expect(defaults.tasks).toHaveLength(20);expect(defaults.nextCursor).toBeTruthy();
 let page=await body(await request(alice,id,'?limit=2')),cursor=page.nextCursor;const seen=page.tasks.map((t:any)=>t.id);
 expect(Object.keys(page.tasks[0]).sort()).toEqual(['id','status','lane','source','createdAt','finishedAt','title','routineId','routineName','publicationMode','scheduledFor'].sort());
 await task(id,{createdAt:'2026-09-08T00:00:00.000001Z'});
 while(cursor){page=await body(await request(alice,id,'?limit=2&before='+cursor));seen.push(...page.tasks.map((t:any)=>t.id));cursor=page.nextCursor;}
 expect(seen).toEqual(expected);expect(new Set(seen).size).toBe(23);
 expect((await body(await request(alice,id,'?limit=50'))).tasks.every((t:any)=>Array.from(t.title).length<=120)).toBe(true);
 const empty=await body(await request(alice,await companion()));expect(empty).toEqual({tasks:[],nextCursor:null});
});

test('invalid, oversized and cross-Companion pagination is rejected',async()=>{
 const id=await companion(),other=await companion();await task(id);await task(id);
 const cursor=(await body(await request(alice,id,'?limit=1'))).nextCursor;
 for(const query of ['limit=0','limit=51','limit=-1','limit=1.5','limit=no','limit=1&limit=2','before=','before=%%%','before='+('a'.repeat(513)),'before='+Buffer.from(JSON.stringify({v:1,companionId:id,time:'2026-02-30T00:00:00.000001Z',id:crypto.randomUUID()})).toString('base64url')])expect((await request(alice,id,'?'+query)).status).toBe(400);
 expect((await request(alice,other,'?before='+cursor)).status).toBe(400);
 expect((await request(alice,id,'?before='+cursor+'&before='+cursor)).status).toBe(400);
});

async function attachment(actor:Actor,companionId:string,runId:string,kind:'user_upload'|'agent_output',name:string){
 const id=crypto.randomUUID();await db`INSERT INTO attachments(id,client_file_id,owner_id,companion_id,run_id,kind,position,filename,content_type,byte_size,sha256,storage_key)
 VALUES(${id},${crypto.randomUUID()},${actor.id},${companionId},${runId},${kind},0,${name},'text/plain',7,${'a'.repeat(64)},${'private/'+id})`;return id;
}
test('detail includes only this task inputs, outputs and authorized retained handoffs without storage secrets',async()=>{
 const parent=await companion(),child=await companion(),foreign=await companion(bob),run=await task(parent),sibling=await task(parent),childRun=await task(child,{status:'succeeded'}),foreignRun=await task(foreign);
 const input=await attachment(alice,parent,run,'user_upload','input.txt'),output=await attachment(alice,parent,run,'agent_output','output.txt'),retained=await attachment(alice,child,childRun,'agent_output','retained.txt');
 await attachment(alice,parent,sibling,'agent_output','sibling.txt');await attachment(bob,foreign,foreignRun,'agent_output','foreign.txt');
 await db`UPDATE runs SET source='delegation',lane='background',result_text='Result',error='Stable failure',started_at=now(),prepared_at=now(),publish_to_chat=true WHERE id=${run}`;
 const delegation=crypto.randomUUID();await db`INSERT INTO delegations(id,parent_id,target_id,run_id,returned_run_id,files_saved_at) VALUES(${delegation},${parent},${child},${childRun},${run},now())`;
 await handoffDelegationFiles(alice.id,delegation,run);
 const detail=await body(await request(alice,parent,`/${run}`));
 expect(detail.task).toMatchObject({id:run,content:'Task brief',resultText:'Result',error:'Stable failure',cancelRequested:false,publishToChat:true,startedAt:expect.any(String),preparedAt:expect.any(String)});
 expect(detail.files.map((f:any)=>f.id).sort()).toEqual([input,output,retained].sort());
 expect(detail.files.every((f:any)=>f.runId===run)).toBe(true);
 expect(detail.files.find((f:any)=>f.id===retained).url).toBe(`/api/companions/${child}/files/${retained}`);
 expect(JSON.stringify(detail)).not.toContain('storageKey');expect(JSON.stringify(detail)).not.toContain('sha256');
 await db`UPDATE companions SET retired_at=now(),archive_requested_at=now() WHERE id=${parent}`;
 expect((await body(await request(alice,parent,`/${run}`))).files).toHaveLength(3);
 expect((await request(alice,parent,`/${run}/cancel`,'POST')).status).toBe(404);
 expect((await body(await request(alice,parent))).tasks).toHaveLength(2);
});

test('cancellation targets one task, persists active intent and leaves terminal tasks exactly unchanged',async()=>{
 const id=await companion();const unaffected=await task(id,{lane:'background',source:'trigger'});
 for(const status of ['queued','preparing','running','needs_input','succeeded','failed','interrupted','cancelled']){
  const run=await task(id,{status,lane:['preparing','running','needs_input'].includes(status)?'background':'main'});
  if(status!=='queued')await db`UPDATE runs SET dispatched=true,finished_at=${['succeeded','failed','interrupted','cancelled'].includes(status)?new Date('2026-09-01'):null} WHERE id=${run}`;
  const before=(await db`SELECT * FROM runs WHERE id=${run}`)[0];
  const result=await body(await request(alice,id,`/${run}/cancel`,'POST'));
  if(['succeeded','failed','interrupted','cancelled'].includes(status))expect((await db`SELECT * FROM runs WHERE id=${run}`)[0]).toEqual(before);
  else expect(result.task).toMatchObject({id:run,status:status==='queued'?'cancelled':status,cancelRequested:true});
  expect((await body(await request(alice,id,`/${run}/cancel`,'POST'))).task).toEqual(result.task);
  if(['preparing','running','needs_input'].includes(status))await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE id=${run}`;
 }
 expect((await db`SELECT status,cancel_requested FROM runs WHERE id=${unaffected}`)[0]).toMatchObject({status:'queued',cancel_requested:false});
 await db`UPDATE companions SET archive_requested_at=now() WHERE id=${id}`;
 expect((await request(alice,id,`/${unaffected}/cancel`,'POST')).status).toBe(404);
});

test('a cancellation waiting behind terminal settlement does not overwrite the settled task',async()=>{
 const id=await companion(),run=await task(id,{status:'running'});let ready!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>ready=r),hold=new Promise<void>(r=>release=r);
 const settling=db.begin(async tx=>{await tx`UPDATE runs SET status='succeeded',result_text='Finished once',finished_at=now() WHERE id=${run}`;ready();await hold;});
 await entered;const connection=await db.reserve();const [{pid}]=await connection`SELECT pg_backend_pid() AS pid`;
 const cancelling=cancelTask(alice.id,id,run,connection);void cancelling.catch(()=>{});
 try{
  let blocked=false;const deadline=Date.now()+3000;
  while(Date.now()<deadline){blocked=(await db`SELECT cardinality(pg_blocking_pids(${pid}))>0 AS blocked`)[0].blocked;if(blocked)break;await Bun.sleep(5);}
  expect(blocked).toBe(true);release();await settling;
  expect(await cancelling).toMatchObject({id:run,status:'succeeded',resultText:'Finished once',cancelRequested:false});
  expect((await db`SELECT count(*)::int AS count FROM runs WHERE companion_id=${id}`)[0].count).toBe(1);
 }finally{release();await Promise.allSettled([settling,cancelling]);connection.release();}
});

test('a dispatched main task cannot independently cancel its shared native response',async()=>{
 const id=await companion(),root=await task(id,{status:'running'}),steer=await task(id,{status:'running'}),queued=await task(id);
 await db`UPDATE runs SET dispatched=true,response_root_id=${root} WHERE id IN (${root},${steer})`;
 const before=await db`SELECT * FROM runs WHERE companion_id=${id} ORDER BY id`;
 for(const run of [root,steer]){
  const response=await request(alice,id,`/${run}/cancel`,'POST');
  expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'Stop the current response from chat.'});
 }
 expect(await db`SELECT * FROM runs WHERE companion_id=${id} ORDER BY id`).toEqual(before);
 expect((await body(await request(alice,id,`/${queued}/cancel`,'POST'))).task).toMatchObject({status:'cancelled',cancelRequested:true});
 const preparing=await task(id,{status:'preparing'});
 expect((await body(await request(alice,id,`/${preparing}/cancel`,'POST'))).task).toMatchObject({status:'preparing',cancelRequested:true});
 expect((await db`SELECT status,cancel_requested FROM runs WHERE id=${steer}`)[0]).toMatchObject({status:'running',cancel_requested:false});
});
