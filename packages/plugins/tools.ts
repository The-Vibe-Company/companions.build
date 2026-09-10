import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MachinePlugin } from './catalog';
import { appBridge } from './bridges';
import { OwnedStdioTransport } from './stdio';
import { abortable, boundedClose, deadlineSignal, PluginFailure, type PluginCall } from './execution';
import type { PluginJournal } from './journal';
import { createHash } from 'node:crypto';

type RemoteTool=Awaited<ReturnType<Client['listTools']>>['tools'][number];
const conductorReads=new Set(['get_workspace','get_workspace_status','get_session','get_session_status','list_messages']);
const limits={operation:90_000,connect:15_000,discover:30_000,call:60_000,cleanup:5_000,backoff:250};
export interface AppToolOptions {
  refresh?:(connectionId:string,signal?:AbortSignal)=>Promise<void>;
  signal?:AbortSignal;runId?:string;journal?:PluginJournal;
  onFailure?:(code:string)=>void;
  /** Deterministic fixtures can use shorter budgets; never exposed as tool arguments. */
  limits?:Partial<typeof limits>;
}
/** Every operation owns its connection. No pending shared connection can lock another call. */
export function pluginTools(getPlugins:()=>MachinePlugin[],options:AppToolOptions={}) {
  const budget={...limits,...options.limits};
  const lifetime=new AbortController(),active=new Set<Promise<void>>();
  const completed=new Map<string,PluginCall>();
  const polls=new Map<string,{count:number;deadline:number}>();
  const selected=(id:string)=>{const plugin=getPlugins().find(p=>p.id===id);if(!plugin)throw Error('PLUGIN_NOT_SELECTED');return plugin;};
  function failure(record:PluginCall){
    return {content:[{type:'text' as const,text:JSON.stringify({error:{code:record.code??'PLUGIN_REMOTE_FAILED',requestId:record.requestId,phase:record.phase,outcome:record.outcome,retryable:false,message:record.status==='succeeded'?'This tool-call ID already completed. Consult its original transcript result; it was not executed again.':record.outcome==='unknown'?'The external result is unknown. Inspect its state before any new mutation; do not claim success.':record.code==='PLUGIN_RECONCILIATION_REQUIRED'?'An earlier external result is unknown. Use read-only inspection and ask the user before starting another mutation.':record.outcome==='confirmed'?'The connected tool returned an error. Do not assume partial external effects were rolled back.':'The connected operation was not sent. Report this error honestly.'}})}],details:{isError:true}};
  }
  async function operation(toolCallId:string,connectionId:string,toolName:string,args:Record<string,unknown>|undefined,signal?:AbortSignal){
    const pluginBefore=selected(connectionId);
    if(args&&pluginBefore.allowedTools&&!pluginBefore.allowedTools.includes(toolName))throw Error('PLUGIN_TOOL_NOT_ALLOWED');
    const runId=options.runId??'standalone';
    const prior=options.journal?.get(runId,toolCallId)??completed.get(toolCallId);
    // Even successful calls are never sent again: the native transcript holds their result.
    if(prior)return failure({...prior,code:prior.code??'PLUGIN_RESTARTED'});
    const parent=AbortSignal.any([lifetime.signal,...(options.signal?[options.signal]:[]),...(signal?[signal]:[])]);
    const total=deadlineSignal(parent,budget.operation);
    let currentSignal=total.signal;
    let record:PluginCall={requestId:crypto.randomUUID(),runId,toolCallId,connectionId,tool:toolName,attempt:1,phase:'prepare',status:'running',outcome:'not_sent',startedAt:Date.now(),deadlineAt:Date.now()+budget.operation,updatedAt:Date.now()};
    const save=(change:Partial<PluginCall>={})=>{record={...record,...change,updatedAt:Date.now()};options.journal?.save(record);completed.set(toolCallId,record);};
    let plugin=pluginBefore;
    let client:Client|undefined,transport:Transport|undefined;
    let transportAbort=new AbortController();
    const stopTransport=async()=>{
      transportAbort.abort();
      const closingClient=client,closingTransport=transport;client=undefined;transport=undefined;
      await boundedClose(async()=>{await Promise.allSettled([closingClient?.close(),closingTransport?.close()]);},budget.cleanup);
    };
    let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});active.add(done);
    async function stage<T>(phase:PluginCall['phase'],ms:number,work:()=>Promise<T>):Promise<T>{
      save({phase});
      const bounded=deadlineSignal(total.signal,Math.min(ms,record.deadlineAt-Date.now()));
      currentSignal=bounded.signal;
      try{bounded.signal.throwIfAborted();return await abortable(Promise.resolve().then(()=>{bounded.signal.throwIfAborted();return work();}),bounded.signal);}
      finally{bounded.dispose();currentSignal=total.signal;}
    }
    async function connect(){
      if(client)return client;
      transportAbort=new AbortController();
      const c=new Client({name:'companions.build',version:'0.2.0'});
      transport=plugin.transport==='stdio'?new OwnedStdioTransport(plugin):new StreamableHTTPClientTransport(new URL(plugin.url!),{
        requestInit:{headers:plugin.headers},
        reconnectionOptions:{maxRetries:0,initialReconnectionDelay:250,maxReconnectionDelay:250,reconnectionDelayGrowFactor:1},
        fetch:async(url,init)=>{
          const fetchSignal=AbortSignal.any([currentSignal,transportAbort.signal,...(init?.signal?[init.signal]:[])]);
          try{
            fetchSignal.throwIfAborted();
            const response=await fetch(url,{...init,signal:fetchSignal});
            if(!response.ok){
              // Never let SDK errors interpolate an untrusted response body.
              void response.body?.cancel().catch(()=>{});
              if(init?.method==='GET'&&response.status===405)return new Response(null,{status:405});
              const code=response.status===401||response.status===403?'PLUGIN_AUTH_FAILED':response.status===404?'PLUGIN_NOT_FOUND':response.status===429?'PLUGIN_RATE_LIMITED':'PLUGIN_REMOTE_FAILED';
              const retry=response.headers.get('retry-after');
              const wait=retry===null?0:/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now());
              throw new PluginFailure(code,response.status===429||response.status>=500,Number.isFinite(wait)?wait:budget.operation);
            }
            return response;
          }catch(error){
            if(fetchSignal.aborted)throw fetchSignal.reason;
            if(error instanceof PluginFailure)throw error;
            throw new PluginFailure('PLUGIN_CONNECTION_FAILED',true);
          }
        },
      });
      client=c;
      await stage('connect',budget.connect,()=>c.connect(transport!,{signal:currentSignal,timeout:budget.connect}));
      return c;
    }
    async function discover():Promise<RemoteTool[]>{
      const bridge=appBridge(plugin);if(bridge)return bridge.tools;
      const c=await connect();
      return stage('discover',budget.discover,async()=>{
        const discovered=new Map<string,RemoteTool>(),cursors=new Set<string>();let cursor:string|undefined;
        for(let page=0;page<100;page++){
          currentSignal.throwIfAborted();
          const catalog=await c.listTools(cursor===undefined?undefined:{cursor},{signal:currentSignal,timeout:Math.min(budget.discover,budget.connect)});
          for(const tool of catalog.tools)if(!plugin.allowedTools||plugin.allowedTools.includes(tool.name))discovered.set(tool.name,tool);
          if(catalog.nextCursor===undefined)return [...discovered.values()];
          if(cursors.has(catalog.nextCursor))throw Error('PLUGIN_CATALOG_PAGINATION_FAILED');
          cursors.add(catalog.nextCursor);cursor=catalog.nextCursor;
        }
        throw Error('PLUGIN_CATALOG_PAGINATION_FAILED');
      });
    }
    try{
      save();
      await stage('prepare',budget.operation,async()=>{
        if(plugin.credentialExpiresAt!==undefined&&plugin.credentialExpiresAt<Date.now()+60_000){
          if(!options.refresh)throw Error('PLUGIN_REFRESH_REQUIRED');
          await options.refresh(connectionId,currentSignal);currentSignal.throwIfAborted();plugin=selected(connectionId);
          if(plugin.credentialExpiresAt!==undefined&&plugin.credentialExpiresAt<Date.now()+60_000)throw Error('PLUGIN_REFRESH_FAILED');
        }
      });
      const snapshot=JSON.stringify(plugin);
      const catalog=await discover();
      total.signal.throwIfAborted();
      if(!args){save({status:'succeeded',outcome:'confirmed'});return text(catalog);}
      const tool=catalog.find(t=>t.name===toolName);
      if(!tool)throw Error('PLUGIN_TOOL_NOT_ALLOWED');
      if(JSON.stringify(selected(plugin.id))!==snapshot)throw Error('PLUGIN_CONFIGURATION_CHANGED');
      const read=plugin.provider==='conductor'&&conductorReads.has(toolName)&&tool.annotations?.readOnlyHint===true&&tool.annotations?.destructiveHint!==true;
      const readOnly=tool.annotations?.readOnlyHint===true&&tool.annotations?.destructiveHint!==true;
      const history=options.journal?.snapshot(runId).pluginCalls??[...completed.values()];
      // A model-issued new tool ID is not permission to replay an uncertain effect.
      if(!readOnly&&history.some(call=>call.requestId!==record.requestId&&call.outcome==='unknown'&&call.status!=='running'))throw new PluginFailure('PLUGIN_RECONCILIATION_REQUIRED');
      let poll:{count:number;deadline:number}|undefined;
      if(plugin.provider==='conductor'&&conductorReads.has(toolName)){
        const target=args.session_id??args.sessionId??args.workspace_id??args.workspaceId??args.id??args;
        const key=connectionId+createHash('sha256').update(JSON.stringify(target)).digest('hex');
        poll=polls.get(key)??{count:0,deadline:record.deadlineAt};polls.set(key,poll);
        if(poll.count>=3||Date.now()>=poll.deadline)throw new PluginFailure('PLUGIN_POLL_LIMIT');
        record.deadlineAt=Math.min(record.deadlineAt,poll.deadline);
      }
      for(let attempt=1;attempt<=2;attempt++){
        total.signal.throwIfAborted();
        if(JSON.stringify(selected(plugin.id))!==snapshot)throw Error('PLUGIN_CONFIGURATION_CHANGED');
        save({attempt});
        try{
          const bridge=appBridge(plugin);
          const c=bridge?undefined:await connect();
          const result=await stage('call',budget.call,async()=>{
            // Count provider dispatches, including retries, rather than model tool calls.
            if(poll){if(poll.count>=3)throw new PluginFailure('PLUGIN_POLL_LIMIT');poll.count++;}
            // Intent is durable before dispatch. A crash here is conservatively unknown.
            save({outcome:'unknown'});
            if(bridge)return text(await bridge.call(plugin,toolName,args,currentSignal));
            const result=await c!.callTool({name:toolName,arguments:args},undefined,{signal:currentSignal,timeout:budget.call,maxTotalTimeout:budget.call,resetTimeoutOnProgress:false});
            if(result.isError)return {content:[],details:{isError:true}};
            const content=(result.content as any[]).filter(c=>c.type==='text'||c.type==='image');
            // Structured task/session IDs are observed provider results, not synthesized IDs.
            if(result.structuredContent!==undefined)content.push({type:'text',text:JSON.stringify(result.structuredContent)});
            return {content:content.length?content:[{type:'text' as const,text:'{}'}],details:{isError:false}};
          });
          save({status:result.details.isError?'failed':'succeeded',outcome:'confirmed',...(result.details.isError?{code:'PLUGIN_REMOTE_FAILED' as const}:{})});
          if(result.details.isError)return failure(record);
          return result;
        }catch(error){
          const safe=classify(error,total.signal);
          const wait=Math.max(budget.backoff,safe.retryAfterMs);
          if(!read||attempt!==1||!safe.transient||total.signal.aborted||(poll&&poll.count>=3)||Date.now()+wait>=record.deadlineAt)throw safe;
          await stopTransport();
          await abortable(new Promise<void>(resolve=>setTimeout(resolve,wait)),total.signal);
        }
      }
      throw new PluginFailure('PLUGIN_REMOTE_FAILED');
    }catch(error){
      const safe=classify(error,total.signal);
      save({status:safe.code==='PLUGIN_CANCELLED'?'interrupted':'failed',code:safe.code});
      // Local admission errors remain ordinary validation failures, without provider data.
      if(error instanceof Error&&['PLUGIN_TOOL_NOT_ALLOWED','PLUGIN_NOT_SELECTED','PLUGIN_CONFIGURATION_CHANGED','PLUGIN_CATALOG_PAGINATION_FAILED'].includes(error.message))throw error;
      return failure(record);
    }finally{
      total.dispose();
      try{await stopTransport();}finally{active.delete(done);finish();}
    }
  }
  async function report(work:ReturnType<typeof operation>){
    const result=await work;
    if(result.details.isError)options.onFailure?.(JSON.parse(result.content[0]!.text).error.code);
    return result;
  }
  const tools:ToolDefinition[]=[{
    name:'plugin_tools',label:'Connected tools',description:'List connected Apps; pass a connection ID to discover their MCP tools. Discovery has a bounded deadline.',
    parameters:Type.Object({connectionId:Type.Optional(Type.String())}),
    async execute(id,raw,signal){const input=z.object({connectionId:z.string().optional()}).parse(raw);if(!input.connectionId)return text(getPlugins().map(p=>({id:p.id,name:p.name,provider:p.provider})));return report(operation(id,input.connectionId,'plugin_tools',undefined,signal));},
  },{
    name:'plugin_call',label:'Use connected tool',description:'Call a tool discovered with plugin_tools. Calls execute directly within the user’s authority and a 90-second deadline. Never replay an uncertain mutation or claim success without an observed result. For long operations retain the returned task/session ID; poll status at most three times within 90 seconds, then report the observed state and finish this turn. A timeout error needs an honest final response, not more polling.',
    parameters:Type.Object({connectionId:Type.String(),tool:Type.String(),arguments:Type.Record(Type.String(),Type.Unknown())}),
    async execute(id,raw,signal){const input=z.object({connectionId:z.string(),tool:z.string(),arguments:z.record(z.string(),z.unknown())}).parse(JSON.parse(JSON.stringify(raw)));return report(operation(id,input.connectionId,input.tool,input.arguments,signal));},
  }];
  return {tools,async close(){lifetime.abort(new PluginFailure('PLUGIN_CANCELLED'));await boundedClose(()=>Promise.all([...active]).then(()=>{}),budget.cleanup);}};
}
function classify(error:unknown,signal:AbortSignal):PluginFailure{
  if(signal.aborted)return signal.reason instanceof PluginFailure?signal.reason:new PluginFailure('PLUGIN_CANCELLED');
  if(error instanceof PluginFailure)return error;
  if(error&&typeof error==='object'&&'code' in error&&error.code===-32001)return new PluginFailure('PLUGIN_TIMEOUT',true);
  return new PluginFailure('PLUGIN_REMOTE_FAILED');
}
function text(value:unknown):{content:{type:'text';text:string}[];details:{isError?:boolean}} {return {content:[{type:'text',text:JSON.stringify(value)}],details:{}};}
