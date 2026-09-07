import {closeSync,fsyncSync,mkdirSync,openSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {z} from 'zod';

const uuid=z.string().uuid(),boxId=z.string().regex(/^bx_[a-zA-Z0-9]+$/),timestamp=z.string().datetime();
export const routineChatState=z.object({
 version:z.literal(1).default(1),companionId:uuid,boxId,nonce:uuid,backgroundMessageId:uuid,chatMessageId:uuid,
 ownerId:z.string().min(1).optional(),routineId:uuid.optional(),backgroundRunId:uuid.optional(),chatRunId:uuid.optional(),
 createRequestedAt:timestamp.optional(),backgroundRequestedAt:timestamp.optional(),backgroundStartedAt:timestamp.optional(),chatRequestedAt:timestamp.optional(),
 chatFinishedAt:timestamp.optional(),backgroundFinishedAt:timestamp.optional(),concurrencyObservedAt:timestamp.optional(),
 chatFinishedDuringBackground:z.boolean().optional(),fileVerified:z.boolean().optional(),passedAt:timestamp.optional(),routineRemoved:z.boolean().optional(),
 chatSeconds:z.number().nonnegative().optional(),backgroundSeconds:z.number().nonnegative().optional(),chatLeadSeconds:z.number().nonnegative().optional(),
});
type State=z.infer<typeof routineChatState>;
type Api=(path:string,method?:string,body?:unknown)=>Promise<any>;
export function routineFixture(nonce:string){
 uuid.parse(nonce);
 return {name:'Gateway concurrency '+nonce,start:'routine-start-'+nonce+'.txt',done:'routine-done-'+nonce+'.txt',
 prompt:`Use bash to execute exactly once, in the foreground, this Python code with a timeout of at least 60 seconds: python3 - <<'PY'\nfrom pathlib import Path\nimport time\nPath('routine-start-${nonce}.txt').write_text('${nonce}')\ntime.sleep(30)\nPath('routine-done-${nonce}.txt').write_text('${nonce}')\nPY\nAfter success reply only BACKGROUND_OK. Do not background or repeat the command.`};
}
/** One disabled routine, manually invoked. This does not exercise cron scheduling. */
export async function runRoutineChatCanary(input:{state:State;api:Api;save:()=>Promise<unknown>;readMarker:(filename:string)=>Promise<string|null>;now?:()=>number;sleep?:(ms:number)=>Promise<unknown>}){
 const {state,api,save}=input,now=input.now??Date.now,sleep=input.sleep??Bun.sleep,stamp=()=>new Date(now()).toISOString();
 const path='/companions/'+state.companionId,fixture=routineFixture(state.nonce);
 const me=await api('/me'),ownerId=z.string().min(1).parse(me.user?.id);
 if(state.ownerId&&state.ownerId!==ownerId)throw Error('ROUTINE_CHAT_OWNER_CHANGED');
 state.ownerId=ownerId;
 async function detail(){
  const value=await api(path),c=value.companion;
  if(c?.id!==state.companionId||c.boxId!==state.boxId||c.provider!=='box'||c.retiredAt||c.desktopTaken)throw Error('ROUTINE_CHAT_OWNED_RELEASED_BOX_REQUIRED');
  if(!Array.isArray(value.runs))throw Error('ROUTINE_CHAT_RESPONSE_INVALID');return value;
 }
 await detail();await save(); // API owner authorization precedes every direct Box read below.
 const run=(value:any,id:string|undefined)=>value.runs.find((r:any)=>r.id===id);
 function assertRun(r:any,lane:'main'|'background'){
  if(!r||r.lane!==lane||(lane==='background'&&r.source!=='routine'))throw Error('ROUTINE_CHAT_RUN_MISMATCH');
  if(['failed','cancelled','interrupted'].includes(r.status))throw Error(`ROUTINE_CHAT_${lane.toUpperCase()}_${r.status.toUpperCase()}`);
 }
 async function wait(label:string,test:()=>Promise<boolean>){const end=now()+120_000;while(!await test()){if(now()>end)throw Error(`ROUTINE_CHAT_${label}_TIMEOUT`);await sleep(500);}}
 async function ownedRoutine(){
  const listed=await api(path+'/routines');if(!Array.isArray(listed.routines))throw Error('ROUTINE_CHAT_RESPONSE_INVALID');
  const candidates=listed.routines.filter((r:any)=>r.name===fixture.name||r.id===state.routineId);
  if(candidates.length>1)throw Error('ROUTINE_CHAT_AMBIGUOUS_ROUTINE');
  const r=candidates[0];
  if(r&&(r.name!==fixture.name||r.prompt!==fixture.prompt||r.enabled!==false||r.cron!=='0 0 * * *'||r.timezone!=='UTC'||r.companionId!==state.companionId||(state.routineId&&r.id!==state.routineId)))throw Error('ROUTINE_CHAT_ROUTINE_CHANGED');
  if(r)uuid.parse(r.id);return r;
 }
 async function cleanup(){
  // An unresolved /test response retains its disabled definition so rerun can resolve the same ID.
  if((state.createRequestedAt&&!state.routineId)||(state.backgroundRequestedAt&&!state.backgroundRunId))return;
  await detail();const r=await ownedRoutine();
  if(r){state.routineId=r.id;await save();await api(path+'/routines/'+r.id,'DELETE');}
  if(state.routineId){state.routineRemoved=true;await save();}
 }
 try{
  if(!state.backgroundRunId){
   const existing=await ownedRoutine();
   if(existing){state.routineId=existing.id;await save();}
   else if(state.createRequestedAt||state.routineId)throw Error('ROUTINE_CHAT_CREATION_UNRESOLVED');
   else{
    const before=await detail();
    if(before.runs.some((r:any)=>['queued','preparing','running','needs_input'].includes(r.status)))throw Error('ROUTINE_CHAT_IDLE_COMPANION_REQUIRED');
    state.createRequestedAt=stamp();await save();
    const created=await api(path+'/routines','POST',{name:fixture.name,prompt:fixture.prompt,cron:'0 0 * * *',timezone:'UTC',enabled:false});
    state.routineId=uuid.parse(created.routine?.id);await save();if(!await ownedRoutine())throw Error('ROUTINE_CHAT_CREATION_UNRESOLVED');
   }
   state.backgroundRequestedAt??=stamp();await save();
   state.backgroundRunId=uuid.parse((await api(path+'/routines/'+state.routineId+'/test','POST',{clientMessageId:state.backgroundMessageId})).runId);await save();
  }
  if(!state.chatFinishedDuringBackground){
   await wait('BACKGROUND_TOOL_START',async()=>{
    const value=await detail(),background=run(value,state.backgroundRunId);assertRun(background,'background');
    const marker=await input.readMarker(fixture.start);
    if(marker!==null&&marker!==state.nonce)throw Error('ROUTINE_CHAT_START_FILE_MISMATCH');
    if(marker===state.nonce&&background.status==='running'){state.backgroundStartedAt??=stamp();await save();return true;}
    if(background.status==='succeeded')throw Error('ROUTINE_CHAT_HEADLESS_NOT_RUNNING');return false;
   });
   if(!state.chatRunId){
    state.chatRequestedAt??=stamp();await save();
    state.chatRunId=uuid.parse((await api(path+'/messages','POST',{clientMessageId:state.chatMessageId,content:'Reply exactly CHAT_OK, with no tools and no additional text.'})).runId);await save();
   }
   await wait('CHAT_COMPLETION',async()=>{const value=await detail(),chat=run(value,state.chatRunId);assertRun(chat,'main');return chat.status==='succeeded';});
   const value=await detail(),chat=run(value,state.chatRunId),background=run(value,state.backgroundRunId);assertRun(background,'background');
   if(chat.resultText?.trim()!=='CHAT_OK')throw Error('ROUTINE_CHAT_CHAT_REPLY_MISMATCH');
   // A running run alone is insufficient: the foreground sleeper must not have written its completion marker yet.
   if(background.status!=='running'||await input.readMarker(fixture.done)!==null)throw Error('ROUTINE_CHAT_CHAT_WAITED_FOR_BACKGROUND');
   state.chatFinishedAt=timestamp.parse(chat.finishedAt);state.concurrencyObservedAt=stamp();state.chatFinishedDuringBackground=true;await save();
  }
  await wait('BACKGROUND_COMPLETION',async()=>{const value=await detail(),background=run(value,state.backgroundRunId);assertRun(background,'background');return background.status==='succeeded';});
  const value=await detail(),chat=run(value,state.chatRunId),background=run(value,state.backgroundRunId);
  assertRun(chat,'main');assertRun(background,'background');
  if(chat.status!=='succeeded'||chat.resultText?.trim()!=='CHAT_OK'||background.resultText?.trim()!=='BACKGROUND_OK')throw Error('ROUTINE_CHAT_RESULT_MISMATCH');
  if(await input.readMarker(fixture.done)!==state.nonce)throw Error('ROUTINE_CHAT_BACKGROUND_FILE_MISMATCH');
  state.chatFinishedAt=timestamp.parse(chat.finishedAt);state.backgroundFinishedAt=timestamp.parse(background.finishedAt);
  const lead=(Date.parse(state.backgroundFinishedAt)-Date.parse(state.chatFinishedAt))/1000;
  if(lead<=0)throw Error('ROUTINE_CHAT_CHAT_WAITED_FOR_BACKGROUND');
  state.chatLeadSeconds=lead;
  for(const [key,r] of [['chatSeconds',chat],['backgroundSeconds',background]] as const){
   if(r.preparedAt){const seconds=(Date.parse(r.finishedAt)-Date.parse(r.preparedAt))/1000;if(Number.isFinite(seconds)&&seconds>=0)state[key]=seconds;}
  }
  state.fileVerified=true;state.passedAt??=stamp();await save();
 }finally{await cleanup();}
}

async function main(){
 const journalEnv=process.env.ROUTINE_CHAT_CANARY_STATE_FILE;
 if(!journalEnv)throw Error('ROUTINE_CHAT_CANARY_STATE_FILE_REQUIRED');
 const journal=resolve(journalEnv),base=resolve(process.env.CANARY_STATE_FILE??'.local/box-canary.json'),session=resolve('.local/session-cookie');
 if(journal===base||journal===session)throw Error('ROUTINE_CHAT_DISTINCT_JOURNAL_REQUIRED');
 const identity=z.object({companionId:uuid,boxId}).parse(await Bun.file(base).json());
 const state=routineChatState.parse(await Bun.file(journal).exists()?await Bun.file(journal).json():{...identity,nonce:crypto.randomUUID(),backgroundMessageId:crypto.randomUUID(),chatMessageId:crypto.randomUUID()});
 if(state.companionId!==identity.companionId||state.boxId!==identity.boxId)throw Error('ROUTINE_CHAT_IDENTITY_CHANGED');
 const {config}=await import('../apps/server/src/config');
 if(!config.boxKey||config.testMode)throw Error('ROUTINE_CHAT_REAL_BOX_REQUIRED');
 const cookie=(await Bun.file(session).text()).trim();if(!cookie)throw Error('ROUTINE_CHAT_SESSION_REQUIRED');
 const apiBase=`http://127.0.0.1:${z.coerce.number().int().min(1).max(65535).parse(process.env.API_PORT??Number(process.env.WEB_PORT??4310)+1)}/api`;
 const api:Api=async(path,method='GET',body)=>{
  let response:Response;try{response=await fetch(apiBase+path,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});}catch{throw Error('ROUTINE_CHAT_API_UNREACHABLE');}
  if(!response.ok)throw Error('ROUTINE_CHAT_API_'+response.status);
  try{return await response.json();}catch{throw Error('ROUTINE_CHAT_RESPONSE_INVALID');}
 };
 const save=async()=>{
  const directory=dirname(journal);mkdirSync(directory,{recursive:true});const temporary=journal+'.'+crypto.randomUUID()+'.tmp';
  const fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,JSON.stringify(routineChatState.parse(state),null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,journal);const dir=openSync(directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 };
 const {BoxClient}=await import('../packages/box/client');const box=new BoxClient(config.boxKey);
 await runRoutineChatCanary({state,api,save,readMarker:async filename=>{
  // Filenames and both IDs originate exclusively from the validated journal, never provider payloads.
  if(![routineFixture(state.nonce).start,routineFixture(state.nonce).done].includes(filename))throw Error('ROUTINE_CHAT_FILE_INVALID');
  const file=`/var/lib/companions-agent/${state.companionId}/workspace/${filename}`;
  try{const result=(await box.command(state.boxId,`if sudo -n test -f ${file}; then sudo -n cat ${file}; else printf CANARY_MISSING; fi`,10)).trim();return result==='CANARY_MISSING'?null:result;}catch{throw Error('ROUTINE_CHAT_FILE_READ_FAILED');}
 }});
 console.log(JSON.stringify({status:'passed',chatFinishedDuringBackground:true,backgroundFileVerified:true,routineInvokedThroughTestEndpoint:true,recurrenceEnabled:false,routineRemoved:state.routineRemoved===true,chatSeconds:state.chatSeconds,backgroundSeconds:state.backgroundSeconds,chatLeadSeconds:state.chatLeadSeconds}));
}
if(import.meta.main)await main().catch(error=>{
 const code=error instanceof Error&&/^ROUTINE_CHAT_[A-Z0-9_]+$/.test(error.message)?error.message:'ROUTINE_CHAT_CANARY_FAILED';
 console.error(code);process.exitCode=1;
});
