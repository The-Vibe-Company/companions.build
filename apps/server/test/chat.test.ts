import {beforeAll,test,expect} from 'bun:test';
import {db,migrate,createCompanion,detail as exhaustiveDetail} from '../src/store';
import {handler} from '../src/api';
import {setMagicLinkDeliveryForTests} from '../src/auth';

type Actor={id:string;cookie:string};let alice:Actor,bob:Actor;
async function signIn():Promise<Actor>{
 let link='';setMagicLinkDeliveryForTests(message=>{link=message.url;});
 await handler(new Request('http://127.0.0.1:4310/api/auth/sign-in/magic-link',{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:4310'},body:JSON.stringify({email:`chat-${crypto.randomUUID()}@example.test`,callbackURL:'/'})}));
 const verified=await handler(new Request(link,{redirect:'manual'})),cookie=verified.headers.get('set-cookie')!.split(';')[0];
 const me=await handler(new Request('http://127.0.0.1:4310/api/me',{headers:{cookie}}));return {id:((await me.json()) as any).user.id,cookie};
}
beforeAll(async()=>{await migrate();alice=await signIn();bob=await signIn();});
async function companion(actor=alice){return (await createCompanion(actor.id,{name:'Chat pages',provider:'box',prepare:false})).id as string;}
const get=(actor:Actor|null,id:string,suffix='/chat')=>handler(new Request(`http://127.0.0.1:4310/api/companions/${id}${suffix}`,{headers:actor?{cookie:actor.cookie}:{}}));
async function ok(response:Response){expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');return await response.json() as any;}
async function run(id:string,at:string,status='succeeded',source='chat'){
 const runId=crypto.randomUUID();await db`INSERT INTO runs(id,companion_id,client_message_id,content,status,source,created_at) VALUES(${runId},${id},${crypto.randomUUID()},'work',${status},${source},${at}::timestamptz)`;return runId;
}

test('bounded traversal preserves the total microsecond order without gaps or duplicates',async()=>{
 const id=await companion(),runId=await run(id,'2026-09-01T00:00:00.000000Z');
 await db.unsafe(`INSERT INTO messages(id,companion_id,run_id,role,content,sequence,created_at)
  SELECT ('10000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,$1,$2,'assistant','message '||n,n,
   '2026-09-01T12:00:00Z'::timestamptz+(n%23)*interval '0.000001 seconds' FROM generate_series(1,1200)n`,[id,runId]);
 await db.unsafe(`INSERT INTO task_questions(id,companion_id,run_id,question,created_at)
  SELECT ('20000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,$1,$2,'question '||n,
   '2026-09-01T12:00:00Z'::timestamptz+(n%23)*interval '0.000001 seconds' FROM generate_series(1,1200)n`,[id,runId]);
 await db.unsafe(`INSERT INTO runs(id,companion_id,client_message_id,content,status,source,lane,thinking_text,created_at)
  SELECT ('40000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,$1,gen_random_uuid(),'thought','succeeded','chat','main','retained thought',
   '2026-09-01T12:00:00Z'::timestamptz+(n%23)*interval '0.000001 seconds' FROM generate_series(1,100)n`,[id]);
 const allEntries:any[]=[];
 const seen:string[]=[];let cursor:string|null=null,pages=0;
 do{const page=await ok(await get(alice,id,`/chat?limit=37${cursor?'&before='+encodeURIComponent(cursor):''}`));
  expect(page.entries.length).toBeLessThanOrEqual(37);expect(page.runs.length).toBeLessThanOrEqual(37);
  allEntries.unshift(...page.entries);
  expect(page.entries.every((entry:any)=>/\.\d{6}Z$/.test(entry.createdAt))).toBe(true);
  seen.push(...page.entries.map((entry:any)=>entry.kind+':'+entry.id));cursor=page.nextCursor;pages++;
 }while(cursor);
 expect(pages).toBeGreaterThan(50);expect(seen).toHaveLength(2500);expect(new Set(seen).size).toBe(2500);
 expect(allEntries).toEqual([...allEntries].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.sequence-b.sequence||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id)));
 const detail=await ok(await get(alice,id,''));expect(detail.chat.entries).toHaveLength(50);expect(detail.runs.length).toBeLessThanOrEqual(50);
 const pagedBytes=Buffer.byteLength(JSON.stringify(detail));
 const baseline=await exhaustiveDetail(alice.id,id);
 const baselineBytes=Buffer.byteLength(JSON.stringify({...baseline,questions:await db`SELECT * FROM task_questions WHERE companion_id=${id}`}));
 expect(pagedBytes).toBeLessThan(100_000);expect(pagedBytes).toBeLessThan(baselineBytes/5);
 console.log(JSON.stringify({fixture:'long-chat',entries:2500,initialEntries:50,baselineBytes,pagedBytes}));
});

test('around and inclusive range refresh use cursor sort keys even after the anchor is deleted',async()=>{
 const id=await companion(),runId=await run(id,'2026-09-02T00:00:00.000000Z');
 for(let sequence=1;sequence<=11;sequence++)await db`INSERT INTO messages(id,companion_id,run_id,role,content,sequence,created_at) VALUES(${crypto.randomUUID()},${id},${runId},'assistant',${'m'+sequence},${sequence},'2026-09-02T00:00:00.000001Z'::timestamptz)`;
 const all=await ok(await get(alice,id,'/chat?limit=50')),anchor=all.entries[5];
 await db`DELETE FROM messages WHERE id=${anchor.id}`;
 const around=await ok(await get(alice,id,`/chat?limit=5&around=${encodeURIComponent(anchor.cursor)}`));
 expect(around.entries.map((entry:any)=>entry.sequence)).toEqual([4,5,7,8,9]);
 const from=around.entries[1].cursor,through=around.entries[3].cursor;
 const bounded=await ok(await get(alice,id,`/chat?limit=2&from=${encodeURIComponent(from)}&through=${encodeURIComponent(through)}`));
 expect(bounded.entries.map((entry:any)=>entry.sequence)).toEqual([5,7]);expect(bounded.nextCursor).toBeTruthy();
 const continued=await ok(await get(alice,id,`/chat?after=${encodeURIComponent(bounded.nextCursor)}&from=${encodeURIComponent(from)}&through=${encodeURIComponent(through)}`));
 expect(continued.entries.map((entry:any)=>entry.sequence)).toEqual([8]);expect(continued.nextCursor).toBeNull();
});

test('pagination rejects malformed, conflicting and cross-Companion cursors with owner scoping',async()=>{
 const id=await companion(),other=await companion(),foreign=await companion(bob),runId=await run(id,'2026-09-03T00:00:00.000001Z');
 await db`INSERT INTO messages(id,companion_id,run_id,role,content) VALUES(${crypto.randomUUID()},${id},${runId},'user','hello')`;
 const cursor=(await ok(await get(alice,id,'/chat?limit=1'))).entries[0].cursor;
 expect((await get(null,id)).status).toBe(401);expect((await get(bob,id)).status).toBe(404);expect((await get(alice,foreign)).status).toBe(404);
 for(const query of ['limit=0','limit=51','before=','before=%%%','before='+cursor+'&after='+cursor,'around='+cursor+'&before='+cursor,'before='+cursor+'&before='+cursor,'limit=1.5','limit=1&limit=2','before='+('a'.repeat(513))])expect((await get(alice,id,'/chat?'+query)).status).toBe(400);
 expect((await get(alice,other,'/chat?before='+cursor)).status).toBe(400);
});

test('live state stays visible outside an old page and publication and file attribution use global history',async()=>{
 const id=await companion(),old=await run(id,'2025-01-01T00:00:00.000001Z','needs_input','background');
 const question=crypto.randomUUID();await db`INSERT INTO task_questions(id,companion_id,run_id,question,options,created_at) VALUES(${question},${id},${old},'Still needed?',${['Yes']},'2025-01-01T00:00:00.000002Z')`;
 const published=await run(id,'2025-01-02T00:00:00.000001Z','succeeded','background'),first=crypto.randomUUID(),last=crypto.randomUUID();
 await db`INSERT INTO messages(id,companion_id,run_id,role,content,sequence,created_at) VALUES(${first},${id},${published},'assistant','draft',1,'2025-01-02T00:00:00.000002Z'),(${last},${id},${published},'assistant','final',2,'2025-01-02T00:00:00.000003Z')`;
 const file=crypto.randomUUID();await db`INSERT INTO attachments(id,client_file_id,owner_id,companion_id,run_id,kind,position,filename,content_type,byte_size,sha256,storage_key) VALUES(${file},${crypto.randomUUID()},${alice.id},${id},${published},'agent_output',0,'answer.txt','text/plain',1,${'a'.repeat(64)},${'private/'+file})`;
 for(let n=0;n<60;n++){const current=await run(id,`2026-09-04T00:00:${String(n).padStart(2,'0')}.000001Z`);await db`INSERT INTO messages(id,companion_id,run_id,role,content) VALUES(${crypto.randomUUID()},${id},${current},'user',${'recent '+n})`;}
 const detail=await ok(await get(alice,id,''));
 expect(detail.live.runs.map((item:any)=>item.id)).toContain(old);expect(detail.live.questions.map((item:any)=>item.id)).toContain(question);
 const historical=await ok(await get(alice,id,`/chat?around=${encodeURIComponent((await ok(await get(alice,id,'/chat?limit=50'))).beforeCursor)}`));
 const messages=historical.messages.filter((message:any)=>message.runId===published);expect(messages.find((message:any)=>message.id===first)?.files).toEqual([]);
 expect(messages.find((message:any)=>message.id===last)?.files.map((item:any)=>item.id)).toEqual([file]);
 const lastEntry=historical.entries.find((entry:any)=>entry.id===last);
 const firstPage=await ok(await get(alice,id,`/chat?limit=1&before=${encodeURIComponent(lastEntry.cursor)}`));
 expect(firstPage.messages[0].id).toBe(first);expect(firstPage.messages[0].files).toEqual([]);
 const lastPage=await ok(await get(alice,id,`/chat?limit=1&after=${encodeURIComponent(firstPage.entries[0].cursor)}`));
 expect(lastPage.messages[0].files.map((item:any)=>item.id)).toEqual([file]);
 expect(historical.runs.find((item:any)=>item.id===published)).toMatchObject({hasPublishedMessage:true,hasQuestion:false});
 const observed=detail.live.questions.find((item:any)=>item.id===question);
 expect(observed.cursor).toBeTruthy();
 await db`UPDATE task_questions SET answer='Yes',answered_at=now() WHERE id=${question}`;
 const refreshed=await ok(await get(alice,id,''));expect(refreshed.live.questions.map((item:any)=>item.id)).not.toContain(question);
 const settled=await ok(await get(alice,id,`/chat?limit=1&around=${encodeURIComponent(observed.cursor)}`));
 expect(settled.questions).toMatchObject([{id:question,answer:'Yes'}]);

});
