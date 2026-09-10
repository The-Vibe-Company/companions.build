import { beforeAll, expect, test } from 'bun:test';
import { db, migrate, createCompanion } from '../src/store';
import { handler } from '../src/api';
import { setMagicLinkDeliveryForTests } from '../src/auth';
import { encrypt } from '../src/config';
import { acceptMemoryWebhook, queueMemoryCommand, memoryAgentRequest, restoreMemoryRequest } from '../src/memory';
import { reconcileCompanionMemory, completedMemorySource, MemoryCoordinator } from '../src/memory-reconciliation';
import { MemoryStore } from '../../../packages/agent/src/memory-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let alice:{id:string;cookie:string},bob:{id:string;cookie:string};
async function signIn(){let link='';setMagicLinkDeliveryForTests(message=>{link=message.url;});
  await handler(new Request('http://127.0.0.1:4310/api/auth/sign-in/magic-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:`memory-${crypto.randomUUID()}@example.test`,callbackURL:'/'})}));
  const result=await handler(new Request(link,{redirect:'manual'}));const cookie=result.headers.get('set-cookie')!.split(';')[0];
  const me=await handler(new Request('http://127.0.0.1:4310/api/me',{headers:{cookie}}));return{cookie,id:(await me.json() as any).user.id};}
beforeAll(async()=>{await migrate();alice=await signIn();bob=await signIn();});
const api=(id:string,path='',body?:unknown,actor=alice)=>handler(new Request(`http://127.0.0.1:4310/api/companions/${id}/memory${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:actor.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));

test('memory API enforces ownership, queues human decisions before effects, and reports unavailable honestly',async()=>{
  const companion=await createCompanion(alice.id,{name:'Memory',provider:'local',prepare:false});
  expect((await api(companion.id,'',undefined,bob)).status).toBe(404);
  expect((await api(companion.id)).status).toBe(503);
  const input={operationId:crypto.randomUUID(),id:'record',expectedVersion:1};
  expect((await api(companion.id,'/approve',input)).status).toBe(202);
  expect((await api(companion.id,'/approve',input)).status).toBe(202);
  expect((await api(companion.id,'/approve',{...input,expectedVersion:2})).status).toBe(409);
  const result=await (await api(companion.id,`/commands/${input.operationId}`)).json() as any;
  expect(result.command).toMatchObject({operationId:input.operationId,response:null,settledAt:null});
  const [state]=await db`SELECT status,prepare_requested FROM companions WHERE id=${companion.id}`;
  expect(state).toMatchObject({status:'new',prepare_requested:false});
  expect((await api(companion.id,'/approve',{...input,authority:'system'})).status).toBe(400);
});

test('merged webhook receipt retires mission through the same store and survives a lost acknowledgement',async()=>{
  const companion=await createCompanion(alice.id,{name:'Merge memory',provider:'local',prepare:false});
  const state=mkdtempSync(join(tmpdir(),'mission-memory-')),store=new MemoryStore(state);
  const ref='https://github.com/example/project/pull/12';
  try {
    const saved=store.handle({op:'save',operationId:'mission',kind:'context',scope:'mission',missionId:'run',content:'Finish PR',provenance:'tracked work',source:{type:'pr',ref},mission:{ticket:'THE-12',workspace:'workspace-12',pr:ref,stopCondition:'pr_merged'}});
    expect(saved.status).toBe('ok');
    const payload={action:'closed',number:12,repository:{full_name:'example/project'},pull_request:{merged:true}};
    await db.begin(tx=>acceptMemoryWebhook(tx,companion.id,'pull_request',payload));
    await db.begin(tx=>acceptMemoryWebhook(tx,companion.id,'pull_request',payload));
    const commands=await db`SELECT * FROM memory_commands WHERE companion_id=${companion.id}`;expect(commands).toHaveLength(1);
    const running={...companion,owner_id:alice.id,endpoint_secret:encrypt('http://fixture'),agent_secret:encrypt('fixture'),memory_cursor:null};
    let lose=true;
    const request=async(_endpoint:string,_token:string,input:any,authority:any)=>{const result=store.handle(input,authority);if(input.op==='observe'&&lose){lose=false;throw Error('ack lost');}return result;};
    await expect(reconcileCompanionMemory(running,{request})).rejects.toThrow('ack lost');
    await reconcileCompanionMemory(running,{request});
    const [receipt]=await db`SELECT settled_at,response FROM memory_commands WHERE companion_id=${companion.id}`;expect(receipt.settled_at).not.toBeNull();
    expect(store.handle({op:'search',query:'Finish',missionId:'run'})).toMatchObject({status:'ok',memories:[]});
    const inspected=store.handle({op:'inspect'},'human') as any;
    expect(inspected.memories.find((record:any)=>record.id===(saved as any).memory.id).status).toBe('retired');
  } finally {store.close();rmSync(state,{recursive:true,force:true});}
});

test('unavailable worker keeps durable intent pending and cancelled reconciliation makes no external calls',async()=>{
  const companion=await createCompanion(alice.id,{name:'Unavailable memory',provider:'local',prepare:false});
  await queueMemoryCommand(db,companion.id,{op:'retire',operationId:'retire-pending',id:'record',expectedVersion:1},'human');
  const running={...companion,endpoint_secret:encrypt('http://fixture'),agent_secret:encrypt('fixture')};
  await reconcileCompanionMemory(running,{request:async()=>({status:'unavailable',error:'MEMORY_UNAVAILABLE'})});
  const [row]=await db`SELECT settled_at FROM memory_commands WHERE companion_id=${companion.id}`;expect(row.settled_at).toBeNull();
  let calls=0;await expect(reconcileCompanionMemory(running,{signal:AbortSignal.abort(),request:async()=>{calls++;return{status:'ok'};}})).rejects.toThrow();expect(calls).toBe(0);
  const coordinator=new MemoryCoordinator();const start=performance.now();coordinator.schedule(123);expect(performance.now()-start).toBeLessThan(50);await coordinator.close();
});

test('source verification uses selected credentials, trusted provider paths, and current completion',async()=>{
  const companion=await createCompanion(alice.id,{name:'Source verification',provider:'local',prepare:false});
  const running={...companion,owner_id:alice.id};let calls=0;
  const transport=(async(url:string|URL|Request)=>{calls++;expect(String(url)).toBe('https://api.github.com/repos/example/project/pulls/12');return Response.json({merged:true});}) as typeof fetch;
  expect(await completedMemorySource('https://malicious.test/pull/12','pr',running,{fetchImpl:transport})).toBe(false);
  expect(await completedMemorySource('https://github.com/example/project/pull/12','pr',running,{fetchImpl:transport})).toBe(false);expect(calls).toBe(0);
  const accountId=crypto.randomUUID();await db`INSERT INTO plugin_accounts(id,owner_id,provider,label,credential_secret) VALUES(${accountId},${alice.id},'github','fixture',${encrypt(JSON.stringify({kind:'oauth',accessToken:'fixture-only'}))})`;
  await db`INSERT INTO companion_plugins(companion_id,account_id) VALUES(${companion.id},${accountId})`;
  expect(await completedMemorySource('https://github.com/example/project/pull/12','pr',running,{fetchImpl:transport})).toBe(true);expect(calls).toBe(1);
  expect(await completedMemorySource('https://github.com/example/project/pull/12','pr',running,{fetchImpl:(async()=>new Response('private provider failure',{status:500})) as unknown as typeof fetch})).toBe(false);
});

test('only signed GitHub merge deliveries persist retirement; unrelated and forged events do not',async()=>{
  const {handleWebhook}=await import('../src/triggers');
  const {createHmac}=await import('node:crypto');
  const companion=await createCompanion(alice.id,{name:'Signed closure',provider:'local',prepare:false});
  const triggerId=crypto.randomUUID(),secret='synthetic-webhook-secret';
  await db`INSERT INTO triggers(id,owner_id,companion_id,name,prompt,source,mode,secret_ciphertext)
    VALUES(${triggerId},${alice.id},${companion.id},'Merge','Inspect','github','direct',${encrypt(secret)})`;
  const body=JSON.stringify({action:'closed',number:19,repository:{full_name:'example/project'},pull_request:{merged:true}});
  const delivery=crypto.randomUUID();
  const webhook=(key:string)=>new Request(`http://127.0.0.1:4310/api/webhooks/${triggerId}`,{method:'POST',body,headers:{'x-github-event':'pull_request','x-github-delivery':delivery,'x-hub-signature-256':'sha256='+createHmac('sha256',key).update(body).digest('hex')}});
  expect((await handleWebhook(webhook('wrong')))!.status).toBe(401);
  expect(await db`SELECT operation_id FROM memory_commands WHERE companion_id=${companion.id}`).toHaveLength(0);
  expect((await handleWebhook(webhook(secret)))!.status).toBe(202);
  expect((await handleWebhook(webhook(secret)))!.status).toBe(202);
  const commands=await db`SELECT request FROM memory_commands WHERE companion_id=${companion.id}`;
  expect(commands).toHaveLength(1);expect(restoreMemoryRequest(commands[0].request)).toMatchObject({op:'observe',state:'merged',source:{ref:'https://github.com/example/project/pull/19'}});
});


test('large escaped legacy requests and replies preserve bytes while receipts omit memory content',async()=>{
  const companion=await createCompanion(alice.id,{name:'Legacy transport',provider:'local',prepare:false});
  const content='\u0000'.repeat(30_000),operationId='large-legacy';
  const body=JSON.stringify({operationId,expectedVersion:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',content});
  const queued=await handler(new Request(`http://127.0.0.1:4310/api/companions/${companion.id}/memory/legacy`,{method:'POST',
    headers:{cookie:alice.cookie,'content-type':'application/json','content-length':String(Buffer.byteLength(body))},body}));
  expect(queued.status).toBe(202);
  const transport=(async()=>Response.json({status:'ok',legacy:{content,version:'a'.repeat(64)}})) as unknown as typeof fetch;
  expect(await memoryAgentRequest('http://fixture','fixture',{op:'inspect'},'human',transport)).toMatchObject({legacy:{content}});
  await expect(memoryAgentRequest('http://fixture','fixture',{op:'inspect'},'human',
    (async()=>new Response('x'.repeat(300_000))) as unknown as typeof fetch)).rejects.toThrow('MEMORY_TOO_LARGE');
  await reconcileCompanionMemory({...companion,endpoint_secret:encrypt('http://fixture'),agent_secret:encrypt('fixture')},{request:async(_endpoint,_token,input)=>
    input.op==='inspect'?{status:'ok',memories:[]}:{status:'ok',legacy:{content,version:'a'.repeat(64)},memory:{id:'legacy-shared-memory',version:2,status:'active',approval:'approved',content,provenance:'private explanation'}}});
  const receipt=await (await api(companion.id,`/commands/${operationId}`)).json() as any;
  expect(receipt.command.response).toEqual({status:'ok',legacyVersion:'a'.repeat(64),record:{id:'legacy-shared-memory',version:2,status:'active',approval:'approved'}});
  expect(JSON.stringify(receipt)).not.toContain('private explanation');
  expect(JSON.stringify(receipt)).not.toContain('content');
});

test('reconciliation polls only the declared mission stop target',async()=>{
  const companion=await createCompanion(alice.id,{name:'Stop target',provider:'local',prepare:false});
  const runId=crypto.randomUUID(),targets:string[]=[];
  const database:any=async(strings:TemplateStringsArray,...values:any[])=>{
    const sql=strings.join('?');
    if(sql.includes('FROM memory_commands'))return[];
    if(sql.includes('FROM runs')){targets.push(values[0]);return[{status:'succeeded'}];}
    if(sql.includes('FROM plugin_accounts'))return[];
    return[];
  };
  await reconcileCompanionMemory({...companion,owner_id:alice.id,endpoint_secret:encrypt('http://fixture'),agent_secret:encrypt('fixture')},{database,
    request:async()=>({status:'ok',memories:[{id:'mission',status:'active',scope:'mission',source:{type:'run',ref:runId},
      mission:{ticket:runId,workspace:'workspace',pr:'https://github.com/example/project/pull/1',stopCondition:'pr_merged'}}]})});
  expect(targets).toEqual([]);
});
