import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginTools, type AppToolOptions } from './tools';
import { PluginJournal } from './journal';
import { abortable, boundedClose, deadlineSignal } from './execution';
import type { MachinePlugin } from './catalog';
const clean:Array<()=>unknown|Promise<unknown>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const reads=['get_workspace','get_workspace_status','get_session','get_session_status','list_messages'];
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
const ok=(id:unknown,result:unknown)=>Response.json({jsonrpc:'2.0',id,result});
const success=(id:unknown)=>ok(id,{content:[{type:'text',text:'observed result'}]});
type Handler=(message:any,request:Request)=>Response|Promise<Response>;
function fixture(handler?:Handler,options:AppToolOptions={},init?:Handler){
  const calls:any[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,error(){return new Response(null,{status:500});},async fetch(request){
    if(request.method!=='POST')return new Response(null,{status:405});
    const message=await request.json() as any;
    if(message.id===undefined)return new Response(null,{status:202});
    if(message.method==='initialize')return init?init(message,request):ok(message.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
    if(message.method==='tools/list')return ok(message.id,{tools:[...reads,'mutate','contradictory'].map(name=>({name,inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:name!=='mutate',destructiveHint:name==='contradictory'}}))});
    calls.push(message);return handler?handler(message,request):success(message.id);
  }});
  clean.push(()=>server.stop(true));
  const plugin:MachinePlugin={id:'connection',provider:'conductor',name:'Fixture',transport:'http',url:`http://127.0.0.1:${server.port}/mcp`};
  const connection=pluginTools(()=>[plugin],{limits:{operation:400,call:100,connect:100,discover:100,cleanup:100,backoff:1},...options});
  clean.push(()=>connection.close());
  return {calls,connection,plugin,stop:()=>server.stop(true),call:(name='mutate',signal?:AbortSignal,id:string=crypto.randomUUID(),args:Record<string,unknown>={})=>connection.tools[1]!.execute(id,{connectionId:plugin.id,tool:name,arguments:args},signal,undefined,{} as never)};
}
function error(result:any){return JSON.parse(result.content[0].text).error;}
function journal(){const dir=mkdtempSync(join(tmpdir(),'plugin-deadline-'));const value=new PluginJournal(dir);clean.push(()=>{value.close();rmSync(dir,{recursive:true,force:true});});return {value,dir};}
for(const name of reads)test(`Conductor ${name} returns an observed result`,async()=>{const f=fixture();expect((await f.call(name)).content).toEqual([{type:'text',text:'observed result'}]);expect(f.calls).toHaveLength(1);});
test('a delayed response below the deadline succeeds',async()=>{const entered=deferred<void>(),release=deferred<void>();const f=fixture(async m=>{entered.resolve();await release.promise;return success(m.id);});const work=f.call();await entered.promise;release.resolve();expect((await work).details).toEqual({isError:false});});
test('a never-ending HTTP call returns structured uncertainty and never retries mutation',async()=>{const f=fixture(()=>new Promise(()=>{}));const result=await f.call();expect(error(result)).toMatchObject({code:'PLUGIN_TIMEOUT',phase:'call',outcome:'unknown',retryable:false});expect(f.calls).toHaveLength(1);});
test('connection setup is bounded before dispatch',async()=>{const f=fixture(undefined,{},()=>new Promise(()=>{}));expect(error(await f.call())).toMatchObject({code:'PLUGIN_TIMEOUT',phase:'connect',outcome:'not_sent'});expect(f.calls).toHaveLength(0);});
test('a partial JSON response cannot keep the operation open',async()=>{const f=fixture(()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"jsonrpc":'));c.close();}}),{headers:{'content-type':'application/json'}}));const result=await f.call();expect(error(result).outcome).toBe('unknown');expect(JSON.stringify(result)).not.toContain('secret-body');expect(f.calls).toHaveLength(1);});
test('an interrupted SSE stream is bounded without reconnecting or replaying',async()=>{const f=fixture(()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('event: message\ndata: {'));c.close();}}),{headers:{'content-type':'text/event-stream'}}));expect(error(await f.call()).code).toBe('PLUGIN_TIMEOUT');expect(f.calls).toHaveLength(1);});
test('SSE progress does not extend the absolute deadline',async()=>{let timer:ReturnType<typeof setInterval>;const f=fixture(m=>new Response(new ReadableStream({start(c){timer=setInterval(()=>c.enqueue(new TextEncoder().encode('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:m.id,progress:1}})+'\n\n')),5);},cancel(){clearInterval(timer);}}),{headers:{'content-type':'text/event-stream'}}));clean.push(()=>clearInterval(timer));expect(error(await f.call()).code).toBe('PLUGIN_TIMEOUT');expect(f.calls).toHaveLength(1);});
test('user cancellation reaches the HTTP stream and a following call succeeds',async()=>{const entered=deferred<void>(),closed=deferred<void>();let first=true;const f=fixture(m=>{if(!first)return success(m.id);first=false;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(': waiting\n\n'));entered.resolve();},cancel(){closed.resolve();}}),{headers:{'content-type':'text/event-stream'}});});const controller=new AbortController();const work=f.call('mutate',controller.signal);await entered.promise;controller.abort();expect(error(await work).code).toBe('PLUGIN_CANCELLED');const bound=deadlineSignal(new AbortController().signal,1000);try{await abortable(closed.promise,bound.signal);}finally{bound.dispose();}expect((await f.call('get_session')).details).toEqual({isError:false});});
test('cancelling one operation does not cancel another connection',async()=>{const entered=deferred<void>();const f=fixture(m=>{if(m.params.arguments.block){entered.resolve();return new Promise(()=>{});}return success(m.id);});const controller=new AbortController();const blocked=f.call('mutate',controller.signal,crypto.randomUUID(),{block:true});await entered.promise;const other=f.call('get_session');controller.abort();expect(error(await blocked).code).toBe('PLUGIN_CANCELLED');expect((await other).details).toEqual({isError:false});});
for(const status of [401,403,404,429,500,503])test(`Conductor HTTP ${status} is sanitized and retries only eligible reads`,async()=>{const f=fixture(()=>new Response('secret-provider-payload',{status}));const result=await f.call('get_session');expect(f.calls.length).toBe(status===429||status>=500?2:1);expect(JSON.stringify(result)).not.toContain('secret-provider-payload');expect(error(result).code).toBe(status===401||status===403?'PLUGIN_AUTH_FAILED':status===404?'PLUGIN_NOT_FOUND':status===429?'PLUGIN_RATE_LIMITED':'PLUGIN_REMOTE_FAILED');});
test('Retry-After outside the remaining budget prevents retry',async()=>{const f=fixture(()=>new Response(null,{status:429,headers:{'retry-after':'10'}}));expect(error(await f.call('get_session')).code).toBe('PLUGIN_RATE_LIMITED');expect(f.calls).toHaveLength(1);});
test('an idempotent read retries once and observes success',async()=>{let attempts=0;const f=fixture(m=>++attempts===1?new Response(null,{status:503}):success(m.id));expect((await f.call('get_workspace')).content).toEqual([{type:'text',text:'observed result'}]);expect(f.calls).toHaveLength(2);});
test('a timeout of a read can retry but never beyond two attempts',async()=>{const f=fixture(()=>new Promise(()=>{}));expect(error(await f.call('get_workspace')).code).toBe('PLUGIN_TIMEOUT');expect(f.calls).toHaveLength(2);});
test('a tool outside the explicit read allowlist is never retried',async()=>{const f=fixture(()=>new Response(null,{status:503}));await f.call('contradictory');expect(f.calls).toHaveLength(1);});
test('status polling finishes after three observations for the same session',async()=>{const f=fixture();for(let i=0;i<3;i++)expect((await f.call('get_session_status',undefined,crypto.randomUUID(),{session_id:'s'})).details).toEqual({isError:false});expect(error(await f.call('list_messages',undefined,crypto.randomUUID(),{session_id:'s'})).code).toBe('PLUGIN_POLL_LIMIT');expect(f.calls).toHaveLength(3);});
for(const name of reads)test(`poll quota includes retries for ${name}`,async()=>{
  const f=fixture(()=>new Response(null,{status:503}));
  const args={session_id:'retry-session'};
  expect(error(await f.call(name,undefined,crypto.randomUUID(),args)).code).toBe('PLUGIN_REMOTE_FAILED');
  expect(f.calls).toHaveLength(2);
  expect(error(await f.call(name,undefined,crypto.randomUUID(),args)).code).toBe('PLUGIN_REMOTE_FAILED');
  expect(f.calls).toHaveLength(3);
  expect(error(await f.call(name,undefined,crypto.randomUUID(),args)).code).toBe('PLUGIN_POLL_LIMIT');
  expect(f.calls).toHaveLength(3);
});
test('refresh ignoring cancellation is bounded and cannot dispatch later',async()=>{const release=deferred<void>();let fetched=0;const plugin:MachinePlugin={id:'expired',name:'Expired',provider:'conductor',transport:'http',url:'http://127.0.0.1:1/mcp',credentialExpiresAt:0};const connection=pluginTools(()=>[plugin],{limits:{operation:20},refresh:async(_id,signal)=>{fetched++;await release.promise;expect(signal!.aborted).toBe(true);}});clean.push(()=>connection.close());const result=await connection.tools[1]!.execute('refresh',{connectionId:'expired',tool:'mutate',arguments:{}},undefined,undefined,{} as never);expect(error(result)).toMatchObject({code:'PLUGIN_TIMEOUT',outcome:'not_sent'});release.resolve();await Bun.sleep(1);expect(fetched).toBe(1);});
test('late results cannot overwrite journal uncertainty or replay the same tool ID',async()=>{const {value,dir}=journal();const entered=deferred<void>(),release=deferred<void>();const f=fixture(async m=>{entered.resolve();await release.promise;return success(m.id);},{journal:value,runId:'root'});const work=f.call('mutate',undefined,'stable',{secret:'argument-sentinel'});await entered.promise;expect(value.get('root','stable')).toMatchObject({status:'running',outcome:'unknown'});const result=await work;const saved=value.snapshot('root');expect(error(result).requestId).toBe(saved.pluginCalls[0]!.requestId);release.resolve();await Bun.sleep(5);expect(value.snapshot('root')).toEqual(saved);await f.call('mutate',undefined,'stable');expect(f.calls).toHaveLength(1);expect(JSON.stringify(saved)).not.toContain('argument-sentinel');expect(readFileSync(join(dir,'plugin-calls.sqlite-wal')).includes(Buffer.from('argument-sentinel'))).toBe(false);});
test('restart marks pending intent unknown and preserves IDs without executing it again',async()=>{const {value}=journal();const f=fixture(()=>new Promise(()=>{}),{journal:value,runId:'root'});const work=f.call('mutate',undefined,'stable');while(!f.calls.length)await Bun.sleep(1);value.interrupt();const saved=value.get('root','stable')!;expect(saved).toMatchObject({status:'interrupted',code:'PLUGIN_RESTARTED',outcome:'unknown'});await work;expect(value.get('root','stable')).toEqual(saved);await f.call('mutate',undefined,'stable');expect(f.calls).toHaveLength(1);});
test('non-cooperative cleanup is bounded',async()=>{await boundedClose(()=>new Promise(()=>{}),10);});
test('remote tool errors reach the model without leaking provider error payloads',async()=>{const codes:string[]=[];const f=fixture(m=>ok(m.id,{isError:true,content:[{type:'text',text:'provider-secret-sentinel'}]}),{onFailure:code=>codes.push(code)});const result=await f.call();expect(error(result)).toMatchObject({code:'PLUGIN_REMOTE_FAILED',outcome:'confirmed'});expect(JSON.stringify(result)).not.toContain('provider-secret-sentinel');expect(codes).toEqual(['PLUGIN_REMOTE_FAILED']);expect(f.calls).toHaveLength(1);});
test('structured provider task IDs are passed through as observed results',async()=>{const f=fixture(m=>ok(m.id,{content:[{type:'text',text:'Accepted'}],structuredContent:{taskId:'observed-task',status:'running'}}));expect((await f.call()).content).toEqual([{type:'text',text:'Accepted'},{type:'text',text:JSON.stringify({taskId:'observed-task',status:'running'})}]);});
test('credentials and provider exceptions are absent from returned errors and console logs',async()=>{const original=globalThis.fetch,logs:unknown[]=[];const priorError=console.error,priorWarn=console.warn;console.error=(...args)=>{logs.push(args);};console.warn=(...args)=>{logs.push(args);};globalThis.fetch=(async()=>{throw Error('credential-secret-sentinel');}) as unknown as typeof fetch;const connection=pluginTools(()=>[{id:'fixture',provider:'custom',name:'Fixture',transport:'http',url:'https://fixture.invalid/mcp',headers:{Authorization:'Bearer credential-secret-sentinel'}}]);try{const result=await connection.tools[1]!.execute('id',{connectionId:'fixture',tool:'mutate',arguments:{secret:'argument-sentinel'}},undefined,undefined,{} as never);expect(JSON.stringify([logs,result])).not.toContain('credential-secret-sentinel');expect(JSON.stringify([logs,result])).not.toContain('argument-sentinel');}finally{await connection.close();globalThis.fetch=original;console.error=priorError;console.warn=priorWarn;}});
test('a physical connection loss is bounded and cannot replay a mutation',async()=>{const entered=deferred<void>();const f=fixture(()=>{entered.resolve();return new Promise(()=>{});});const pending=f.call();await entered.promise;await f.stop();expect(error(await pending).outcome).toBe('unknown');expect(f.calls).toHaveLength(1);});
test('a model cannot replay an uncertain mutation under a new tool ID in the same run',async()=>{let first=true;const f=fixture(m=>{if(first){first=false;return new Response(null,{status:503});}return success(m.id);});expect(error(await f.call()).outcome).toBe('unknown');expect(error(await f.call())).toMatchObject({code:'PLUGIN_RECONCILIATION_REQUIRED',outcome:'not_sent'});expect(f.calls).toHaveLength(1);expect((await f.call('get_session')).details).toEqual({isError:false});});
test('disk reopen retains request IDs and prevents replay after daemon recovery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'plugin-reopen-'));
  let journal=new PluginJournal(dir);
  const record={requestId:crypto.randomUUID(),runId:'durable-root',toolCallId:'durable-tool',connectionId:'connection',tool:'mutate',attempt:1,phase:'call' as const,status:'running' as const,outcome:'unknown' as const,startedAt:Date.now(),deadlineAt:Date.now()+1000,updatedAt:Date.now()};
  journal.save(record);journal.close();journal=new PluginJournal(dir);journal.interrupt();
  const f=fixture(undefined,{journal,runId:record.runId});
  try{
    const result=await f.call('mutate',undefined,record.toolCallId);
    expect(error(result)).toMatchObject({code:'PLUGIN_RESTARTED',requestId:record.requestId,outcome:'unknown'});
    expect(f.calls).toHaveLength(0);
    expect(journal.snapshot(record.runId).pluginCallVersion).toBe(2);
  }finally{await f.connection.close();journal.close();rmSync(dir,{recursive:true,force:true});}
});
test('settling a run persists interrupted tool metadata before exposing terminal status',async()=>{
  const {RunJournal}=await import('../agent/src/journal');
  const dir=mkdtempSync(join(tmpdir(),'plugin-run-settle-'));
  const runs=new RunJournal(join(dir,'runs.sqlite')),plugins=new PluginJournal(dir);
  const root=crypto.randomUUID();runs.accept(root,{content:'hello',instructions:''});
  plugins.save({requestId:crypto.randomUUID(),runId:root,toolCallId:'pending',connectionId:'connection',tool:'mutate',attempt:1,phase:'call',status:'running',outcome:'unknown',startedAt:Date.now(),deadlineAt:Date.now()+1000,updatedAt:Date.now()});
  try{runs.settleGroup(root,'cancelled',null,null);expect(runs.get(root)).toMatchObject({status:'cancelled',pluginCalls:[{status:'interrupted',code:'PLUGIN_CANCELLED',outcome:'unknown'}]});}
  finally{runs.close();plugins.close();rmSync(dir,{recursive:true,force:true});}
});

test('polling retains the first operation deadline including preparation',async()=>{const {value}=journal();const f=fixture(undefined,{journal:value,runId:'poll-root'});await f.call('get_session_status',undefined,'poll-one',{session_id:'session'});await f.call('get_session_status',undefined,'poll-two',{session_id:'session'});expect(value.get('poll-root','poll-two')!.deadlineAt).toBe(value.get('poll-root','poll-one')!.deadlineAt);});

test('repeated get_session reads cannot bypass the session polling limit',async()=>{const f=fixture();for(let i=0;i<3;i++)await f.call('get_session',undefined,crypto.randomUUID(),{session_id:'same'});expect(error(await f.call('get_session',undefined,crypto.randomUUID(),{session_id:'same'})).code).toBe('PLUGIN_POLL_LIMIT');expect(f.calls).toHaveLength(3);});
