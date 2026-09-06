import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync,realpathSync,writeFileSync,renameSync,statSync,readFileSync} from 'node:fs';
import {join,resolve,sep,basename} from 'node:path';
import {Type} from '@earendil-works/pi-ai';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import {z} from 'zod';
const MAX=10*1024*1024;
const uuid=z.string().uuid();
export class AgentFiles {
 private db:Database;private cwd:string;private outbox:string;
 constructor(stateDir:string){
  this.cwd=join(stateDir,'workspace');this.outbox=join(stateDir,'outbox');mkdirSync(this.cwd,{recursive:true});mkdirSync(this.outbox,{recursive:true});
  this.db=new Database(join(stateDir,'files.sqlite'));this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS outputs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,position INTEGER NOT NULL,name TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,UNIQUE(run_id,position));`);
 }
 async handleRequest(request:Request):Promise<Response|null>{
  const url=new URL(request.url);const inbox=url.pathname.match(/^\/files\/inbox\/([a-f0-9-]+)\/([0-4])$/);
  if(inbox&&request.method==='PUT'){
   const runId=uuid.parse(inbox[1]);const body=z.object({name:z.string().min(1).max(120),sha256:z.string().regex(/^[a-f0-9]{64}$/),data:z.string().max(Math.ceil(MAX*4/3)+4)}).parse(await request.json());
   const bytes=Buffer.from(body.data,'base64');if(!bytes.length||bytes.length>MAX||digest(bytes)!==body.sha256)return Response.json({error:'FILE_INTEGRITY_FAILED'},{status:400});
   const name=body.name.replace(/[^a-zA-Z0-9._-]/g,'_').replace(/^\.+/,'_');
   const directory=join(this.cwd,'inbox',runId);mkdirSync(directory,{recursive:true});
   // A prior agent must not redirect an upload outside its workspace through a symlink.
   if(!realpathSync(directory).startsWith(realpathSync(this.cwd)+sep))throw Error('FILE_PATH_INVALID');
   const path=join(directory,`${inbox[2]}-${name}`);const temp=join(directory,`.upload-${crypto.randomUUID()}`);writeFileSync(temp,bytes,{flag:'wx',mode:0o600});renameSync(temp,path);
   return Response.json({path:`inbox/${runId}/${inbox[2]}-${name}`});
  }
  if(url.pathname==='/files/outbox'&&request.method==='GET'){
   const runId=uuid.parse(url.searchParams.get('runId'));return Response.json({files:this.db.query('SELECT id,position,name,sha256,size FROM outputs WHERE run_id=? ORDER BY position').all(runId)});
  }
  const output=url.pathname.match(/^\/files\/outbox\/([a-f0-9-]+)$/);
  if(output&&request.method==='GET'){
   const row=this.db.query('SELECT id FROM outputs WHERE id=?').get(uuid.parse(output[1])) as any;
   if(!row)return new Response(null,{status:404});return Response.json({data:readFileSync(join(this.outbox,row.id)).toString('base64')});
  }
  return null;
 }
 tools(runId:string):ToolDefinition[]{return [{name:'send_file',label:'Share file',description:'Attach a file from your workspace to this task. Use after verifying the file. Up to five files, each at most 10 MB; images, PDFs and text documents.',parameters:Type.Object({path:Type.String()}),execute:async(_id,raw)=>{
  const input=z.object({path:z.string()}).parse(raw);const path=realpathSync(resolve(this.cwd,input.path));
  if(!path.startsWith(realpathSync(this.cwd)+sep))throw Error('FILE_OUTSIDE_WORKSPACE');
  const info=statSync(path);if(!info.isFile()||info.size<1||info.size>MAX)throw Error('FILE_SIZE_INVALID');
  const [{count}]=this.db.query('SELECT count(*) AS count FROM outputs WHERE run_id=?').all(runId) as any[];
  if(count>=5)throw Error('FILE_COUNT_EXCEEDED');
  const bytes=readFileSync(path);const id=crypto.randomUUID();writeFileSync(join(this.outbox,id),bytes,{flag:'wx',mode:0o600});
  this.db.query('INSERT INTO outputs(id,run_id,position,name,sha256,size) VALUES(?,?,?,?,?,?)').run(id,runId,count,basename(path),digest(bytes),bytes.length);
  return {content:[{type:'text',text:'File queued for attachment to this task.'}],details:{fileId:id}};
 }}];}
 close(){this.db.close();}
}
function digest(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex');}
