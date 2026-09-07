import {closeSync,fsyncSync,mkdirSync,openSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {z} from 'zod';

const uuid=z.string().uuid(),timestamp=z.string().datetime();
export const routineClockState=z.object({
 version:z.literal(1).default(1),companionId:uuid,boxId:z.string().regex(/^bx_[a-zA-Z0-9]+$/),nonce:uuid,
 targetAt:timestamp,ownerId:z.string().min(1).optional(),routineId:uuid.optional(),createRequestedAt:timestamp.optional(),
 runId:uuid.optional(),occurrenceObservedAt:timestamp.optional(),scheduledFor:timestamp.optional(),acceptedAt:timestamp.optional(),
 disableRequestedAt:timestamp.optional(),disabledAt:timestamp.optional(),deleteRequestedAt:timestamp.optional(),removedAt:timestamp.optional(),
 finishedAt:timestamp.optional(),passedAt:timestamp.optional(),schedulerDelayMs:z.number().nonnegative().optional(),
});
type State=z.infer<typeof routineClockState>;
type Api=(path:string,method?:string,body?:unknown)=>Promise<any>;
export function nextClockTarget(now:number){return new Date(Math.ceil((now+120_000)/60_000)*60_000).toISOString();}
export function clockFixture(state:Pick<State,'nonce'|'targetAt'>){
 uuid.parse(state.nonce);const date=new Date(timestamp.parse(state.targetAt));
 if(date.getUTCSeconds()!==0||date.getUTCMilliseconds()!==0)throw Error('ROUTINE_CLOCK_TARGET_INVALID');
 const reply='CLOCK_OK_'+state.nonce;
 return {name:'Clock canary '+state.nonce,prompt:`Reply exactly ${reply}, with no tools and no additional text.`,reply,
  cron:`${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth()+1} *`,timezone:'UTC'};
}
/** Real server clock only: never /test, never an injected scheduler timestamp. */
export async function runRoutineClockCanary(input:{state:State;api:Api;save:()=>Promise<unknown>;now?:()=>number;sleep?:(ms:number)=>Promise<unknown>}){
 const {state,api,save}=input,now=input.now??Date.now,sleep=input.sleep??Bun.sleep,stamp=()=>new Date(now()).toISOString();
 const fixture=clockFixture(state),path='/companions/'+state.companionId;
 const ownerId=z.string().min(1).parse((await api('/me')).user?.id);
 if(state.ownerId&&state.ownerId!==ownerId)throw Error('ROUTINE_CLOCK_OWNER_CHANGED');
 async function detail(){
  const value=await api(path),c=value.companion;
  if(c?.id!==state.companionId||c.boxId!==state.boxId||c.provider!=='box'||c.retiredAt)throw Error('ROUTINE_CLOCK_OWNED_BOX_REQUIRED');
  if(!Array.isArray(value.runs))throw Error('ROUTINE_CLOCK_RESPONSE_INVALID');return value;
 }
 await detail();state.ownerId=ownerId;await save();
 async function ownedRoutine(){
  const value=await api(path+'/routines');if(!Array.isArray(value.routines))throw Error('ROUTINE_CLOCK_RESPONSE_INVALID');
  const matches=value.routines.filter((r:any)=>r.id===state.routineId||r.name===fixture.name);
  if(matches.length>1)throw Error('ROUTINE_CLOCK_AMBIGUOUS_ROUTINE');
  const r=matches[0];
  if(r&&(r.companionId!==state.companionId||r.name!==fixture.name||r.prompt!==fixture.prompt||r.cron!==fixture.cron||r.timezone!=='UTC'||typeof r.enabled!=='boolean'||(state.routineId&&r.id!==state.routineId)))throw Error('ROUTINE_CLOCK_ROUTINE_CHANGED');
  if(r)uuid.parse(r.id);return r;
 }
 async function disable(){
  const r=await ownedRoutine();if(!r)return;
  if(r.enabled){state.disableRequestedAt??=stamp();await save();await api(path+'/routines/'+r.id,'PATCH',{enabled:false});
   const checked=await ownedRoutine();if(checked?.enabled)throw Error('ROUTINE_CLOCK_DISABLE_UNCONFIRMED');}
  state.disabledAt??=stamp();await save();
 }
 async function history(){
  if(!state.routineId)throw Error('ROUTINE_CLOCK_CREATION_UNRESOLVED');
  const value=await api(path+'/routines/'+state.routineId+'/history');
  if(!Array.isArray(value?.runs)||!Array.isArray(value?.missed))throw Error('ROUTINE_CLOCK_RESPONSE_INVALID');
  if(value.runs.length>1||value.missed.length)throw Error('ROUTINE_CLOCK_OCCURRENCE_MISMATCH');
  const r=value.runs[0];
  if(r){
   uuid.parse(r.id);
   if(Date.parse(timestamp.parse(r.scheduledFor))!==Date.parse(state.targetAt)||(state.runId&&state.runId!==r.id))throw Error('ROUTINE_CLOCK_OCCURRENCE_MISMATCH');
   state.runId=r.id;state.scheduledFor=r.scheduledFor;state.acceptedAt=timestamp.parse(r.acceptedAt);
   const delay=Date.parse(state.acceptedAt!)-Date.parse(state.targetAt);if(delay<0)throw Error('ROUTINE_CLOCK_ACCEPTED_EARLY');
   state.schedulerDelayMs=delay;state.occurrenceObservedAt??=stamp();await save();
  }return r;
 }
 async function cleanup(){
  await detail();const r=await ownedRoutine();
  if(r){state.routineId=r.id;await save();await disable();
   // Recheck after PATCH; never delete a definition edited during cleanup.
   const final=await ownedRoutine();if(final?.enabled)throw Error('ROUTINE_CLOCK_ROUTINE_REENABLED');
   if(final){state.deleteRequestedAt??=stamp();await save();await api(path+'/routines/'+r.id,'DELETE');}}
  if(state.routineId){state.removedAt??=stamp();await save();}
 }
 try{
  if(!state.routineId){
   let existing=await ownedRoutine();
   if(!existing){
    if(state.createRequestedAt)throw Error('ROUTINE_CLOCK_CREATION_UNRESOLVED');
    if(Date.parse(state.targetAt)-now()<90_000)throw Error('ROUTINE_CLOCK_TARGET_TOO_SOON');
    const before=await detail();if(before.runs.some((r:any)=>r.lane==='background'&&['queued','preparing','running','needs_input'].includes(r.status)))throw Error('ROUTINE_CLOCK_IDLE_BACKGROUND_REQUIRED');
    state.createRequestedAt=stamp();await save();
    try{
     const created=await api(path+'/routines','POST',{name:fixture.name,prompt:fixture.prompt,cron:fixture.cron,timezone:'UTC',enabled:true});
     state.routineId=uuid.parse(created.routine?.id);await save();
    }catch(error){
     // The API create has no idempotency key. Resolve its exact durable definition; never POST twice.
     existing=await ownedRoutine();if(!existing)throw error;
     state.routineId=existing.id;await save();
    }
    if(!await ownedRoutine())throw Error('ROUTINE_CLOCK_CREATION_UNRESOLVED');
   }else{state.routineId=existing.id;await save();}
  }
  let occurrence=await history();const fireDeadline=Date.parse(state.targetAt)+120_000;
  while(!occurrence){
   const definition=await ownedRoutine();
   if(!definition?.enabled)throw Error('ROUTINE_CLOCK_DISABLED_BEFORE_OCCURRENCE');
   if(now()>fireDeadline)throw Error('ROUTINE_CLOCK_FIRE_TIMEOUT');
   await sleep(500);occurrence=await history();
  }
  await disable(); // No second occurrence can be admitted after this observed checkpoint.
  const finishDeadline=now()+120_000;
  for(;;){
   occurrence=await history();if(!occurrence)throw Error('ROUTINE_CLOCK_OCCURRENCE_MISSING');
   if(['failed','cancelled','interrupted'].includes(occurrence.status))throw Error('ROUTINE_CLOCK_RUN_'+occurrence.status.toUpperCase());
   if(occurrence.status==='succeeded')break;
   if(now()>finishDeadline)throw Error('ROUTINE_CLOCK_COMPLETION_TIMEOUT');await sleep(500);
  }
  if(occurrence.resultText?.trim()!==fixture.reply)throw Error('ROUTINE_CLOCK_RESULT_MISMATCH');
  const value=await detail(),run=value.runs.find((r:any)=>r.id===state.runId);
  if(run?.lane!=='background'||run.source!=='routine'||run.status!=='succeeded'||run.resultText?.trim()!==fixture.reply)throw Error('ROUTINE_CLOCK_RUN_MISMATCH');
  state.finishedAt=timestamp.parse(run.finishedAt);state.passedAt??=stamp();await save();
 }finally{await cleanup();}
}

async function main(){
 const journalEnv=process.env.ROUTINE_CLOCK_CANARY_STATE_FILE;if(!journalEnv)throw Error('ROUTINE_CLOCK_CANARY_STATE_FILE_REQUIRED');
 const journal=resolve(journalEnv),base=resolve(process.env.CANARY_STATE_FILE??'.local/box-canary.json'),session=resolve('.local/session-cookie');
 if(journal===base||journal===session)throw Error('ROUTINE_CLOCK_DISTINCT_JOURNAL_REQUIRED');
 const identity=z.object({companionId:uuid,boxId:z.string().regex(/^bx_[a-zA-Z0-9]+$/)}).parse(await Bun.file(base).json());
 const state=routineClockState.parse(await Bun.file(journal).exists()?await Bun.file(journal).json():{...identity,nonce:crypto.randomUUID(),targetAt:nextClockTarget(Date.now())});
 if(state.companionId!==identity.companionId||state.boxId!==identity.boxId)throw Error('ROUTINE_CLOCK_IDENTITY_CHANGED');
 const cookie=(await Bun.file(session).text()).trim();if(!cookie)throw Error('ROUTINE_CLOCK_SESSION_REQUIRED');
 const apiBase=`http://127.0.0.1:${z.coerce.number().int().min(1).max(65535).parse(process.env.API_PORT??Number(process.env.WEB_PORT??4310)+1)}/api`;
 const api:Api=async(path,method='GET',body)=>{
  let response:Response;try{response=await fetch(apiBase+path,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});}catch{throw Error('ROUTINE_CLOCK_API_UNREACHABLE');}
  if(!response.ok)throw Error('ROUTINE_CLOCK_API_'+response.status);try{return await response.json();}catch{throw Error('ROUTINE_CLOCK_RESPONSE_INVALID');}
 };
 const save=async()=>{
  const directory=dirname(journal);mkdirSync(directory,{recursive:true});const temporary=journal+'.'+crypto.randomUUID()+'.tmp';
  const fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,JSON.stringify(routineClockState.parse(state),null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,journal);const dir=openSync(directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 };
 await runRoutineClockCanary({state,api,save});
 console.log(JSON.stringify({status:'passed',scheduledFor:state.scheduledFor,acceptedAt:state.acceptedAt,schedulerDelayMs:state.schedulerDelayMs,finishedAt:state.finishedAt,oneOccurrence:true,disabled:!!state.disabledAt,removed:!!state.removedAt,manualTestUsed:false}));
}
if(import.meta.main)await main().catch(error=>{console.error(error instanceof Error&&/^ROUTINE_CLOCK_[A-Z0-9_]+$/.test(error.message)?error.message:'ROUTINE_CLOCK_CANARY_FAILED');process.exitCode=1;});
