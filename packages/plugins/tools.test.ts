import { afterEach, expect, test } from 'bun:test';
import { pluginTools } from './tools';
import type { MachinePlugin } from './catalog';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();});
const schema=(name:string)=>({name,annotations:{readOnlyHint:true},inputSchema:{type:'object' as const,properties:{}}});

function fixture(list:(cursor:string|undefined)=>unknown,allowedTools?:string[]) {
  const cursors:Array<string|undefined>=[];
  let calls=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    if(request.method!=='POST') return new Response(null,{status:405});
    const message=await request.json() as {id?:number;method:string;params?:{cursor?:string}};
    if(message.id===undefined) return new Response(null,{status:202});
    let result:unknown;
    if(message.method==='initialize') result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else if(message.method==='tools/list') {cursors.push(message.params?.cursor);result=list(message.params?.cursor);}
    else if(message.method==='tools/call') {
      calls++;
      // An ambiguous remote failure must not cause plugin_call to retry.
      return new Response(null,{status:503});
    } else return new Response(null,{status:400});
    return Response.json({jsonrpc:'2.0',id:message.id,result});
  }});
  cleanup.push(async()=>{await server.stop(true);});
  const plugin:MachinePlugin={id:'account',name:'Gmail',provider:'gmail',transport:'http',url:`http://127.0.0.1:${server.port}/mcp`,allowedTools};
  const connection=pluginTools(()=>[plugin]);
  cleanup.push(()=>connection.close());
  return {cursors,get calls(){return calls;},
    discover:(signal?:AbortSignal)=>connection.tools[0]!.execute('discover',{connectionId:'account'},signal,undefined,{} as never),
    call:(tool:string)=>connection.tools[1]!.execute('call',{connectionId:'account',tool,arguments:{}},undefined,undefined,{} as never)};
}

test('discovers later pages even when a Gmail allowlist removes the entire first page',async()=>{
  const remote=fixture(cursor=>cursor===undefined
    ? {tools:[schema('send_email')],nextCursor:'second'}
    : {tools:[schema('read_email'),schema('delete_email')]},['read_email']);
  const result=await remote.discover();
  expect(JSON.parse((result.content[0] as any).text)).toEqual([schema('read_email')]);
  expect(remote.cursors).toEqual([undefined,'second']);
  await expect(remote.call('delete_email')).rejects.toThrow('PLUGIN_TOOL_NOT_ALLOWED');
  expect(remote.calls).toBe(0);
});

test('follows opaque empty cursors and returns each tool once',async()=>{
  const remote=fixture(cursor=>cursor===undefined
    ? {tools:[schema('one')],nextCursor:''}
    : {tools:[schema('one'),schema('two')]});
  const result=await remote.discover();
  expect(JSON.parse((result.content[0] as any).text)).toEqual([schema('one'),schema('two')]);
  expect(remote.cursors).toEqual([undefined,'']);
});

test('rejects repeated cursors instead of hanging or returning an incomplete catalog',async()=>{
  const remote=fixture(()=>({tools:[schema('one')],nextCursor:'repeat'}));
  await expect(remote.discover()).rejects.toThrow('PLUGIN_CATALOG_PAGINATION_FAILED');
  expect(remote.cursors).toEqual([undefined,'repeat']);
});

test('bounds providers that produce endlessly unique cursors',async()=>{
  let page=0;
  const remote=fixture(()=>({tools:[],nextCursor:String(++page)}));
  await expect(remote.discover()).rejects.toThrow('PLUGIN_CATALOG_PAGINATION_FAILED');
  expect(remote.cursors).toHaveLength(100);
});

test('never retries an ambiguous tool call failure',async()=>{
  const remote=fixture(()=>({tools:[schema('read_email')]}));
  await remote.discover();
  await expect(remote.call('read_email')).rejects.toThrow();
  expect(remote.calls).toBe(1);
});

function railwayFixture() {
  const calls:Array<unknown>=[];let requests=0;
  const tools=[schema('whoami'),schema('list-projects'),schema('list-services'),{...schema('redeploy'),annotations:{destructiveHint:true,readOnlyHint:true,title:'Redeploy service'}},{...schema('railway-agent'),annotations:{destructiveHint:true,openWorldHint:true}},schema('create-project'),schema('accept-deploy'),schema('list-feature-flags')];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    requests++;if(request.method!=='POST')return new Response(null,{status:405});
    const message=await request.json() as any;if(message.id===undefined)return new Response(null,{status:202});
    let result:unknown;
    if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'Railway fixture',version:'1'}};
    else if(message.method==='tools/list')result=message.params?.cursor?{tools:tools.slice(3)}:{tools:tools.slice(0,3),nextCursor:'next'};
    else if(message.method==='tools/call'){calls.push(message.params);result={content:[{type:'text',text:'done'}]};}
    else return new Response(null,{status:400});
    return Response.json({jsonrpc:'2.0',id:message.id,result});
  }});
  cleanup.push(async()=>{await server.stop(true);});
  const plugin:MachinePlugin={id:'railway-account',name:'Production workspace',provider:'railway',transport:'http',url:`http://127.0.0.1:${server.port}/mcp`};
  return {plugin,tools,calls,get requests(){return requests;}};
}
const execute=(connection:ReturnType<typeof pluginTools>,index:number,input:unknown)=>connection.tools[index]!.execute('request',input,undefined,undefined,{} as never);

test('Railway lists every paginated tool including railway-agent and connects only on use',async()=>{
  const fixture=railwayFixture(),connection=pluginTools(()=>[fixture.plugin]);cleanup.push(()=>connection.close());
  const accounts=await execute(connection,0,{});expect(JSON.stringify(accounts)).toContain('Production workspace');expect(fixture.requests).toBe(0);
  const result=await execute(connection,0,{connectionId:fixture.plugin.id});
  expect(JSON.parse((result.content[0] as any).text)).toEqual(fixture.tools);
  await execute(connection,1,{connectionId:fixture.plugin.id,tool:'whoami',arguments:{}});expect(fixture.calls).toHaveLength(1);
});

test('destructive Railway calls wait for human confirmation and send the original exact arguments',async()=>{
  const fixture=railwayFixture();let approve!:(answer:boolean)=>void;let requested!:(value:unknown)=>void;
  const requestedPromise=new Promise(resolve=>requested=resolve);
  const connection=pluginTools(()=>[fixture.plugin],{confirm:async request=>{requested(request);return new Promise(resolve=>approve=resolve);}});cleanup.push(()=>connection.close());
  const args={projectId:'project-1',options:{force:true}};
  const pending=execute(connection,1,{connectionId:fixture.plugin.id,tool:'railway-agent',arguments:args});
  expect(await requestedPromise).toEqual({connectionId:fixture.plugin.id,tool:'railway-agent',annotations:fixture.tools[4]!.annotations,arguments:args});
  expect(fixture.calls).toHaveLength(0);args.options.force=false;approve(true);await pending;
  expect(fixture.calls).toEqual([{name:'railway-agent',arguments:{projectId:'project-1',options:{force:true}}}]);
});

test('explicit destructive annotations override contradictory read-only hints and fail closed without approval, on denial, or after detachment',async()=>{
  const fixture=railwayFixture();
  const input={connectionId:fixture.plugin.id,tool:'redeploy',arguments:{serviceId:'service-1'}};
  const missing=pluginTools(()=>[fixture.plugin]);cleanup.push(()=>missing.close());
  await expect(execute(missing,1,input)).rejects.toThrow('PLUGIN_CONFIRMATION_REQUIRED');
  const denied=pluginTools(()=>[fixture.plugin],{confirm:async()=>false});cleanup.push(()=>denied.close());
  await expect(execute(denied,1,input)).rejects.toThrow('PLUGIN_CONFIRMATION_DENIED');
  let selected=[fixture.plugin];
  const detached=pluginTools(()=>selected,{confirm:async()=>{selected=[];return true;}});cleanup.push(()=>detached.close());
  await expect(execute(detached,1,input)).rejects.toThrow('PLUGIN_NOT_SELECTED');expect(fixture.calls).toHaveLength(0);
});

test('expired App credentials refresh only when the selected account is used',async()=>{
  const fixture=railwayFixture();let plugin={...fixture.plugin,credentialExpiresAt:Date.now()-1};const refreshed:string[]=[];
  const connection=pluginTools(()=>[plugin],{refresh:async id=>{refreshed.push(id);plugin={...plugin,credentialExpiresAt:Date.now()+3600_000};}});cleanup.push(()=>connection.close());
  await execute(connection,0,{});expect(refreshed).toEqual([]);expect(fixture.requests).toBe(0);
  await execute(connection,1,{connectionId:plugin.id,tool:'whoami',arguments:{}});expect(refreshed).toEqual([plugin.id]);expect(fixture.calls).toHaveLength(1);
});

test('Slack bridge pins its endpoint and forwards only its supported message fields',async()=>{
 const originalFetch=globalThis.fetch;const requests:Array<{url:string;body:unknown}>=[];
 globalThis.fetch=(async(input:any,init:any)=>{requests.push({url:String(input),body:JSON.parse(init.body)});return Response.json({ok:true,channel:'C1',ts:'1'});}) as typeof fetch;
 const plugin:MachinePlugin={id:'slack-account',provider:'slack',name:'Slack work',transport:'slack',url:'https://untrusted.example/mcp',headers:{Authorization:'Bearer fixture'}};
 const connection=pluginTools(()=>[plugin]);
 try {
  await expect(execute(connection,1,{connectionId:plugin.id,tool:'delete_message',arguments:{channel:'C1',text:'Hello'}})).rejects.toThrow('PLUGIN_TOOL_NOT_ALLOWED');
  await execute(connection,1,{connectionId:plugin.id,tool:'chat_post_message',arguments:{channel:'C1',text:'Hello',unfurl_links:true,url:'https://untrusted.example'}});
  expect(requests).toEqual([{url:'https://slack.com/api/chat.postMessage',body:{channel:'C1',text:'Hello'}}]);
 }finally{globalThis.fetch=originalFetch;await connection.close();}
});
