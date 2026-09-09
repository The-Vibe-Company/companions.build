import { expect, test } from "bun:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { guardedInitialization } from "../src/pi-executor";
import { configureModelGateway, modelGatewayStream, modelGatewayUrl, withModelGatewayRequest } from "../src/model-gateway";
import {configureAzureFoundry,normalizeAzureFoundryBaseUrl} from '../src/azure-foundry';

test("a cancelled late initializer is disposed and cannot return a prompt-capable session", async () => {
  let resolve!: (value: { dispose(): void }) => void;
  let disposed = false;
  const work = new Promise<{ dispose(): void }>(done => { resolve = done; });
  const controller = new AbortController();
  const guarded = guardedInitialization(work, controller.signal, 1_000);
  controller.abort();
  await expect(guarded).rejects.toThrow("RUN_CANCELLED");
  resolve({ dispose: () => { disposed = true; } });
  await Bun.sleep(0);
  expect(disposed).toBe(true);
});

test("a timed-out late initializer is disposed", async () => {
  let resolve!: (value: { dispose(): void }) => void;
  let disposed = false;
  const work = new Promise<{ dispose(): void }>(done => { resolve = done; });
  await expect(guardedInitialization(work, new AbortController().signal, 1)).rejects.toThrow("INITIALIZATION_TIMEOUT");
  resolve({ dispose: () => { disposed = true; } });
  await Bun.sleep(0);
  expect(disposed).toBe(true);
});

const message={role:"user" as const,content:[{type:"text" as const,text:"hello"}],timestamp:1};
async function runtime(){return ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});}

test("native providers retain their wire protocol while routing every model request through the gateway",async()=>{
 const requests:Array<{url:URL;headers:Headers}>=[];
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){requests.push({url:new URL(request.url),headers:request.headers});return new Response("denied",{status:401});}});
 const pairs=[
  ["google","google-generative-ai",/\/models\/[^/]+:streamGenerateContent$/,"alt","sse"],
  ["anthropic","anthropic-messages",/\/v1\/messages$/,"beta","true"],
  ["openai","openai-responses",/\/responses$/,null,null],
  ["openrouter","anthropic-messages",/\/v1\/messages$/,"beta","true"],
  ["openrouter","openai-completions",/\/chat\/completions$/,null,null],
  ["zai","openai-completions",/\/chat\/completions$/,null,null],
 ] as const;
 try{
  for(const [provider,api,path,query,value] of pairs){
   const models=await runtime(),before=models.getModels(provider).find(model=>model.api===api)!;
   const preserved={api:before.api,baseUrl:before.baseUrl,compat:before.compat,cost:before.cost};
   await configureModelGateway(models,provider,`http://127.0.0.1:${server.port}/api/model-gateway`,true);
   const model=models.getModels(provider).find(value=>value.id===before.id)!;
   expect({api:model.api,baseUrl:model.baseUrl,compat:model.compat,cost:model.cost}).toEqual(preserved);
   const stream=withModelGatewayRequest("11111111-1111-4111-8111-111111111111",{token:"run-scoped-token"},()=>
    models.streamSimple(model,{messages:[message]},{maxRetries:0}));
   for await(const _event of stream){}
   const observed=requests.at(-1)!;
   expect(observed.url.pathname).toStartWith(`/api/model-gateway/${provider}/${api}`);
   expect(observed.url.pathname).toMatch(path);
   if(query)expect(observed.url.searchParams.get(query)).toBe(value);
   expect(observed.headers.get("x-companions-model-token")).toBe("run-scoped-token");
   expect(observed.headers.get("x-companions-run-id")).toBe("11111111-1111-4111-8111-111111111111");
   expect(observed.headers.get("x-companions-model-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  }
  expect(new Set(requests.map(value=>value.headers.get("x-companions-model-request-id"))).size).toBe(pairs.length);
 }finally{server.stop(true);}
});

test("one model invocation keeps its request identity across SDK retries",async()=>{
 const ids:string[]=[];let calls=0;
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){ids.push(request.headers.get("x-companions-model-request-id")!);calls++;return new Response("retry",{status:calls===1?500:401});}});
 try{
  const models=await runtime();await configureModelGateway(models,"zai",`http://127.0.0.1:${server.port}/api/model-gateway`,true);
  const model=models.getModels("zai").find(value=>value.api==="openai-completions")!;
  const stream=withModelGatewayRequest("22222222-2222-4222-8222-222222222222",{token:"another-run-token"},()=>
   models.streamSimple(model,{messages:[message]},{maxRetries:1,maxRetryDelayMs:1}));
  for await(const _event of stream){}
  expect(ids).toHaveLength(2);expect(new Set(ids).size).toBe(1);
 }finally{server.stop(true);}
});

test("gateway contexts isolate concurrent roots and keep a steered root credential",async()=>{
 const seen:Array<{runId:string|null;token:string|null;requestId:string|null}>=[];
 const fake=()=>({} as any);
 const stream=modelGatewayStream("https://companions.test/api/model-gateway","zai",{
  "google-generative-ai":fake,"anthropic-messages":fake,"openai-responses":fake,
  "openai-completions":(_model,_context,options)=>{seen.push({runId:String(options?.headers?.["X-Companions-Run-Id"]??null),token:String(options?.headers?.["X-Companions-Model-Token"]??null),requestId:String(options?.headers?.["X-Companions-Model-Request-Id"]??null)});return {} as any;},
 });
 const model={provider:"zai",api:"openai-completions"} as any,context={messages:[]};
 await Promise.all([
  withModelGatewayRequest("main-root",{token:"main-root-token"},async()=>{stream(model,context);await Bun.sleep(0);stream(model,context);}),
  withModelGatewayRequest("background-root",{token:"background-token"},async()=>{await Bun.sleep(0);stream(model,context);}),
 ]);
 expect(seen.map(({runId,token})=>[runId,token])).toEqual([
  ["main-root","main-root-token"],["main-root","main-root-token"],["background-root","background-token"],
 ]);
 expect(new Set(seen.map(value=>value.requestId)).size).toBe(3);
});

test("gateway URLs fail closed outside the explicit local development hosts",()=>{
 expect(modelGatewayUrl("https://models.companions.build/api/model-gateway")).toBe("https://models.companions.build/api/model-gateway");
 expect(modelGatewayUrl("http://host.docker.internal:4311/api/model-gateway",true)).toBe("http://host.docker.internal:4311/api/model-gateway");
 for(const value of ["http://public.invalid/api/model-gateway","https://models.companions.build/other","https://user:pass@models.companions.build/api/model-gateway"])
  expect(()=>modelGatewayUrl(value,true)).toThrow("INVALID_MODEL_GATEWAY_URL");
});

test('Azure Foundry configuration normalizes the Responses endpoint and preserves native model capabilities',async()=>{
 const models=await runtime();
 let requestUrl='',requestHeaders=new Headers(),requestBody:any;
 const transport=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  requestUrl=input instanceof Request?input.url:String(input);requestHeaders=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));requestBody=JSON.parse(String(init?.body));
  const completed={id:'resp_azure',object:'response',created_at:1,status:'completed',error:null,incomplete_details:null,instructions:null,max_output_tokens:null,model:'gpt-5.6-luna',output:[],parallel_tool_calls:true,previous_response_id:null,reasoning:{effort:'medium',summary:null},store:false,temperature:1,text:{format:{type:'text'},verbosity:'medium'},tool_choice:'auto',tools:[],top_p:1,truncation:'disabled',usage:{input_tokens:4,input_tokens_details:{cached_tokens:0},output_tokens:2,output_tokens_details:{reasoning_tokens:2},total_tokens:6},user:null,metadata:{}};
  return new Response(`data: ${JSON.stringify({type:'response.completed',response:completed})}\n\n`,{headers:{'content-type':'text/event-stream'}});
 }) as unknown as typeof fetch;
 configureAzureFoundry(models,'https://resource.services.ai.azure.com/api/projects/project/openai/v1/responses',transport);
 await models.setRuntimeApiKey('azure-openai-responses','synthetic-azure-key');
 const model=models.getModel('azure-openai-responses','gpt-5.6-luna')!;
 expect({baseUrl:model.baseUrl,reasoning:model.reasoning,input:model.input,maxTokens:model.maxTokens}).toEqual({
  baseUrl:'https://resource.services.ai.azure.com/api/projects/project/openai/v1',reasoning:true,input:['text','image'],maxTokens:128000,
 });
 expect(models.getRegisteredProviderConfig('azure-openai-responses')?.streamSimple).toBeFunction();
 const result=await models.streamSimple(model,{messages:[message],tools:[{name:'bash',description:'Run a command',parameters:{type:'object',properties:{}}} as any]},{reasoning:'medium',maxRetries:0}).result();
 expect(result.stopReason).toBe('stop');
 expect(requestUrl).toBe('https://resource.services.ai.azure.com/api/projects/project/openai/v1/responses');
 expect(requestHeaders.get('api-key')).toBe('synthetic-azure-key');expect(new URL(requestUrl).search).toBe('');
 expect(requestBody).toMatchObject({model:'gpt-5.6-luna',stream:true,store:false,reasoning:{effort:'medium'},tools:[{type:'function',name:'bash'}]});
 expect(()=>normalizeAzureFoundryBaseUrl('https://attacker.invalid/openai/v1/responses')).toThrow('INVALID_AZURE_OPENAI_BASE_URL');
});
