import {beforeAll,expect,test} from 'bun:test';
import {InMemoryCredentialStore} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {configureModelGateway,withModelGatewayRequest} from '../../../packages/agent/src/model-gateway';
import {createModelGateway} from '../src/model-gateway';
import {mintModelGatewayToken} from '../src/model-gateway-token';
import {acceptMessage,createCompanion,db,migrate} from '../src/store';

type Api='google-generative-ai'|'anthropic-messages'|'openai-responses'|'openai-completions';
const pairs=[['google','google-generative-ai'],['anthropic','anthropic-messages'],['openai','openai-responses'],
 ['openrouter','anthropic-messages'],['openrouter','openai-completions'],['zai','openai-completions']] as const;
const frame=(value:unknown,event?:string)=>(event?`event: ${event}\n`:'')+`data: ${JSON.stringify(value)}\n\n`;

beforeAll(async()=>migrate());

function terminal(api:Api,model:string){
 if(api==='google-generative-ai')return frame({candidates:[{content:{role:'model',parts:[{text:'gateway ok'}]},finishReason:'STOP',index:0}],usageMetadata:{promptTokenCount:8,candidatesTokenCount:4,cachedContentTokenCount:2,totalTokenCount:12}});
 if(api==='anthropic-messages')return frame({type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',content:[],model,stop_reason:null,stop_sequence:null,usage:{input_tokens:6,output_tokens:0,cache_read_input_tokens:2}}},'message_start')+
  frame({type:'content_block_start',index:0,content_block:{type:'text',text:''}},'content_block_start')+
  frame({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'gateway ok'}},'content_block_delta')+
  frame({type:'content_block_stop',index:0},'content_block_stop')+
  frame({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:4}},'message_delta')+frame({type:'message_stop'},'message_stop');
 if(api==='openai-responses'){
  const response={id:'resp_fixture',object:'response',created_at:1,status:'completed',error:null,incomplete_details:null,instructions:null,max_output_tokens:null,model,output:[{id:'msg_fixture',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',annotations:[],logprobs:[],text:'gateway ok'}]}],parallel_tool_calls:true,previous_response_id:null,reasoning:{effort:null,summary:null},store:false,temperature:1,text:{format:{type:'text'},verbosity:'medium'},tool_choice:'auto',tools:[],top_p:1,truncation:'disabled',usage:{input_tokens:8,input_tokens_details:{cached_tokens:2},output_tokens:4,output_tokens_details:{reasoning_tokens:0},total_tokens:12},user:null,metadata:{}};
  const item={id:'msg_fixture',type:'message',status:'in_progress',role:'assistant',content:[]};
  return frame({type:'response.created',response:{...response,status:'in_progress',output:[],usage:null}})+
   frame({type:'response.output_item.added',output_index:0,item})+
   frame({type:'response.output_text.delta',item_id:'msg_fixture',output_index:0,content_index:0,delta:'gateway ok',logprobs:[]})+
   frame({type:'response.output_item.done',output_index:0,item:response.output[0]})+frame({type:'response.completed',response});
 }
 return frame({id:'chatcmpl_fixture',object:'chat.completion.chunk',created:1,model,choices:[{index:0,delta:{role:'assistant',content:'gateway ok'},finish_reason:null}]})+
  frame({id:'chatcmpl_fixture',object:'chat.completion.chunk',created:1,model,choices:[{index:0,delta:{},finish_reason:'stop'}]})+
  frame({id:'chatcmpl_fixture',object:'chat.completion.chunk',created:1,model,choices:[],usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12,prompt_tokens_details:{cached_tokens:2}}})+'data: [DONE]\n\n';
}

test('native Pi SDKs cross the real gateway and persist verified terminal usage for every supported protocol',async()=>{
 const owner=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${owner},'Native gateway',${owner+'@example.test'},true)`;
 const upstream:Array<{provider:string;api:string;url:string}>=[];
 const gateway=createModelGateway({sql:db,authorize:async()=>{},key:()=> 'server-only-fixture-key',fetch:(async(url:any,init:any)=>{
  const target=new URL(String(url)),body=JSON.parse(String(init.body));
  const provider=target.hostname==='generativelanguage.googleapis.com'?'google':target.hostname==='api.anthropic.com'?'anthropic':target.hostname==='api.openai.com'?'openai':target.hostname==='openrouter.ai'?'openrouter':target.hostname==='api.z.ai'?'zai':'';
  const api=(target.pathname.endsWith('/responses')?'openai-responses':target.pathname.endsWith('/messages')?'anthropic-messages':target.pathname.includes(':streamGenerateContent')?'google-generative-ai':'openai-completions') as Api;
  upstream.push({provider,api,url:String(url)});
  return new Response(terminal(api,body.model??target.pathname.match(/\/models\/([^:]+)/)?.[1]??''),{headers:{'content-type':'text/event-stream'}});
 }) as typeof fetch});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>await gateway.handle(request)??new Response(null,{status:404})});
 try{
  for(const [provider,api] of pairs){
   const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
   const model=runtime.getModels(provider).find(value=>value.api===api)!;
   const companion=await createCompanion(owner,{name:`Native ${provider} ${api}`,provider:'box'});
   const runId=await acceptMessage(owner,companion.id,crypto.randomUUID(),'Exercise native SDK through gateway');
   const [run]=await db`UPDATE runs SET status='running',dispatched=true,started_at=now(),model_provider=${provider},model_id=${model.id},usage_source='gateway' WHERE id=${runId} RETURNING id`;
   const [stored]=await db`SELECT agent_secret FROM companions WHERE id=${companion.id}`;
   const token=mintModelGatewayToken(companion.id,run.id,stored.agent_secret);
   await configureModelGateway(runtime,provider,`http://127.0.0.1:${server.port}/api/model-gateway`,true);
   expect(runtime.getModel(provider,model.id)).toEqual(model);
   const stream=withModelGatewayRequest(run.id,{token},()=>runtime.streamSimple(model,{messages:[{role:'user',content:[{type:'text',text:'hello'}],timestamp:1}]},{maxRetries:0}));
   const result=await stream.result();expect({provider,api,stopReason:result.stopReason}).toEqual({provider,api,stopReason:'stop'});
   expect({provider,api,text:result.content.filter(part=>part.type==='text').map(part=>part.text).join('')}).toEqual({provider,api,text:'gateway ok'});
   await gateway.drain();
   const [request]=await db`SELECT status,usage_verified,usage,provider,api,model_id FROM model_gateway_requests WHERE run_id=${run.id}`;
   expect(request).toMatchObject({status:'succeeded',usage_verified:true,provider,api,model_id:model.id,usage:{input:6,output:4,cacheRead:2,totalTokens:12}});
  }
  expect(upstream.map(value=>[value.provider,value.api])).toEqual(pairs.map(value=>[...value]));
 }finally{server.stop(true);await gateway.drain();}
});


test('existing native Responses agents can switch Great to Fast without receiving provider keys',async()=>{
 const owner=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${owner},'Model choices',${owner+'@example.test'},true)`;
 const companion=await createCompanion(owner,{name:'Model choice fixture',provider:'box'});
 const [stored]=await db`SELECT agent_secret FROM companions WHERE id=${companion.id}`;
 const sent:any[]=[];
 const gateway=createModelGateway({sql:db,authorize:async()=>{},key:()=> 'server-only-fixture-key',azureBaseUrl:'https://fixture.services.ai.azure.com/openai/v1',fetch:(async(url:any,init:any)=>{
  const body=JSON.parse(String(init.body));sent.push({url:String(url),model:body.model});
  expect(new Headers(init.headers).get('x-companions-model-token')).toBeNull();
  if(body.model==='gpt-5.6-luna')expect(body.input.some((item:any)=>item.id==='rs_deepseek_fixture')).toBe(false);
  return new Response(terminal('openai-responses',body.model),{headers:{'content-type':'text/event-stream'}});
 }) as typeof fetch});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>await gateway.handle(request)??new Response(null,{status:404})});
 try{
  const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  await configureModelGateway(runtime,'openai',`http://127.0.0.1:${server.port}/api/model-gateway`,true);
  const messages:any[]=[];
  for(const provider of ['azure','deepseek','azure']){
   const actual=provider==='azure'?'gpt-5.6-luna':'deepseek-flash';
   const model=runtime.getModel('openai',provider==='azure'?'gpt-5.6-luna':'gpt-5.6-sol')!;
   messages.push({role:'user',content:'Hello',timestamp:Date.now()});
   const runId=(await acceptMessage(owner,companion.id,crypto.randomUUID(),'Model selection fixture'))!;
   await db`UPDATE runs SET status='running',dispatched=true,model_provider=${provider},model_id=${actual},usage_source='gateway' WHERE id=${runId}`;
   const token=mintModelGatewayToken(companion.id,runId,stored.agent_secret);
   const result=await withModelGatewayRequest(runId,{token},()=>runtime.streamSimple(model,{messages},{maxRetries:0}).result());
   expect(result.stopReason).toBe('stop');
   if(provider==='deepseek')result.content.unshift({type:'thinking',thinking:'fixture reasoning',thinkingSignature:JSON.stringify({type:'reasoning',id:'rs_deepseek_fixture',status:'completed',summary:[]})});
   messages.push(result);await gateway.drain();
   const [claim]=await db`SELECT provider,model_id,status,usage_verified FROM model_gateway_requests WHERE run_id=${runId}`;
   expect(claim).toMatchObject({provider,model_id:actual,status:'succeeded',usage_verified:true});
   await db`UPDATE runs SET status='succeeded',finished_at=now() WHERE id=${runId}`;
  }
  expect(sent.map(x=>x.model)).toEqual(['gpt-5.6-luna','deepseek-flash','gpt-5.6-luna']);expect(sent[1].url).toBe('https://api.deepseek.com/responses');
 }finally{server.stop(true);await gateway.drain();}
});
