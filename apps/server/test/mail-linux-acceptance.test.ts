import {expect,test} from 'bun:test';
import {createHash,createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {config,dataDir} from '../src/config';
import {db,migrate,createCompanion} from '../src/store';
import {acquireExecutor,tick} from '../src/executor';
import {productHooks} from '../src/runtime-product';
import {handleCompanionMail,handleCompanionMailWebhook,tickCompanionMail} from '../src/companion-mail';

/** Real compiled Linux daemon, Pi session, inbox upload and read tool; only email/DKIM network boundaries are fixtures. */
test.skipIf(process.env.RUN_LOCAL_ACCEPTANCE!=='1')('incoming email attachment reaches real Linux Pi and replies exactly once',async()=>{
 await migrate();
 const owner='00000000-0000-4000-8000-000000000001';
 expect(config.testMode).toBe(true);
 const sql=await acquireExecutor();expect(sql).not.toBeNull();
 const workspace=createHash('sha256').update(dataDir).digest('hex').slice(0,10);
 const previousSecret=process.env.RESEND_WEBHOOK_SECRET;
 const signingKey=Buffer.from('linux-email-acceptance-key');process.env.RESEND_WEBHOOK_SECRET=`whsec_${signingKey.toString('base64')}`;
 let companionId:string|undefined;
 const sent:any[]=[];
 const call=async(path:string,method:string,value:unknown)=>{
  const response=await handleCompanionMail(new Request(`http://localhost${path}`,{method,headers:{'content-type':'application/json'},body:JSON.stringify(value)}),owner);
  expect(response?.ok).toBe(true);return response!.json();
 };
 try{
  companionId=(await createCompanion(owner,{name:'Linux Mail Acceptance',instructions:'Read supplied email attachments and respond to the sender.',provider:'local'})).id;
  const account=await handleCompanionMail(new Request('http://localhost/api/mail/account'),owner);
  if(!(await account!.json()).alias)await call('/api/mail/account','PUT',{alias:'linux-mail-fixture'});
  const mailbox=await call(`/api/companions/${companionId}/mail`,'PUT',{localName:`fixture-${crypto.randomUUID().slice(0,8)}`});
  await call(`/api/companions/${companionId}/mail/senders`,'PUT',{email:'paul@example.com'});
  const providerId=crypto.randomUUID(),fileId=crypto.randomUUID();
  const payload=JSON.stringify({type:'email.received',data:{email_id:providerId,from:'Paul <paul@example.com>',to:[mailbox.mailbox.address],subject:'Linux attachment acceptance',message_id:'<linux-mail-fixture@example.com>'}});
  const webhook=()=>{
   const timestamp=String(Math.floor(Date.now()/1000)),id=crypto.randomUUID();
   const signature=createHmac('sha256',signingKey).update(`${id}.${timestamp}.${payload}`).digest('base64');
   return new Request('http://localhost/api/webhooks/resend',{method:'POST',headers:{'svix-id':id,'svix-timestamp':timestamp,'svix-signature':`v1,${signature}`},body:payload});
  };
  expect((await handleCompanionMailWebhook(webhook()))?.status).toBe(200);
  expect((await handleCompanionMailWebhook(webhook()))?.status).toBe(200);
  const dependencies={database:db,apiKey:'fixture-only-not-a-provider-key',verifySender:async()=>true,fetch:async(input:string|URL|Request,init?:RequestInit)=>{
   const url=String(input);
   if(url==='https://api.resend.com/emails'&&init?.method==='POST'){
    const body=JSON.parse(String(init.body));sent.push(body);
    return Response.json({id:crypto.randomUUID()});
   }
   if(url===`https://api.resend.com/emails/receiving/${providerId}`)return Response.json({from:'Paul <paul@example.com>',text:'MAIL_LINUX_READ_ATTACHMENT\nRead the attached notes.',headers:{},message_id:'<linux-mail-fixture@example.com>',attachments:[{id:fileId,filename:'notes.txt',content_type:'text/plain',size:22}],raw:{download_url:'https://raw.resend.com/linux-mail-fixture'}});
   if(url===`https://api.resend.com/emails/receiving/${providerId}/attachments/${fileId}`)return Response.json({download_url:'https://files.resend.com/linux-mail-fixture'});
   if(url==='https://raw.resend.com/linux-mail-fixture')return new Response('raw-authentication-fixture');
   if(url==='https://files.resend.com/linux-mail-fixture')return new Response('MAIL_LINUX_INPUT_BYTES\n');
   throw Error('Unexpected email fixture request');
  }};
  await tickCompanionMail(dependencies);
  const [incoming]=await db`SELECT id,run_id FROM companion_mail_messages WHERE companion_id=${companionId} AND direction='inbound'`;
  expect(incoming.run_id).toBeTruthy();
  const deadline=Date.now()+60_000;
  while(true){
   await tick(sql!,productHooks);
   await tickCompanionMail(dependencies);
   const [run]=await db`SELECT status,result_text,error FROM runs WHERE id=${incoming.run_id}`;
   if(run.status==='succeeded'&&sent.length)break;
   if(['failed','interrupted','cancelled'].includes(run.status))throw Error(`Email acceptance task ${run.status}: ${run.error??'no error'}`);
   if(Date.now()>deadline)throw Error('Linux email acceptance timed out');
   await Bun.sleep(100);
  }
  expect(readFileSync(join(dataDir,'agents',companionId!,'workspace','inbox',incoming.run_id,'0-notes.txt'),'utf8')).toBe('MAIL_LINUX_INPUT_BYTES\n');
  const [run]=await db`SELECT result_text FROM runs WHERE id=${incoming.run_id}`;
  expect(run.result_text).toBe('Email attachment verified in Linux: MAIL_LINUX_INPUT_BYTES');
  expect(sent).toHaveLength(1);expect(sent[0].to).toEqual(['paul@example.com']);expect(sent[0].text).toBe(run.result_text);
  expect(sent[0].headers['In-Reply-To']).toBe('<linux-mail-fixture@example.com>');
  for(let i=0;i<3;i++){await tick(sql!,productHooks);await tickCompanionMail(dependencies);}
  expect(sent).toHaveLength(1);
  expect(await db`SELECT id FROM runs WHERE companion_id=${companionId}`).toHaveLength(1);
  expect(await db`SELECT id FROM companion_mail_messages WHERE companion_id=${companionId} AND direction='outbound' AND state='sent'`).toHaveLength(1);
  expect(await db`SELECT id FROM messages WHERE companion_id=${companionId}`).toHaveLength(0);
 }finally{
  if(companionId){
   await db`UPDATE runs SET cancel_requested=true,status='cancelled',finished_at=now() WHERE companion_id=${companionId} AND status IN ('queued','preparing','running','needs_input')`;
   const name=`companions-${workspace}-${companionId}`;
   const remove=Bun.spawn(['docker','rm','-f',name],{stdout:'ignore',stderr:'ignore'});await remove.exited;
   const check=Bun.spawn(['docker','ps','-aq','--filter',`name=^/${name}$`],{stdout:'pipe',stderr:'pipe'});
   expect(await check.exited).toBe(0);expect((await new Response(check.stdout).text()).trim()).toBe('');
  }
  if(previousSecret===undefined)delete process.env.RESEND_WEBHOOK_SECRET;else process.env.RESEND_WEBHOOK_SECRET=previousSecret;
  await sql!`SELECT pg_advisory_unlock(721440139)`;sql!.release();
 }
},90_000);
