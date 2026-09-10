import {createHash} from 'node:crypto';
import {db} from './store';
import {requireHostedActivation} from './activation';
import {verifyModelGatewayToken,type ModelGatewayClaims} from './model-gateway-token';
import {normalizeAzureOpenAIBaseUrl} from './azure-openai';
import {azureReasoningOverride,type AzureReasoningOverride} from './azure-reasoning';

export const MODEL_GATEWAY_MAX_REQUEST_BYTES=96*1024*1024;
export const MODEL_GATEWAY_BODY_BUDGET_BYTES=128*1024*1024;
// Encoded bytes, not an RSS estimate: parsing/serialization may briefly retain several
// copies (UTF-8 input, UTF-16 text and JSON objects). Share the cap across gateway instances.
const sharedBodyBudget={used:0,limit:MODEL_GATEWAY_BODY_BUDGET_BYTES};
const RESPONSE_LIMIT=64*1024*1024,EVENT_LIMIT=16*1024*1024,DEADLINE=10*60_000;
const prefix='/api/model-gateway/';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const routes={
 google:{api:'google-generative-ai',base:'https://generativelanguage.googleapis.com/v1beta',key:['GOOGLE_API_KEY','GEMINI_API_KEY']},
 anthropic:{api:'anthropic-messages',base:'https://api.anthropic.com',key:['ANTHROPIC_API_KEY']},
 azure:{api:'openai-responses',base:'',key:['AZURE_OPENAI_API_KEY']},
 openai:{api:'openai-responses',base:'https://api.openai.com/v1',key:['OPENAI_API_KEY']},
 openrouter:{api:'openai-completions',base:'https://openrouter.ai/api/v1',key:['OPENROUTER_API_KEY']},
 zai:{api:'openai-completions',base:'https://api.z.ai/api/coding/paas/v4',key:['ZAI_API_KEY']},
} as const;
type Api=typeof routes[keyof typeof routes]['api'];
export type GatewayUsage={input:number;output:number;cacheRead:number;cacheWrite:number;totalTokens:number};
type Dependencies={sql?:any;fetch?:typeof fetch;modelApi?:(provider:string,id:string)=>Promise<string|undefined>;authorize?:(ownerId:string,sql:any)=>Promise<void>;key?:(provider:string)=>string|undefined;azureBaseUrl?:string;azureReasoning?:AzureReasoningOverride;deadlineMs?:number;bodyDeadlineMs?:number;maxConcurrent?:number;bodyBudgetBytes?:number};
class GatewayError extends Error{constructor(readonly code:string,readonly status=400){super(code);}}
function fail(code:string,status=400):never{throw new GatewayError(code,status);}
function problem(code:string,status:number){return Response.json({error:{type:'model_gateway_error',code,message:code}},{status,headers:{'cache-control':'no-store'}});}
function sha(value:string|Uint8Array){return createHash('sha256').update(value).digest('hex');}
let catalog:Promise<import('@earendil-works/pi-coding-agent').ModelRuntime>|undefined;
async function modelApi(provider:string,id:string){
 catalog??=(async()=>{const [{ModelRuntime},{InMemoryCredentialStore}]=await Promise.all([import('@earendil-works/pi-coding-agent'),import('@earendil-works/pi-ai')]);return ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});})();
 return (await catalog).getModel(provider,id)?.api;
}
async function boundedBody(request:Request,reserve:(bytes:number)=>void,deadlineMs=30_000){
 const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>MODEL_GATEWAY_MAX_REQUEST_BYTES))fail('model_request_too_large',413);
 if(!request.body)fail('model_request_invalid');
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0,timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;void reader.cancel().catch(()=>{});},deadlineMs);
 try{while(true){const {done,value}=await reader.read();if(timedOut)fail('model_body_timeout',408);if(done)break;size+=value.byteLength;if(size>MODEL_GATEWAY_MAX_REQUEST_BYTES)fail('model_request_too_large',413);reserve(value.byteLength);chunks.push(value);}}finally{clearTimeout(timer);await reader.cancel().catch(()=>{});}
 try{const parsed=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail('model_request_invalid');return parsed;}catch(error){if(error instanceof GatewayError)throw error;fail('model_request_invalid');}
}
/** Only self-contained Pi messages/tools may use the shared provider account. */
function sanitizeBody(body:any,api:Api,model:string){
 if(api!=='google-generative-ai'&&body.model!==model)fail('model_selection_mismatch',403);
 if(body.models!==undefined||body.previous_response_id!=null||body.conversation!=null||body.background===true||body.cachedContent!=null)fail('model_remote_state_forbidden',403);
 if(body.audio!==undefined||(body.modalities!==undefined&&JSON.stringify(body.modalities)!=='["text"]')||body.generationConfig?.speechConfig!==undefined||(body.generationConfig?.responseModalities!==undefined&&JSON.stringify(body.generationConfig.responseModalities)!=='["TEXT"]'))fail('model_hosted_option_forbidden',403);
 for(const key of ['plugins','transforms','provider','route','session_id'])if(body[key]!==undefined)fail('model_hosted_option_forbidden',403);
 if(body.service_tier!==undefined||body.priority!==undefined||body.web_search_options!==undefined||body.speed!==undefined)fail('model_hosted_option_forbidden',403);
 // Some Pi catalog models advertise provider fallback models. This run is pinned.
 delete body.fallbacks;
 if(api==='openai-responses'||api==='openai-completions')body.store=false;
 if(api==='openai-completions'&&body.stream===true)body.stream_options={include_usage:true};
 const tools=body.tools;
 if(tools!==undefined){
  if(!Array.isArray(tools)||tools.length>256)fail('model_tools_invalid');
  for(const tool of tools){
   if(!tool||typeof tool!=='object')fail('model_tools_invalid');
   if(api==='google-generative-ai'){if(Object.keys(tool).some(key=>key!=='functionDeclarations'))fail('model_hosted_tool_forbidden',403);}
   else if(api==='anthropic-messages'){if(tool.type!==undefined&&tool.type!=='custom')fail('model_hosted_tool_forbidden',403);}
   else if(tool.type!=='function'&&!(api==='openai-responses'&&tool.type==='custom'))fail('model_hosted_tool_forbidden',403);
  }
 }
 // Inspect only wire content, never arbitrary function argument strings or user text.
 const walk=(value:any,depth=0)=>{if(depth>64)fail('model_request_invalid');if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){for(const item of value)walk(item,depth+1);return;}
  if(value.file_id!=null||value.file_uri!=null||value.fileUri!=null||value.container_id!=null||value.vector_store_ids!=null)fail('model_remote_state_forbidden',403);
  if(value.type==='item_reference'||value.type==='container_reference')fail('model_remote_state_forbidden',403);
  for(const [key,item] of Object.entries(value))if(key!=='parameters'&&key!=='input_schema'&&key!=='arguments')walk(item,depth+1);
 };
 for(const key of ['messages','input','contents','system','systemInstruction'])walk(body[key]);
 // These can refer to shared provider resources or enable unmetered hosted behavior.
 for(const key of ['container','mcp_servers','context_management','prompt','vector_store_ids'])if(body[key]!=null)fail('model_remote_state_forbidden',403);
 return body;
}
function target(provider:keyof typeof routes,api:string,suffix:string,url:URL,body:any,model:string,azureBaseUrl?:string){
 const route=routes[provider];if(api!==route.api&&!(provider==='openrouter'&&api==='anthropic-messages'))fail('model_protocol_mismatch',403);
 let path:string;
 if(provider==='google'){
  const expected='/models/'+model;
  if(suffix!==expected+':streamGenerateContent'&&suffix!==expected+':generateContent')fail('model_path_forbidden',403);
  const streaming=suffix.endsWith(':streamGenerateContent');
  if([...url.searchParams].some(([key,value])=>key!=='alt'||value!=='sse')||url.searchParams.getAll('alt').length>1||(!streaming&&url.search))fail('model_path_forbidden',403);
  path=suffix+(streaming?'?alt=sse':'');
 }else{
  const expected=api==='anthropic-messages'?'/v1/messages':api==='openai-responses'?'/responses':'/chat/completions';
  if(suffix!==expected)fail('model_path_forbidden',403);
  if(url.search&&!(api==='anthropic-messages'&&url.search==='?beta=true'))fail('model_path_forbidden',403);path=expected+url.search;
 }
 let base:string;
 if(provider==='azure'){try{base=normalizeAzureOpenAIBaseUrl(azureBaseUrl);}catch{fail('model_provider_unavailable',503);}}
 else base=provider==='openrouter'&&api==='anthropic-messages'?'https://openrouter.ai/api':route.base;
 const normalized=sanitizeBody(body,api as Api,model);
 // Foundry's project endpoint requires the message discriminator for content arrays.
 if(provider==='azure'&&Array.isArray(normalized.input))for(const item of normalized.input){
  if(item&&typeof item==='object'&&item.type===undefined&&['system','developer','user','assistant'].includes(item.role))item.type='message';
 }
 return {url:base+path,body:normalized,api:api as Api};
}
function count(value:unknown):number{if(!Number.isSafeInteger(value)||Number(value)<0)throw Error('model_usage_invalid');return Number(value);}
function usage(api:Api,value:any):GatewayUsage{
 let input:number,output:number,cacheRead=0,cacheWrite=0,totalTokens:number;
 if(api==='anthropic-messages'){input=count(value.input_tokens);output=count(value.output_tokens);cacheRead=count(value.cache_read_input_tokens??0);cacheWrite=count(value.cache_creation_input_tokens??0);totalTokens=input+output+cacheRead+cacheWrite;}
 else if(api==='google-generative-ai'){cacheRead=count(value.cachedContentTokenCount??0);input=count(value.promptTokenCount)-cacheRead;output=count(value.candidatesTokenCount??0)+count(value.thoughtsTokenCount??0);totalTokens=count(value.totalTokenCount);}
 else if(api==='openai-responses'){cacheRead=count(value.input_tokens_details?.cached_tokens??0);input=count(value.input_tokens)-cacheRead;output=count(value.output_tokens);totalTokens=count(value.total_tokens??(count(value.input_tokens)+output));}
 else{cacheRead=count(value.prompt_tokens_details?.cached_tokens??value.prompt_cache_hit_tokens??value.cached_tokens??0);cacheWrite=count(value.prompt_tokens_details?.cache_write_tokens??0);input=count(value.prompt_tokens)-cacheRead-cacheWrite;output=count(value.completion_tokens);totalTokens=count(value.total_tokens??(count(value.prompt_tokens)+output));}
 if(input<0||![input,output,cacheRead,cacheWrite,totalTokens].every(Number.isSafeInteger))throw Error('model_usage_invalid');
 return {input,output,cacheRead,cacheWrite,totalTokens};
}
/** Bounded parser retains usage metadata, never message text or tool arguments. */
class Observation{
 private pending='';private decoder=new TextDecoder();private raw:any;private terminal=false;private invalid=false;private providerFailed=false;
 constructor(private api:Api,private streaming:boolean){}
 get failed(){return this.providerFailed;}
 private event(value:any){
  if(this.api==='anthropic-messages'){
   if(value.type==='message_start')this.raw=value.message?.usage;
   if(value.type==='message_delta'&&value.usage)this.raw={...this.raw,...value.usage};
   if(value.type==='message_stop')this.terminal=true;
   if(value.type==='error')this.providerFailed=true;
  }else if(this.api==='openai-responses'){
   if(['response.completed','response.failed','response.incomplete'].includes(value.type)){this.raw=value.response?.usage;this.terminal=true;this.providerFailed=value.type!=='response.completed';}
   if(value.type==='error')this.providerFailed=true;
  }else if(this.api==='openai-completions'){
   if(value.usage)this.raw=value.usage;
   if(value.error)this.providerFailed=true;
  }else{
   if(value.usageMetadata)this.raw=value.usageMetadata;
   if(value.candidates?.some((candidate:any)=>candidate.finishReason)||value.promptFeedback?.blockReason)this.terminal=true;
   if(value.error)this.providerFailed=true;
  }
 }
 write(bytes:Uint8Array){
  this.pending+=this.decoder.decode(bytes,{stream:true});if(this.pending.length>EVENT_LIMIT)throw Error('model_response_too_large');
  if(!this.streaming)return;
  let match:RegExpExecArray|null;
  while((match=/\r?\n\r?\n/.exec(this.pending))){const frame=this.pending.slice(0,match.index);this.pending=this.pending.slice(match.index+match[0].length);
   const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
   if(!data)continue;if(data==='[DONE]'){if(this.api==='openai-completions')this.terminal=true;continue;}
   try{this.event(JSON.parse(data));}catch{this.invalid=true;}
  }
 }
 finish(clean:boolean){
  if(!this.streaming&&clean){try{const value=JSON.parse(this.pending);this.raw=this.api==='google-generative-ai'?value.usageMetadata:value.usage;this.terminal=this.api==='anthropic-messages'?!!value.stop_reason:this.api==='openai-responses'?['completed','failed','incomplete'].includes(value.status):this.api==='google-generative-ai'?!!value.candidates?.some((c:any)=>c.finishReason):!!value.choices?.some((c:any)=>c.finish_reason);this.providerFailed=!!value.error||value.status==='failed';}catch{this.invalid=true;}}
  // Google has no explicit stream terminator: a clean EOF is required.
  const complete=this.terminal&&!this.invalid&&(this.api!=='google-generative-ai'||clean)&&(!this.streaming||!clean||!this.pending.trim());
  if(complete&&this.raw){try{return {usage:usage(this.api,this.raw),status:this.providerFailed?'failed' as const:'succeeded' as const};}catch{}}
  return {usage:null,status:'interrupted' as const};
 }
}

export function createModelGateway(deps:Dependencies={}){
 const azureReasoning=deps.azureReasoning??azureReasoningOverride();
 const sql=deps.sql??db,send=deps.fetch??fetch,authorize=deps.authorize??requireHostedActivation,lookup=deps.modelApi??modelApi;
 const active=new Set<Promise<void>>();let admitted=0;
 const bodyBudget=deps.bodyBudgetBytes===undefined?sharedBodyBudget:{used:0,limit:deps.bodyBudgetBytes};
 async function allowed(claims:ModelGatewayClaims){
  const [run]=await sql`SELECT r.id,r.model_provider,r.model_id,c.owner_id,c.agent_secret,c.endpoint_secret FROM runs r JOIN companions c ON c.id=r.companion_id
   WHERE r.id=${claims.runId} AND c.id=${claims.companionId} AND r.dispatched=true AND r.usage_source='gateway'
   AND r.status IN ('preparing','running','needs_input') AND NOT r.cancel_requested AND c.retired_at IS NULL AND c.archive_requested_at IS NULL`;
  if(!run||claims.expiresAt<=Date.now()||sha(run.agent_secret)!==claims.credentialDigest||sha(run.endpoint_secret??'')!==claims.endpointDigest)fail('model_run_forbidden',403);
  try{await authorize(run.owner_id,sql);}catch{fail('subscription_required',403);}
  if(claims.expiresAt<=Date.now())fail('model_authentication_required',401);return run;
 }
 async function settle(id:string,status:'failed'|'interrupted'|'succeeded',code:string|null,upstreamStatus:number|null,value:GatewayUsage|null){
  await sql`UPDATE model_gateway_requests SET status=${status},error_code=${code},upstream_status=${upstreamStatus},usage=${value}::jsonb,usage_verified=${!!value},finished_at=now() WHERE id=${id} AND status='forwarding'`;
 }
 async function handle(request:Request):Promise<Response|null>{
  const url=new URL(request.url);if(!url.pathname.startsWith(prefix))return null;
  let claimed:string|undefined,upstreamStatus:number|null=null;let release=()=>{},bodyBytes=0;
  const reserveBody=(bytes:number)=>{if(bodyBudget.used+bytes>bodyBudget.limit)fail('model_body_budget_exhausted',503);bodyBudget.used+=bytes;bodyBytes+=bytes;};
  const releaseBody=()=>{bodyBudget.used-=bodyBytes;bodyBytes=0;};
  try{
   if(request.method!=='POST')fail('model_method_forbidden',405);
   const claims=verifyModelGatewayToken(request.headers.get('x-companions-model-token')??'');
   const id=request.headers.get('x-companions-model-request-id')??'',runId=request.headers.get('x-companions-run-id');
   if(!claims||claims.runId!==runId||!uuid.test(id))fail('model_authentication_required',401);
   if(admitted>=(deps.maxConcurrent??8))fail('model_gateway_busy',503);admitted++;release=()=>{admitted--;};
   const run=await allowed(claims),parts=url.pathname.slice(prefix.length).split('/'),wireProvider=parts.shift() as keyof typeof routes,api=parts.shift()??'',suffix='/'+parts.join('/');
   const provider=run.model_provider as keyof typeof routes;
   if(!Object.hasOwn(routes,provider)||!Object.hasOwn(routes,wireProvider)||(wireProvider!==provider&&!(provider==='azure'&&wireProvider==='openai')))fail('model_selection_mismatch',403);
   if(await lookup(wireProvider,run.model_id)!==api)fail('model_protocol_mismatch',403);
   const key=deps.key?deps.key(provider):routes[provider].key.map(name=>process.env[name]).find(Boolean);if(!key)fail('model_provider_unavailable',503);
   let body=await boundedBody(request,reserveBody,deps.bodyDeadlineMs);
   const wire=target(provider,api,suffix,url,body,run.model_id,deps.azureBaseUrl??process.env.AZURE_OPENAI_BASE_URL);
   if(provider==='azure'&&azureReasoning&&run.model_id===azureReasoning.model){
    wire.body.reasoning={...wire.body.reasoning,effort:azureReasoning.effort};
   }
   let encoded=JSON.stringify(wire.body);const encodedBytes=Buffer.byteLength(encoded);
   if(encodedBytes>MODEL_GATEWAY_MAX_REQUEST_BYTES)fail('model_request_too_large',413);
   if(encodedBytes>bodyBytes)reserveBody(encodedBytes-bodyBytes);
   const streaming=wire.api==='google-generative-ai'?suffix.endsWith(':streamGenerateContent'):body.stream===true;
   const hash=sha(wire.url+'\n'+encoded);
   // A duplicate UUID is always a tombstone, including after process loss. Never replay it.
   const rows=await sql`INSERT INTO model_gateway_requests(id,run_id,companion_id,owner_id,provider,model_id,api,request_hash)
    SELECT ${id},r.id,c.id,c.owner_id,${provider},${run.model_id},${api},${hash} FROM runs r JOIN companions c ON c.id=r.companion_id
    WHERE r.id=${claims.runId} AND c.id=${claims.companionId} AND r.dispatched AND r.usage_source='gateway' AND r.status IN ('preparing','running','needs_input') AND NOT r.cancel_requested
    AND c.retired_at IS NULL AND c.archive_requested_at IS NULL AND c.agent_secret=${run.agent_secret} AND c.endpoint_secret IS NOT DISTINCT FROM ${run.endpoint_secret} AND r.model_provider=${provider} AND r.model_id=${run.model_id}
    ON CONFLICT DO NOTHING RETURNING id`;
   if(!rows.length)fail('model_request_not_replayable',409);claimed=id;
   if(!verifyModelGatewayToken(request.headers.get('x-companions-model-token')??''))fail('model_authentication_required',401);
   await allowed(claims);
   const headers=new Headers({'content-type':'application/json','accept':streaming?'text/event-stream':'application/json'});
   if(provider==='google')headers.set('x-goog-api-key',key);
   else if(provider==='azure')headers.set('api-key',key);
   else if(wire.api==='anthropic-messages'){
    headers.set(provider==='anthropic'?'x-api-key':'authorization',provider==='anthropic'?key:'Bearer '+key);headers.set('anthropic-version','2023-06-01');
    const beta=request.headers.get('anthropic-beta');if(beta&&/^[a-zA-Z0-9,._-]{1,1024}$/.test(beta))headers.set('anthropic-beta',beta);
   }else headers.set('authorization','Bearer '+key);
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),deps.deadlineMs??DEADLINE);
   let upstream:Response;
   try{upstream=await send(wire.url,{method:'POST',headers,body:encoded,redirect:'error',signal:controller.signal});}catch(error){clearTimeout(timer);throw error;}finally{body=null;wire.body=null;encoded='';releaseBody();}
   upstreamStatus=upstream.status;
   if(!upstream.ok||!upstream.body){clearTimeout(timer);await upstream.body?.cancel();await settle(id,'failed','model_provider_rejected',upstream.status,null);claimed=undefined;return problem('model_provider_rejected',502);}
   if(streaming&&!upstream.headers.get('content-type')?.toLowerCase().includes('text/event-stream')){clearTimeout(timer);await upstream.body.cancel();throw Error('model_response_invalid');}
   const observation=new Observation(wire.api,streaming);let downstream:ReadableStreamDefaultController<Uint8Array>,disconnected=false;
   const stream=new ReadableStream<Uint8Array>({start(value){downstream=value;},cancel(){disconnected=true;}},{highWaterMark:1024*1024,size:chunk=>chunk?.byteLength??0});
   const finishRelease=release;release=()=>{};claimed=undefined;
   const pump=(async()=>{
    let clean=false,size=0;const buffered:Uint8Array[]=[];const reader=upstream.body!.getReader();
    try{while(true){const {done,value}=await reader.read();if(done){clean=true;break;}size+=value.byteLength;if(size>RESPONSE_LIMIT)throw Error('model_response_too_large');observation.write(value);if(observation.failed)throw Error('model_provider_failed');
     if(!streaming)buffered.push(value);
     else if(!disconnected){if((downstream!.desiredSize??0)<0){disconnected=true;downstream!.error(Error('model_client_too_slow'));}else downstream!.enqueue(value);}
    }}catch{controller.abort();}finally{
     clearTimeout(timer);await reader.cancel().catch(()=>{});const result=observation.finish(clean);
     try{await settle(id,result.status,result.status==='interrupted'?'model_response_interrupted':result.status==='failed'?'model_provider_failed':null,upstream.status,result.usage);
      if(!disconnected){if(result.status==='interrupted'||result.status==='failed')downstream!.error(Error(result.status==='failed'?'model_provider_failed':'model_response_interrupted'));else{for(const chunk of buffered)downstream!.enqueue(chunk);downstream!.close();}}
     }catch{if(!disconnected)downstream!.error(Error('model_checkpoint_failed'));}finally{finishRelease();}
    }
   })();active.add(pump);void pump.finally(()=>active.delete(pump));
   return new Response(stream,{headers:{'content-type':streaming?'text/event-stream':'application/json','cache-control':'no-store','x-accel-buffering':'no'}});
  }catch(error){
   if(claimed)await settle(claimed,'interrupted',error instanceof GatewayError?error.code:'model_upstream_interrupted',upstreamStatus,null).catch(()=>{});
   return problem(error instanceof GatewayError?error.code:'model_upstream_interrupted',error instanceof GatewayError?error.status:502);
  }finally{releaseBody();release();}
 }
 return {handle,async drain(){await Promise.allSettled([...active]);}};
}
const gateway=createModelGateway();
export const handleModelGateway=gateway.handle;
