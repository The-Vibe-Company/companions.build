import { afterEach, expect, test } from 'bun:test';
import { pluginTools } from './tools';
import type { MachinePlugin } from './catalog';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();});
const schema=(name:string)=>({name,inputSchema:{type:'object' as const,properties:{}}});

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
  expect(result.content).toEqual([{type:'text',text:JSON.stringify([schema('read_email')])}]);
  expect(remote.cursors).toEqual([undefined,'second']);
  await expect(remote.call('delete_email')).rejects.toThrow('PLUGIN_TOOL_NOT_ALLOWED');
  expect(remote.calls).toBe(0);
});

test('follows opaque empty cursors and returns each tool once',async()=>{
  const remote=fixture(cursor=>cursor===undefined
    ? {tools:[schema('one')],nextCursor:''}
    : {tools:[schema('one'),schema('two')]});
  const result=await remote.discover();
  expect(result.content).toEqual([{type:'text',text:JSON.stringify([schema('one'),schema('two')])}]);
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
