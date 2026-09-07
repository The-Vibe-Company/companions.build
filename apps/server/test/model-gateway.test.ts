import {beforeAll,expect,test} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {createModelGateway,MODEL_GATEWAY_MAX_REQUEST_BYTES} from '../src/model-gateway';
import {mintModelGatewayToken} from '../src/model-gateway-token';
const protocols={google:'google-generative-ai',anthropic:'anthropic-messages',openai:'openai-responses',openrouter:'openai-completions',zai:'openai-completions'} as const;
type Provider=keyof typeof protocols;
beforeAll(async()=>{await migrate();await db.unsafe(await Bun.file(new URL('../src/model-gateway.sql',import.meta.url)).text());});
async function fixture(provider:Provider='openai'){
 const owner=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${owner},'Gateway',${owner+'@example.test'},true)`;
 const c=await createCompanion(owner,{name:'Gateway',instructions:'',provider:'box'}),run=await acceptMessage(owner,c.id,crypto.randomUUID(),'Private prompt fixture');
 const [row]=await db`UPDATE runs SET status='running',dispatched=true,started_at=now(),model_provider=${provider},model_id='fixture-model',usage_source='gateway' WHERE id=${run} RETURNING id`;
 const [companion]=await db`SELECT agent_secret FROM companions WHERE id=${c.id}`;
 return {owner,companionId:c.id,runId:row.id,provider,token:mintModelGatewayToken(c.id,row.id,companion.agent_secret)};
}
function path(f:Awaited<ReturnType<typeof fixture>>){return `/api/model-gateway/${f.provider}/${protocols[f.provider]}`+(f.provider==='google'?'/models/fixture-model:streamGenerateContent?alt=sse':f.provider==='anthropic'?'/v1/messages':f.provider==='openai'?'/responses':'/chat/completions');}
function request(f:Awaited<ReturnType<typeof fixture>>,id=crypto.randomUUID(),body:any={model:'fixture-model',stream:true},changes:Record<string,string>={}){
 return new Request('https://fixture.invalid'+path(f),{method:'POST',headers:{'content-type':'application/json','x-companions-model-token':f.token,'x-companions-run-id':f.runId,'x-companions-model-request-id':id,...changes},body:JSON.stringify(body)});
}
const frame=(value:any)=>'data: '+JSON.stringify(value)+'\n\n';
function events(provider:Provider){
 if(provider==='anthropic')return frame({type:'message_start',message:{usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:3,cache_creation_input_tokens:2}}})+frame({type:'message_delta',usage:{output_tokens:5}})+frame({type:'message_stop'});
 if(provider==='openai')return frame({type:'response.completed',response:{status:'completed',usage:{input_tokens:15,output_tokens:5,total_tokens:20,input_tokens_details:{cached_tokens:3}}}});
 if(provider==='google')return frame({candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:15,candidatesTokenCount:3,thoughtsTokenCount:2,cachedContentTokenCount:3,totalTokenCount:20}});
 return frame({choices:[{finish_reason:'stop'}]})+frame({choices:[],usage:{prompt_tokens:15,completion_tokens:5,total_tokens:20,prompt_tokens_details:{cached_tokens:3}}})+'data: [DONE]\n\n';
}
function gateway(transport:(url:string,init:RequestInit)=>Promise<Response>|Response,overrides:any={}){return createModelGateway({sql:db,modelApi:async provider=>protocols[provider as Provider],key:()=> 'synthetic-server-only-key',fetch:((url:any,init:any)=>transport(String(url),init)) as typeof fetch,...overrides});}
function upstream(provider:Provider){return new Response(events(provider),{headers:{'content-type':'text/event-stream'}});}

test('all five providers retain native paths and terminal usage, with durable claim before upstream and server-only credentials',async()=>{
 for(const provider of Object.keys(protocols) as Provider[]){
  const f=await fixture(provider),id=crypto.randomUUID();let calls=0;
  const g=gateway(async(url,init)=>{
   calls++;const [claim]=await db`SELECT status,request_hash FROM model_gateway_requests WHERE id=${id}`;expect(claim.status).toBe('forwarding');expect(claim.request_hash).toMatch(/^[a-f0-9]{64}$/);
   const expected={google:'https://generativelanguage.googleapis.com/v1beta/models/fixture-model:streamGenerateContent?alt=sse',anthropic:'https://api.anthropic.com/v1/messages',openai:'https://api.openai.com/v1/responses',openrouter:'https://openrouter.ai/api/v1/chat/completions',zai:'https://api.z.ai/api/coding/paas/v4/chat/completions'};
   expect(url).toBe(expected[provider]);expect(init.redirect).toBe('error');
   const headers=new Headers(init.headers);expect(headers.get('cookie')).toBeNull();expect(headers.get('x-companions-model-token')).toBeNull();
   expect(headers.get(provider==='google'?'x-goog-api-key':provider==='anthropic'?'x-api-key':'authorization')).toContain('synthetic-server-only-key');
   const body=JSON.parse(String(init.body));if(provider==='openai')expect(body.store).toBe(false);if(provider==='zai'||provider==='openrouter')expect(body.stream_options.include_usage).toBe(true);
   return upstream(provider);
  });
  const response=await g.handle(request(f,id,{model:'fixture-model',stream:true},{cookie:'never-forward',authorization:'Bearer attacker'}));expect(response!.status).toBe(200);expect(await response!.text()).toBe(events(provider));await g.drain();
  const [row]=await db`SELECT * FROM model_gateway_requests WHERE id=${id}`;expect(row.status).toBe('succeeded');expect(row.usage_verified).toBe(true);expect(row.usage.totalTokens).toBe(20);expect(row.owner_id).toBe(f.owner);expect(row.usage.cacheRead).toBe(3);
  expect(JSON.stringify(row)).not.toContain('Private prompt');expect(JSON.stringify(row)).not.toContain('synthetic-server-only-key');
  expect((await g.handle(request(f,id)))!.status).toBe(409);expect(calls).toBe(1);
 }
});

test('token, ownership, rotation, active admission, pinning and entitlement fail before any provider contact',async()=>{
 const f=await fixture(),other=await fixture();let calls=0;const g=gateway(()=>{calls++;return upstream('openai');});
 const denied=[request(f,undefined,undefined,{'x-companions-model-token':other.token}),request(f,undefined,undefined,{'x-companions-run-id':other.runId}),request(f,undefined,{model:'another-model',stream:true})];
 for(const req of denied)expect((await g.handle(req))!.status).toBeGreaterThanOrEqual(400);
 const original=f.token;f.token+='tampered';expect((await g.handle(request(f)))!.status).toBe(401);f.token=original;
 await db`UPDATE companions SET agent_secret='rotated' WHERE id=${f.companionId}`;expect((await g.handle(request(f)))!.status).toBe(403);
 for(const fields of ["dispatched=false","cancel_requested=true","status='succeeded'","usage_source='agent'"]){
  const x=await fixture();await db.unsafe(`UPDATE runs SET ${fields} WHERE id=$1`,[x.runId]);expect((await g.handle(request(x)))!.status).toBe(403);
 }
 const x=await fixture(),deniedGateway=gateway(()=>{calls++;return upstream('openai');},{authorize:async()=>{throw Error('private billing details');}});
 const result=await deniedGateway.handle(request(x));expect(result!.status).toBe(403);expect(await result!.text()).not.toContain('private billing');expect(calls).toBe(0);
});

test('remote provider state, hosted tools, alternate hosts/paths and oversized bodies cannot use platform credentials',async()=>{
 const f=await fixture();let calls=0;const g=gateway(()=>{calls++;return upstream('openai');});
 for(const extra of [{previous_response_id:'foreign-response'},{conversation:'foreign'},{background:true},{tools:[{type:'file_search'}]},{input:[{type:'item_reference',id:'foreign'}]},{input:[{type:'message',content:[{type:'input_file',file_id:'foreign'}]}]},{prompt:{id:'foreign'}}]){
  expect((await g.handle(request(f,undefined,{model:'fixture-model',stream:true,...extra})))!.status).toBe(403);
 }
 const changed=new Request('https://fixture.invalid'+path(f)+'/elsewhere',request(f));expect((await g.handle(changed))!.status).toBe(403);
 const oversized=request(f,undefined,undefined,{'content-length':String(MODEL_GATEWAY_MAX_REQUEST_BYTES+1)});expect((await g.handle(oversized))!.status).toBe(413);
 expect(calls).toBe(0);expect(await db`SELECT id FROM model_gateway_requests WHERE run_id=${f.runId}`).toHaveLength(0);
});

test('concurrent and crash-left claims never replay an ambiguous upstream invocation',async()=>{
 const f=await fixture(),id=crypto.randomUUID();let calls=0,unblock!:()=>void;const barrier=new Promise<void>(resolve=>unblock=resolve);
 const g=gateway(async()=>{calls++;await barrier;return upstream('openai');});
 const first=g.handle(request(f,id));while(!calls)await Bun.sleep(5);
 expect((await g.handle(request(f,id)))!.status).toBe(409);expect((await g.handle(request(f)))!.status).toBe(409);
 unblock();await (await first)!.text();await g.drain();expect(calls).toBe(1);
 const dead=await fixture(),deadId=crypto.randomUUID();await db`INSERT INTO model_gateway_requests(id,run_id,companion_id,owner_id,provider,model_id,api,request_hash) VALUES(${deadId},${dead.runId},${dead.companionId},${dead.owner},'openai','fixture-model','openai-responses',${'0'.repeat(64)})`;
 const restarted=gateway(()=>{calls++;return upstream('openai');});expect((await restarted.handle(request(dead,deadId)))!.status).toBe(409);expect(calls).toBe(1);
});

test('client disconnect keeps bounded upstream drain and bills only terminal provider usage',async()=>{
 const f=await fixture(),id=crypto.randomUUID();let source!:ReadableStreamDefaultController<Uint8Array>;
 const g=gateway(()=>new Response(new ReadableStream<Uint8Array>({start(c){source=c;}}),{headers:{'content-type':'text/event-stream'}}));
 const response=await g.handle(request(f,id));await response!.body!.cancel();source.enqueue(new TextEncoder().encode(events('openai')));source.close();await g.drain();
 expect((await db`SELECT status,usage_verified FROM model_gateway_requests WHERE id=${id}`)[0]).toMatchObject({status:'succeeded',usage_verified:true});
});

test('truncated and malformed streams never invent final usage; definitive rejection and transport ambiguity remain non-replayable',async()=>{
 for(const kind of ['truncated','malformed','transport','rejected'] as const){
  const f=await fixture('anthropic'),id=crypto.randomUUID();let calls=0;
  const g=gateway(()=>{calls++;if(kind==='transport')throw Error('secret-key-and-private-payload');if(kind==='rejected')return Response.json({error:'secret-key-and-private-payload'},{status:429});
   return new Response(kind==='truncated'?frame({type:'message_start',message:{usage:{input_tokens:100,output_tokens:0}}}):'data: invalid-json\n\n'+events('anthropic'),{headers:{'content-type':'text/event-stream'}});
  });
  const response=await g.handle(request(f,id));try{const text=await response!.text();expect(text).not.toContain('secret-key-and-private-payload');}catch{}
  await g.drain();const [row]=await db`SELECT status,usage_verified,error_code FROM model_gateway_requests WHERE id=${id}`;expect(row.status).toBe(kind==='rejected'?'failed':'interrupted');expect(row.usage_verified).toBe(false);
  expect((await g.handle(request(f,id)))!.status).toBe(409);expect(calls).toBe(1);
 }
});

test('revocation between durable claim and forwarding prevents the external effect',async()=>{
 const f=await fixture(),id=crypto.randomUUID();let checks=0,calls=0;
 const g=gateway(()=>{calls++;return upstream('openai');},{authorize:async()=>{if(++checks===2)throw Error('revoked');}});
 expect((await g.handle(request(f,id)))!.status).toBe(403);expect(calls).toBe(0);expect((await db`SELECT status,error_code FROM model_gateway_requests WHERE id=${id}`)[0]).toMatchObject({status:'interrupted',error_code:'subscription_required'});
});

test('deadline ends an unresponsive upstream and leaves no replay or billable partial result',async()=>{
 const f=await fixture(),id=crypto.randomUUID();let aborted=false;
 const g=gateway((_url,init)=>new Promise((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>{aborted=true;reject(Error('transport'));});}),{deadlineMs:20});
 expect((await g.handle(request(f,id)))!.status).toBe(502);expect(aborted).toBe(true);expect((await db`SELECT status,usage_verified FROM model_gateway_requests WHERE id=${id}`)[0]).toMatchObject({status:'interrupted',usage_verified:false});
});

test('OpenRouter Anthropic-native models keep their catalog protocol and fixed Messages endpoint',async()=>{
 const f=await fixture('openrouter'),id=crypto.randomUUID();let calls=0;
 const g=gateway((url,init)=>{calls++;expect(url).toBe('https://openrouter.ai/api/v1/messages?beta=true');expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-server-only-key');expect(new Headers(init.headers).get('anthropic-version')).toBe('2023-06-01');expect(JSON.parse(String(init.body)).fallbacks).toBeUndefined();return upstream('anthropic');},{modelApi:async()=> 'anthropic-messages'});
 const native=new Request('https://fixture.invalid/api/model-gateway/openrouter/anthropic-messages/v1/messages?beta=true',request(f,id,{model:'fixture-model',stream:true,fallbacks:[{model:'unselected-model'}],tools:[{name:'bash',description:'Local tool',input_schema:{type:'object'}}]}));
 expect(await (await g.handle(native))!.text()).toBe(events('anthropic'));await g.drain();expect(calls).toBe(1);expect((await db`SELECT usage_verified FROM model_gateway_requests WHERE id=${id}`)[0].usage_verified).toBe(true);
});

test('native function tools work while hosted tools, priority tiers and non-text generation are rejected on every protocol',async()=>{
 for(const provider of Object.keys(protocols) as Provider[]){
  const f=await fixture(provider);let calls=0;const g=gateway(()=>{calls++;return upstream(provider);});
  const tool=provider==='google'?{functionDeclarations:[{name:'bash',parameters:{type:'object'}}]}:provider==='anthropic'?{name:'bash',input_schema:{type:'object'}}:provider==='openai'?{type:'function',name:'bash',parameters:{type:'object'}}:{type:'function',function:{name:'bash',parameters:{type:'object'}}};
  const valid=await g.handle(request(f,undefined,{model:'fixture-model',stream:true,tools:[tool]}));expect(valid!.status).toBe(200);await valid!.text();await g.drain();
  const hosted=provider==='google'?{googleSearch:{}}:provider==='anthropic'?{type:'web_search_20250305',name:'web_search'}:{type:'web_search'};
  for(const extra of [{tools:[hosted]},{service_tier:'priority'},{web_search_options:{}},{priority:100},{generationConfig:{responseModalities:['IMAGE']}},{modalities:['audio']}])expect((await g.handle(request(f,undefined,{model:'fixture-model',stream:true,...extra})))!.status).toBe(403);
  expect(calls).toBe(1);
 }
});

test('body deadline releases admission and does not leave a claim for a slow sender',async()=>{
 const f=await fixture();let calls=0,cancelled=false;
 const g=gateway(()=>{calls++;return upstream('openai');},{bodyDeadlineMs:20,maxConcurrent:1});
 const slow=new Request(request(f),{body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'} as RequestInit);
 expect((await g.handle(slow))!.status).toBe(408);expect(cancelled).toBe(true);expect(calls).toBe(0);
 const next=await g.handle(request(f));expect(next!.status).toBe(200);await next!.text();await g.drain();expect(calls).toBe(1);
});

test('an actual HTTP stream continues upstream after the downstream consumer disconnects',async()=>{
 const f=await fixture('zai'),id=crypto.randomUUID();let terminal!:()=>void,received=0;
 const ready=new Promise<void>(resolve=>terminal=resolve);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){received++;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(': started\n\n'));void ready.then(()=>{controller.enqueue(new TextEncoder().encode(events('zai')));controller.close();});}}),{headers:{'content-type':'text/event-stream'}});}});
 try{
  const g=gateway((_url,init)=>fetch(`http://127.0.0.1:${server.port}/fixture`,init));
  const response=await g.handle(request(f,id));const reader=response!.body!.getReader();await reader.read();await reader.cancel();terminal();await g.drain();
  expect(received).toBe(1);expect((await db`SELECT status,usage_verified,usage FROM model_gateway_requests WHERE id=${id}`)[0]).toMatchObject({status:'succeeded',usage_verified:true,usage:{totalTokens:20}});
 }finally{terminal();server.stop(true);}
});

test('terminal provider failures persist verified usage without forwarding provider error details',async()=>{
 const f=await fixture(),id=crypto.randomUUID();
 const g=gateway(()=>new Response(frame({type:'response.failed',response:{status:'failed',error:{message:'private-provider-detail'},usage:{input_tokens:15,output_tokens:5,total_tokens:20}}}),{headers:{'content-type':'text/event-stream'}}));
 const response=await g.handle(request(f,id));let body='';try{body=await response!.text();}catch{}await g.drain();expect(body).not.toContain('private-provider-detail');expect((await db`SELECT status,usage_verified,usage FROM model_gateway_requests WHERE id=${id}`)[0]).toMatchObject({status:'failed',usage_verified:true,usage:{totalTokens:20}});
});
