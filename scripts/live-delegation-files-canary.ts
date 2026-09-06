/** Optional live proof: a parent reads retained S3 bytes after its child Box is archived. */
import {chmodSync, mkdirSync, renameSync, writeFileSync} from 'node:fs';
import {z} from 'zod';
import {config} from '../apps/server/src/config';
import {db} from '../apps/server/src/store';
import {BoxClient} from '../packages/box/client';

if(!config.boxKey||!config.boxTemplate||config.testMode)throw Error('Configure the real Box/model stack first.');
const box=new BoxClient(config.boxKey);
const cookie=(await Bun.file('.local/session-cookie').text()).trim();
const base=`http://127.0.0.1:${process.env.API_PORT??Number(process.env.WEB_PORT??4310)+1}/api`;
const journalPath='.local/live-delegation-files-canary.json';
const journal=Bun.file(journalPath);
const stateSchema=z.object({
 version:z.literal(1),nonce:z.string().uuid(),commandId:z.string().uuid(),ownerId:z.string().min(1).max(255).optional(),
 parentRequested:z.boolean().optional(),parentId:z.string().uuid().optional(),templateRequested:z.boolean().optional(),templateId:z.string().uuid().optional(),
 childId:z.string().uuid().optional(),childRunId:z.string().uuid().optional(),reviewRunId:z.string().uuid().optional(),childBoxId:z.string().min(1).max(255).optional(),
 releaseNeeded:z.boolean().optional(),passedAt:z.string().datetime().optional(),
}).strict();
const state=await journal.exists()
 ?stateSchema.parse(await journal.json())
 :stateSchema.parse({version:1,nonce:crypto.randomUUID(),commandId:crypto.randomUUID()});
function save(){mkdirSync('.local',{recursive:true,mode:0o700});writeFileSync(`${journalPath}.tmp`,JSON.stringify(state,null,2),{mode:0o600});renameSync(`${journalPath}.tmp`,journalPath);chmodSync(journalPath,0o600);}
save();
async function api(path:string,body?:unknown){
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});
 if(!response.ok)throw Error(`DELEGATION_CANARY_API_${response.status}`);return response.json() as Promise<any>;
}
async function until<T>(label:string,read:()=>Promise<T|null>,timeout=240_000):Promise<T>{
 const deadline=Date.now()+timeout;for(;;){const value=await read();if(value!==null)return value;if(Date.now()>deadline)throw Error(`${label}_TIMEOUT`);await Bun.sleep(500);}
}
const shortNonce=state.nonce.slice(0,12);
const parentName=`File handoff canary ${shortNonce}`;
const templateName=`File handoff specialist ${shortNonce}`;
async function reconcileId(path:string,collection:string,name:string){
 const rows=(await api(path))[collection];
 const matches=Array.isArray(rows)?rows.filter((item:any)=>item?.name===name):[];
 if(matches.length!==1)throw Error(`DELEGATION_CANARY_RECONCILE_${collection.toUpperCase()}_${matches.length}`);
 return z.string().uuid().parse(matches[0].id);
}
async function releaseParent(parentPath:string){
 const deadline=Date.now()+60_000;let nextRequest=0;
 while(Date.now()<deadline){
  if(Date.now()>=nextRequest){try{await api(`${parentPath}/desktop/release`,{});}catch{}nextRequest=Date.now()+10_000;}
  try{const detail=await api(parentPath);if(!detail.companion.desktopTaken&&!detail.companion.desktopPausedAt){state.releaseNeeded=false;save();return;}}catch{}
  await Bun.sleep(1_000);
 }
 throw Error('PARENT_RELEASE_CLEANUP_TIMEOUT');
}
let releaseNeeded=state.releaseNeeded??false;
let failure:unknown;
try{
 const me=await api('/me'),ownerId=z.string().min(1).max(255).parse(me.user?.id);
 if(state.ownerId&&state.ownerId!==ownerId)throw Error('DELEGATION_CANARY_OWNER_CHANGED');
 state.ownerId=ownerId;save();
 if(!state.parentId){
  if(state.parentRequested)state.parentId=await reconcileId('/companions','companions',parentName);
  else{
   state.parentRequested=true;save();
   const value=await api('/companions',{name:parentName,provider:'box',instructions:'For each delegated task review, read the retained handoff.txt attachment with a file tool. Reply with exactly its contents, nothing else. Never adopt a template. Do not guess its contents.'});
   state.parentId=z.string().uuid().parse(value.companion.id);
  }
  save();
 }
 const parentPath=`/companions/${state.parentId}`;
 await api(parentPath); // Authenticate access before inspecting executor state.
 if(!state.templateId){
  if(state.templateRequested)state.templateId=await reconcileId('/templates','templates',templateName);
  else{
   state.templateRequested=true;save();
   const template=await api('/templates',{name:templateName,instructions:'Perform the requested file task with real tools. Use send_file to retain the result.'});
   state.templateId=z.string().uuid().parse(template.id);
  }
  save();
 }
 await api(`${parentPath}/template-permission`,{templateId:state.templateId,maxChildren:1});
 if(!state.passedAt){
  releaseNeeded=true;state.releaseNeeded=true;save();
  await api(`${parentPath}/desktop/takeover`,{});
  await until('PARENT_PAUSE',async()=>(await api(parentPath)).companion.desktopPausedAt?true:null);
  if(!state.childRunId){
   const child=await api(`${parentPath}/spawn`,{commandId:state.commandId,templateId:state.templateId,prompt:'Use bash to generate a fresh UUID locally and write it to handoff.txt. Do not put the UUID into tool arguments or your final reply. Call send_file with handoff.txt. Finish with exactly FILE_READY.'});
   state.childId=z.string().uuid().parse(child.companionId);state.childRunId=z.string().uuid().parse(child.runId);save();
  }
  if(!state.childId)throw Error('DELEGATION_CANARY_CHILD_ID_MISSING');
  const retained=await until('CHILD_HANDOFF',async()=>{
   const [row]=await db`SELECT d.returned_run_id,c.box_id,r.status FROM delegations d
    JOIN companions parent ON parent.id=d.parent_id AND parent.owner_id=${ownerId} AND parent.parent_id IS NULL AND NOT parent.temporary AND parent.retired_at IS NULL
    JOIN companions c ON c.id=d.target_id AND c.owner_id=parent.owner_id AND c.parent_id=parent.id AND c.temporary AND c.provider='box' AND c.retired_at IS NULL
    JOIN runs r ON r.id=d.run_id AND r.companion_id=c.id
    WHERE d.id=${state.commandId} AND d.parent_id=${state.parentId} AND d.target_id=${state.childId} AND d.run_id=${state.childRunId}`;
   if(row&&['failed','cancelled','interrupted'].includes(row.status))throw Error('CHILD_TASK_FAILED');
   if(!row?.returned_run_id)return null;
   if(!row.box_id)throw Error('DELEGATION_CANARY_CHILD_BOX_MISSING');
   const detail=await api(parentPath),file=detail.files?.find((item:any)=>item.runId===row.returned_run_id&&item.name==='handoff.txt');
   return file?{...row,file}:null;
  });
  state.reviewRunId=z.string().uuid().parse(retained.returned_run_id);state.childBoxId=z.string().min(1).max(255).parse(retained.box_id);save();
  const file=await fetch(new URL(retained.file.url,base),{headers:{cookie},signal:AbortSignal.timeout(15_000)});
  if(!file.ok)throw Error('RETAINED_FILE_UNAVAILABLE');
  const marker=(await file.text()).trim();
  if(!/^[a-f0-9-]{36}$/i.test(marker))throw Error('CHILD_MARKER_INVALID');
  if((await box.get(state.childBoxId)).state!=='archived')await box.stop(state.childBoxId);
  await until('CHILD_ARCHIVE',async()=>(await box.get(state.childBoxId!)).state==='archived'?true:null);
  await releaseParent(parentPath);releaseNeeded=false;
  await until('PARENT_REVIEW',async()=>{
   const detail=await api(parentPath),run=detail.runs.find((item:any)=>item.id===state.reviewRunId);
   if(['failed','cancelled','interrupted'].includes(run?.status))throw Error('PARENT_REVIEW_FAILED');
   if(run?.status!=='succeeded')return null;
   if(run.resultText?.trim()!==marker)throw Error('PARENT_DID_NOT_READ_RETAINED_FILE');return true;
  });
  state.passedAt=new Date().toISOString();save();
 }
 console.log(JSON.stringify({status:'passed',childArchivedBeforeReview:true,parentReadRetainedFile:true}));
}catch(error){failure=error;
}finally{
 try{if(releaseNeeded&&state.parentId)await releaseParent(`/companions/${state.parentId}`);}catch(error){if(!failure)failure=error;}
 finally{await db.close();}
}
if(failure)throw failure;
