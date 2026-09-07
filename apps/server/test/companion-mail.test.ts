import {beforeAll,beforeEach,expect,test} from 'bun:test';
import {createHmac} from 'node:crypto';
import {db,migrate,createCompanion} from '../src/store';
import {approveMailDraft,claimMailSend,createMailDraft,handleCompanionMail,handleCompanionMailWebhook,tickCompanionMail,validateMailDraft,verifyMailWebhook} from '../src/companion-mail';
const owner='00000000-0000-4000-8000-000000000001';
let companionId:string;
const secret=`whsec_${Buffer.from('test-webhook-secret').toString('base64')}`;
function signed(event:unknown){const body=JSON.stringify(event),timestamp=String(Math.floor(Date.now()/1000)),id=crypto.randomUUID();const signature=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');return new Request('http://localhost/api/webhooks/resend',{method:'POST',headers:{'svix-id':id,'svix-timestamp':timestamp,'svix-signature':`v1,${signature}`},body});}
async function request(path:string,method='GET',value?:unknown){return handleCompanionMail(new Request(`http://localhost${path}`,{method,...(value?{headers:{'content-type':'application/json'},body:JSON.stringify(value)}:{})}),owner);}
async function draft(to=['paul@example.com']){return createMailDraft(companionId,{clientId:crypto.randomUUID(),to,subject:'Document',text:'Hello Paul'},{kind:'owner'});}
beforeAll(async()=>{await migrate();await db.unsafe(await Bun.file(new URL('../src/companion-mail.sql',import.meta.url)).text());process.env.RESEND_WEBHOOK_SECRET=secret;await request('/api/mail/account','PUT',{alias:'mail-test'});});
beforeEach(async()=>{
 await db`UPDATE companion_mail_messages SET state='cancelled' WHERE state IN ('queued','draft','ready','received','fetching','quota_exceeded')`;
 await db`DELETE FROM companion_mail_quota`;
 companionId=(await createCompanion(owner,{name:'Mail fixture',provider:'local'})).id;
 await request(`/api/companions/${companionId}/mail`,'PUT',{localName:`mail-${crypto.randomUUID().slice(0,8)}`});
});
test('aliases and mailbox addresses cannot be changed or reused',async()=>{
 expect((await request('/api/mail/account','PUT',{alias:'changed'}))!.status).toBe(409);
 expect((await request(`/api/companions/${companionId}/mail`,'PUT',{localName:'changed'}))!.status).toBe(409);
 const [box]=await db`SELECT local_name FROM companion_mailboxes WHERE companion_id=${companionId}`;
 await db`UPDATE companions SET retired_at=now() WHERE id=${companionId}`;
 const other=(await createCompanion(owner,{name:'New fixture',provider:'local'})).id;
 expect((await request(`/api/companions/${other}/mail`,'PUT',{localName:box.local_name}))!.status).toBe(409);
});
test('concurrent duplicate preparation persists one exact immutable draft',async()=>{
 const input={clientId:crypto.randomUUID(),to:['paul@example.com'],subject:'Document',text:'<script>bad</script>'};
 const first=await createMailDraft(companionId,input,{kind:'owner'});
 const repeated=await Promise.all(Array.from({length:6},()=>createMailDraft(companionId,input,{kind:'owner'})));
 expect(repeated.every(row=>row.id===first.id)).toBe(true);
 expect(first.html).toContain('&lt;script&gt;');
 await expect(createMailDraft(companionId,{...input,text:'Changed'},{kind:'owner'})).rejects.toThrow('already used');
});
test('atomic account quota permits fifty recipients and never automatically retries overflow',async()=>{
 await db`INSERT INTO companion_mail_quota(owner_id,day,used) VALUES(${owner},(now() AT TIME ZONE 'UTC')::date,49)`;
 const a=await draft(),b=await draft();await approveMailDraft(owner,companionId,a.id);await approveMailDraft(owner,companionId,b.id);
 const claims=await Promise.all(Array.from({length:8},()=>claimMailSend()));
 expect(claims.filter(Boolean)).toHaveLength(1);await claimMailSend();
 const rows=await db`SELECT state FROM companion_mail_messages WHERE id IN (${a.id},${b.id})`;
 expect(rows.map((r:any)=>r.state).sort()).toEqual(['quota_exceeded','sending']);
 await db`UPDATE companion_mail_quota SET used=0`;
 expect(await claimMailSend()).toBeNull();
});
test('multiple recipients count once each and over-limit message is not partially sent',async()=>{
 await db`INSERT INTO companion_mail_quota(owner_id,day,used) VALUES(${owner},(now() AT TIME ZONE 'UTC')::date,49)`;
 const row=await draft(['paul@example.com','alice@example.com']);await approveMailDraft(owner,companionId,row.id);
 expect(await claimMailSend()).toBeNull();
 expect((await db`SELECT used FROM companion_mail_quota`)[0].used).toBe(49);
});
test('explicit scheduled sends remain queued until due; cancellation is persisted',async()=>{
 const row=await draft();await approveMailDraft(owner,companionId,row.id,new Date(Date.now()+86400000));
 expect(await claimMailSend()).toBeNull();
 expect((await request(`/api/companions/${companionId}/mail/messages/${row.id}/cancel`,'POST',{}))!.status).toBe(200);
 expect(await claimMailSend()).toBeNull();
});
test('uncertain sends never replay and signed sent webhook reconciles without network effects',async()=>{
 const row=await draft();await approveMailDraft(owner,companionId,row.id);
 let calls=0;const deps={apiKey:'test',fetch:async()=>{calls++;throw Error('lost connection');}};
 await tickCompanionMail(deps);await tickCompanionMail(deps);
 expect(calls).toBe(1);expect((await db`SELECT state FROM companion_mail_messages WHERE id=${row.id}`)[0].state).toBe('ambiguous');
 const event={type:'email.sent',data:{email_id:crypto.randomUUID(),message_id:'<provider@resend.com>',tags:{companion_mail_id:row.id}}};
 expect((await handleCompanionMailWebhook(signed(event)))!.status).toBe(200);
 expect((await db`SELECT state FROM companion_mail_messages WHERE id=${row.id}`)[0].state).toBe('sent');
 expect((await db`SELECT email FROM companion_mail_thread_grants WHERE thread_id=${row.threadId}`)[0].email).toBe('paul@example.com');
});
test('incoming webhooks deduplicate and invalid signatures do not persist',async()=>{
 const [box]=await db`SELECT address FROM companion_mailboxes WHERE companion_id=${companionId}`;
 const event={type:'email.received',data:{email_id:crypto.randomUUID(),from:'paul@example.com',to:[box.address],subject:'Hello',message_id:'<sender@example.com>'}};
 await handleCompanionMailWebhook(signed(event));await handleCompanionMailWebhook(signed(event));
 expect((await db`SELECT id FROM companion_mail_messages WHERE companion_id=${companionId} AND direction='inbound'`)).toHaveLength(1);
 const request=signed(event),body=await request.text();expect(()=>verifyMailWebhook(body+' ',request.headers,secret)).toThrow('signature');
});
test('email tasks only reply to their own sender and cannot cross threads',async()=>{
 const threadId=crypto.randomUUID(),runId=crypto.randomUUID();
 await db`INSERT INTO companion_mail_threads(id,companion_id,reply_token) VALUES(${threadId},${companionId},${crypto.randomUUID()})`;
 await db`INSERT INTO runs(id,companion_id,client_message_id,content,lane,source) VALUES(${runId},${companionId},${runId},'Email','background','email')`;
 await db`INSERT INTO companion_mail_messages(id,companion_id,thread_id,run_id,direction,state,sender) VALUES(${crypto.randomUUID()},${companionId},${threadId},${runId},'inbound','ready','paul@example.com')`;
 const input={clientId:crypto.randomUUID(),to:['thirdparty@example.com'],subject:'Reply',text:'Content',threadId};
 await expect(createMailDraft(companionId,input,{kind:'email',runId})).rejects.toThrow('additional recipients');
 const row=await createMailDraft(companionId,{...input,to:['paul@example.com']},{kind:'email',runId});expect(row.state).toBe('queued');
 await expect(createMailDraft(companionId,{...input,clientId:crypto.randomUUID(),to:['paul@example.com'],threadId:crypto.randomUUID()},{kind:'email',runId})).rejects.toThrow('own thread');
});
test('size and recipient limits reject before persistence',()=>{
 expect(()=>validateMailDraft({clientId:crypto.randomUUID(),to:Array.from({length:51},(_,i)=>`person${i}@example.com`),subject:'Hi',text:'Hi'})).toThrow();
});
