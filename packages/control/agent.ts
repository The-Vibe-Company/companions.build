import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { pluginTools } from '../plugins/tools';
import type { MachinePlugin } from '../plugins/catalog';

const operations=['identity','companion_create','models','configure','companions','routines','routine_save','routine_delete','routine_history','routine_test','plugins','plugin_select','plugin_catalog','plugin_connect','plugin_custom','plugin_disconnect','triggers','trigger_save','trigger_delete','trigger_test','trigger_history','delegate','task_status','task_cancel','deliveries','delivery_prepare','templates','template_permission','prepare','template_save','spawn','adopt_template','ask_user','desktop_takeover','desktop_release'] as const;
export type ControlOperation=typeof operations[number];
/** Durable local MCP outbox. The executor visits Box; Box need not reach a local web server. */
export class AgentControl {
  private readonly db:Database;
  private plugins:MachinePlugin[]=[];
  private generation='';
  constructor(stateDir:string) {
    mkdirSync(stateDir,{recursive:true});
    this.db=new Database(join(stateDir,'control.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,operation TEXT NOT NULL,input TEXT NOT NULL,result TEXT,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);
      UPDATE requests SET status='interrupted',result='{"error":"Agent restarted; this request was not replayed."}' WHERE status='pending';`);
  }
  async handleRequest(request:Request):Promise<Response|null> {
    const url=new URL(request.url);
    if(url.pathname==='/configuration'&&request.method==='PUT') {
      const body=await request.json() as any;
      if(!Array.isArray(body.plugins)||body.plugins.length>30||typeof body.generation!=='string') return Response.json({error:'INVALID_CONFIGURATION'},{status:400});
      this.plugins=body.plugins;this.generation=body.generation;return Response.json({generation:this.generation});
    }
    if(url.pathname==='/control'&&request.method==='GET') return Response.json({generation:this.generation,requests:this.db.query(`SELECT id,run_id AS runId,operation,input FROM requests WHERE status='pending' ORDER BY created_at LIMIT 20`).all().map((r:any)=>({...r,input:JSON.parse(r.input)}))});
    const match=url.pathname.match(/^\/control\/([a-f0-9-]+)\/result$/);
    if(match&&request.method==='POST') {
      const result=await request.json();
      if(JSON.stringify(result).length>100_000) return Response.json({error:'RESULT_TOO_LARGE'},{status:400});
      this.db.query(`UPDATE requests SET result=?,status='resolved' WHERE id=? AND status='pending'`).run(JSON.stringify(result),match[1]);
      return Response.json({ok:true});
    }
    return null;
  }
  async call(runId:string,operation:ControlOperation,input:unknown,signal?:AbortSignal) {
    const id=crypto.randomUUID();
    this.db.query('INSERT INTO requests(id,run_id,operation,input,created_at) VALUES(?,?,?,?,?)').run(id,runId,operation,JSON.stringify(input),Date.now());
    const deadline=Date.now()+(operation==='ask_user'?2*3600_000:120_000);
    while(Date.now()<deadline&&!signal?.aborted) {
      const row=this.db.query('SELECT status,result FROM requests WHERE id=?').get(id) as any;
      if(row.status!=='pending') return JSON.parse(row.result);
      await Bun.sleep(150);
    }
    this.db.query(`UPDATE requests SET status='interrupted',result='{"error":"Control request timed out; inspect its state before retrying."}' WHERE id=? AND status='pending'`).run(id);
    throw new Error(signal?.aborted?'CONTROL_CANCELLED':'CONTROL_TIMEOUT');
  }
  async toolsFactory({runId}:{runId:string}) {
    const server=new McpServer({name:'companion-control',version:'0.2.0'});
    server.registerTool('companion_control',{description:'Configure companions.build and delegate work. Read identity first for available operations and their inputs.',inputSchema:{operation:z.enum(operations),input:z.record(z.string(),z.unknown()).default({})}},async({operation,input},extra)=>({content:[{type:'text',text:JSON.stringify(await this.call(runId,operation,input,extra.signal))}]}));
    const client=new Client({name:'companion-agent',version:'0.2.0'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
    const plugins=pluginTools(()=>this.plugins);
    const tool:ToolDefinition={name:'companion_control',label:'Companion control',description:'Use the companion-control MCP to configure this product: identity, instructions, routines, plugins, triggers, delegation and templates. Call identity with empty input to discover schemas. Never claim a configuration changed before this tool confirms it.',parameters:Type.Object({operation:Type.Union(operations.map(x=>Type.Literal(x))),input:Type.Record(Type.String(),Type.Unknown())}),async execute(_id,params,signal){
      const result=await client.callTool({name:'companion_control',arguments:params as Record<string,unknown>},undefined,{signal,timeout:(params as any).operation==='ask_user'?2*3600_000+5000:125_000});
      return {content:result.content as any,details:{}};
    }};
    return {tools:[tool,...plugins.tools],async close(){await plugins.close();await client.close();await server.close();}};
  }
  close(){this.db.close();}
}
