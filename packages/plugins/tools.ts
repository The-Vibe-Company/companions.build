import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MachinePlugin } from './catalog';

/** Discover on demand: connecting every remote must never delay an ordinary chat. */
export function pluginTools(getPlugins:()=>MachinePlugin[]) {
  const clients=new Map<string,Promise<Client>>();
  async function client(plugin:MachinePlugin) {
    let pending=clients.get(JSON.stringify(plugin));
    if(!pending) {
      pending=(async()=>{
        const c=new Client({name:'companions.build',version:'0.2.0'});
        const transport=plugin.transport==='stdio'
          ? new StdioClientTransport({command:plugin.command!,args:plugin.args??[],env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME??'/home/user',...plugin.env},stderr:'ignore'})
          : new StreamableHTTPClientTransport(new URL(plugin.url!),{requestInit:{headers:plugin.headers}});
        try {await c.connect(transport,{timeout:15_000});return c;}catch{await c.close();throw new Error('PLUGIN_CONNECTION_FAILED');}
      })(); clients.set(JSON.stringify(plugin),pending);
      pending.catch(()=>clients.delete(JSON.stringify(plugin)));
    }
    return pending;
  }
  const tools:ToolDefinition[]=[{
    name:'plugin_tools',label:'Connected tools',description:'List connected plugins; pass a connection ID to discover its MCP tool names and input schemas. Connections are independent accounts.',
    parameters:Type.Object({connectionId:Type.Optional(Type.String())}),
    async execute(_id,raw,signal) {
      const input=z.object({connectionId:z.string().optional()}).parse(raw);
      if(!input.connectionId) return text(getPlugins().map(p=>({id:p.id,name:p.name,provider:p.provider})));
      const plugin=getPlugins().find(p=>p.id===input.connectionId);if(!plugin) throw new Error('PLUGIN_NOT_SELECTED');
      if(plugin.transport==='slack') return text([{name:'chat_post_message',description:'Send an explicitly authorized Slack message',inputSchema:{type:'object',properties:{channel:{type:'string'},text:{type:'string'}},required:['channel','text']}}]);
      const c=await client(plugin);
      const discovered=new Map<string,Awaited<ReturnType<Client['listTools']>>['tools'][number]>();
      const cursors=new Set<string>();
      let cursor:string|undefined;
      // Discover every page, but fail closed if a provider loops or never finishes.
      for(let page=0;page<100;page++) {
        const catalog=await c.listTools(cursor===undefined?undefined:{cursor},{signal,timeout:15_000});
        for(const tool of catalog.tools) {
          if(!plugin.allowedTools||plugin.allowedTools.includes(tool.name)) discovered.set(tool.name,tool);
        }
        if(catalog.nextCursor===undefined) return text([...discovered.values()]);
        if(cursors.has(catalog.nextCursor)) throw new Error('PLUGIN_CATALOG_PAGINATION_FAILED');
        cursors.add(catalog.nextCursor);cursor=catalog.nextCursor;
      }
      throw new Error('PLUGIN_CATALOG_PAGINATION_FAILED');
    },
  },{
    name:'plugin_call',label:'Use connected tool',description:'Call a tool discovered with plugin_tools. Respect the user’s authority before sending messages or publishing changes.',
    parameters:Type.Object({connectionId:Type.String(),tool:Type.String(),arguments:Type.Record(Type.String(),Type.Unknown())}),
    async execute(_id,raw,signal) {
      const input=z.object({connectionId:z.string(),tool:z.string(),arguments:z.record(z.string(),z.unknown())}).parse(raw);
      const plugin=getPlugins().find(p=>p.id===input.connectionId);if(!plugin) throw new Error('PLUGIN_NOT_SELECTED');
      if(plugin.allowedTools&&!plugin.allowedTools.includes(input.tool)) throw new Error('PLUGIN_TOOL_NOT_ALLOWED');
      if(plugin.transport==='slack') {
        if(input.tool!=='chat_post_message'||typeof input.arguments.channel!=='string'||typeof input.arguments.text!=='string') throw new Error('PLUGIN_TOOL_NOT_ALLOWED');
        const r=await fetch('https://slack.com/api/chat.postMessage',{method:'POST',headers:{...plugin.headers,'content-type':'application/json'},body:JSON.stringify({channel:input.arguments.channel,text:input.arguments.text}),signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(30_000)])});
        const result=await r.json() as any;if(!r.ok||!result.ok) throw new Error('SLACK_MESSAGE_FAILED');
        return text({channel:result.channel,ts:result.ts});
      }
      const result=await (await client(plugin)).callTool({name:input.tool,arguments:input.arguments},undefined,{signal,timeout:60_000});
      // MCP text/image results remain tool output, never controller logs.
      const content=(result.content as any[]).filter(c=>c.type==='text'||c.type==='image');
      return {content:content.length?content:[{type:'text' as const,text:JSON.stringify(result.structuredContent??{})}],details:{isError:!!result.isError}};
    },
  }];
  return {tools,async close(){await Promise.all([...clients.values()].map(async p=>{await(await p.catch(()=>null))?.close();}));}};
}
function text(value:unknown) {return {content:[{type:'text' as const,text:JSON.stringify(value)}],details:{}};}
