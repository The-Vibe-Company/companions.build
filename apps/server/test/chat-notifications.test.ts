import {beforeAll,expect,test} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage,detail} from '../src/store';
import {handleNotifications} from '../src/notifications';
import {handleAutomations} from '../src/automation-routes';
import {acquireExecutor,persistObservation} from '../src/executor';
import {applyControl} from '../src/control';
const owner='00000000-0000-4000-8000-000000000001';
beforeAll(()=>migrate());
async function fixture(){const c=await createCompanion(owner,{name:'Notifications',instructions:'',provider:'local',prepare:false});return c.id as string;}
async function run(c:string,status='running'){
 const id=crypto.randomUUID();await db`INSERT INTO runs(id,companion_id,client_message_id,content,lane,source,routine_name,status) VALUES(${id},${c},${id},'Check','background','routine','Daily check',${status})`;return id;
}
async function request(c:string,suffix='',method='GET',body?:unknown,actor=owner){return (await handleNotifications(new Request(`http://local/api/companions/${c}/notifications${suffix}`,{method,...(body?{body:JSON.stringify(body)}:{})}),actor))!;}
async function summary(c:string){const r=await handleNotifications(new Request('http://local/api/notifications/summary'),owner);return (await r!.json()).companions.find((x:any)=>x.companionId===c);}
test('silent activity stays silent; publications and failures persist once with paginated owner-scoped unread state',async()=>{
 const c=await fixture();await run(c,'succeeded');expect((await (await request(c)).json()).notifications).toHaveLength(0);
 const r=await run(c,'succeeded'),message=crypto.randomUUID();
 await db`INSERT INTO messages(id,companion_id,run_id,role,content) VALUES(${message},${c},${r},'assistant','Report ready')`;
 const failed=await run(c,'failed');await db`UPDATE runs SET status='failed' WHERE id=${failed}`;
 expect(await summary(c)).toMatchObject({unread:2,needsInput:0});
 const first=await (await request(c,'?limit=1')).json();expect(first.notifications).toHaveLength(1);expect(first.nextCursor).toBeString();
 const second=await (await request(c,`?limit=1&cursor=${first.nextCursor}`)).json();expect(second.notifications).toHaveLength(1);expect(second.nextCursor).toBeNull();
 expect(first.notifications[0].id).not.toBe(second.notifications[0].id);
 const notification=second.notifications[0];expect((await request(c,`/${notification.id}/read`,'POST')).status).toBe(200);
 await request(c,`/${notification.id}/read`,'POST');expect(await summary(c)).toMatchObject({unread:1});
 expect((await request(c,'','GET',undefined,crypto.randomUUID())).status).toBe(404);
 expect((await request(c,`/${notification.id}/read`,'POST',undefined,crypto.randomUUID())).status).toBe(404);
 expect((await request(c,'?cursor=invalid')).status).toBe(400);
 // Migration retry preserves live unread state and rollback's original message.
 await db.unsafe(await Bun.file(new URL('../src/chat-notifications.sql',import.meta.url)).text());
 expect(await summary(c)).toMatchObject({unread:1});expect((await db`SELECT content FROM messages WHERE id=${message}`)[0].content).toBe('Report ready');
});
test('reading a question does not resolve it; cancellation removes actionable status and rejects replies',async()=>{
 const c=await fixture(),r=await run(c,'needs_input'),q=crypto.randomUUID();
 await db`INSERT INTO task_questions(id,companion_id,run_id,question,options) VALUES(${q},${c},${r},'Choose a report','[]')`;
 const n=(await (await request(c)).json()).notifications[0];expect(n).toMatchObject({kind:'question',actionable:true,questionId:q});
 await request(c,`/${n.id}/read`,'POST');expect(await summary(c)).toMatchObject({unread:0,needsInput:1});
 await db`UPDATE runs SET cancel_requested=true WHERE id=${r}`;
 expect(await summary(c)).toMatchObject({needsInput:0});
 const response=await handleAutomations(new Request(`http://local/api/companions/${c}/questions/${q}/answer`,{method:'POST',body:JSON.stringify({answer:'yes'})}),owner);
 expect(response!.status).toBe(409);expect((await db`SELECT answer FROM task_questions WHERE id=${q}`)[0].answer).toBeNull();
 expect((await (await request(c)).json()).notifications[0]).toMatchObject({actionable:false,question:{runStatus:'cancelled'}});
});
test('snapshot events keep source order, safe details and positions through stale observations, late steers and restart',async()=>{
 const c=await fixture(),r=(await acceptMessage(owner,c,crypto.randomUUID(),'Investigate'))!;
 const lock=await acquireExecutor();if(!lock)throw Error('No executor lease');
 const createdAt=new Date().toISOString();const message={sequence:1,order:2,text:'Checking Linear',createdAt,complete:true};
 const events=[{sequence:1,kind:'thinking',createdAt,text:'Check the relevant issues'},
  {sequence:3,kind:'tool',createdAt,toolName:'search_issues',application:{name:'Linear',provider:'linear'},status:'running',arguments:{token:'private-fixture'},result:'provider-payload'}];
 try{
  await persistObservation(lock,{id:r,companion_id:c},{messageVersion:1,messages:[message],events});
  const before=await db`SELECT position::text,kind,status FROM chat_events WHERE run_id=${r} ORDER BY chat_events.position`;
  const [m]=await db`SELECT position::text FROM messages WHERE run_id=${r} AND role='assistant'`;
  expect(BigInt(before[0].position)<BigInt(m.position)&&BigInt(m.position)<BigInt(before[1].position)).toBe(true);
  await acceptMessage(owner,c,crypto.randomUUID(),'Only open issues');
  await persistObservation(lock,{id:r,companion_id:c},{messageVersion:2,messages:[message,{sequence:2,order:5,text:'Done',createdAt,complete:true}],events:[events[0],{...events[1],status:'failed'},{sequence:4,kind:'thinking',text:'Check conclusion',createdAt}]});
  await persistObservation(lock,{id:r,companion_id:c},{messageVersion:1,messages:[{...message,text:'stale'}],events});
  const after=await db`SELECT position::text,kind,status FROM chat_events WHERE run_id=${r} ORDER BY chat_events.position`;
  expect(after.slice(0,2).map((x:any)=>x.position)).toEqual(before.map((x:any)=>x.position));expect(after[1].status).toBe('failed');
  const stored=await db`SELECT * FROM chat_events WHERE run_id=${r}`;
  expect(JSON.stringify(stored)).not.toContain('private-fixture');expect(JSON.stringify(stored)).not.toContain('provider-payload');
  expect((await detail(owner,c))!.messages.filter((x:any)=>x.role==='assistant').map((x:any)=>x.content)).toEqual(['Checking Linear','Done']);
 }finally{await lock`SELECT pg_advisory_unlock(721440139)`;lock.release();}
});
test('routine-to-agent admission reuses durable native chat requests and never mistakes a human publication for steering',async()=>{
 const c=await fixture(),r=await run(c),command=crypto.randomUUID();
 const input={id:command,runId:r,operation:'notify_agent',input:{text:'Investigate the routine finding'}};
 const accepted=await applyControl(c,input) as any;expect(accepted.status).toBe('accepted');
 expect(await applyControl(c,input)).toEqual(accepted);
 const [admitted]=await db`SELECT lane,source,client_message_id FROM runs WHERE id=${accepted.runId}`;
 expect(admitted).toMatchObject({lane:'main',source:'chat',client_message_id:command});
 expect((await db`SELECT source,source_name,role FROM messages WHERE run_id=${accepted.runId}`)[0]).toMatchObject({source:'routine_agent',source_name:'Daily check',role:'user'});
 expect((await (await request(c)).json()).notifications).toHaveLength(0);
 const main=await acceptMessage(owner,c,crypto.randomUUID(),'Hello');await db`UPDATE runs SET status='running' WHERE id=${main}`;
 const rejected=await applyControl(c,{...input,id:crypto.randomUUID(),runId:main}) as any;expect(rejected.error).toBeString();
});

test('legacy backfill preserves messages and keeps unanswered questions actionable without flooding unread results',async()=>{
 const c=await fixture(),r=await run(c,'succeeded'),m=crypto.randomUUID();
 await db`INSERT INTO messages(id,companion_id,run_id,role,content) VALUES(${m},${c},${r},'assistant','Historic report')`;
 const waiting=await run(c,'needs_input'),q=crypto.randomUUID();
 await db`INSERT INTO task_questions(id,companion_id,run_id,question,options) VALUES(${q},${c},${waiting},'Historic question','[]')`;
 // Remove only this fixture projection to represent pre-migration source rows.
 await db`DELETE FROM routine_notifications WHERE companion_id=${c}`;
 await db.unsafe(await Bun.file(new URL('../src/chat-notifications.sql',import.meta.url)).text());
 expect(await summary(c)).toMatchObject({unread:0,needsInput:1});
 const page=await (await request(c)).json();expect(page.notifications).toHaveLength(2);
 expect(page.notifications.find((n:any)=>n.kind==='result').text).toBe('Historic report');
 expect((await db`SELECT content FROM messages WHERE id=${m}`)[0].content).toBe('Historic report');
 // A subsequent occurrence is independently unread, even when the old one was read.
 await run(c,'failed');expect(await summary(c)).toMatchObject({unread:1,needsInput:1});
});
