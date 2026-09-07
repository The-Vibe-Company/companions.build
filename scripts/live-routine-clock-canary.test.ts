import {expect,test} from 'bun:test';
import {clockFixture,nextClockTarget,routineClockState,runRoutineClockCanary} from './live-routine-clock-canary';
function fixture(){
 let time=Date.parse('2026-09-07T12:00:00Z');
 const state=routineClockState.parse({companionId:crypto.randomUUID(),boxId:'bx_fixture',nonce:crypto.randomUUID(),targetAt:nextClockTarget(time)});
 const definition=clockFixture(state),routineId=crypto.randomUUID(),runId=crypto.randomUUID(),target=Date.parse(state.targetAt);
 let routine:any=null,occurred=false,finished=false,saves=0;
 const effects:Array<{path:string;method:string;body:any}>=[];
 const input={state,now:()=>time,async sleep(ms:number){expect(ms).toBe(500);time=Math.max(time+ms,target);},async save(){saves++;},
  async api(path:string,method='GET',body?:any):Promise<any>{
   expect(path.endsWith('/test')).toBe(false);
   if(path==='/me')return {user:{id:'owner-a'}};
   if(path==='/companions/'+state.companionId)return {companion:{id:state.companionId,boxId:state.boxId,provider:'box',retiredAt:null},runs:finished?[{id:runId,lane:'background',source:'routine',status:'succeeded',resultText:definition.reply,finishedAt:new Date(target+2000).toISOString()}]:[]};
   if(method==='GET'&&path.endsWith('/routines'))return {routines:routine?[structuredClone(routine)]:[]};
   if(path.endsWith('/history')){
    if(time>=target&&routine?.enabled)occurred=true;
    if(occurred&&routine&&!routine.enabled)finished=true;
    return {runs:occurred?[{id:runId,scheduledFor:state.targetAt,acceptedAt:new Date(target+200).toISOString(),status:finished?'succeeded':'queued',resultText:finished?definition.reply:null}]:[],missed:[]};
   }
   effects.push({path,method,body});expect(saves).toBeGreaterThan(0);
   if(method==='POST'&&path.endsWith('/routines')){expect(state.createRequestedAt).toBeDefined();routine={...body,id:routineId,companionId:state.companionId};return {routine};}
   if(method==='PATCH'){expect(state.disableRequestedAt).toBeDefined();expect(body).toEqual({enabled:false});routine.enabled=false;return {routine};}
   if(method==='DELETE'){expect(state.deleteRequestedAt).toBeDefined();routine=null;return {ok:true};}throw Error('UNEXPECTED_FIXTURE_CALL');
  }
 };
 return {input,state,definition,effects,routineId,runId,get time(){return time;},setTime(value:number){time=value;},setRoutine(value:any){routine=value;},existing(){return {id:routineId,companionId:state.companionId,name:definition.name,prompt:definition.prompt,cron:definition.cron,timezone:'UTC',enabled:true};}};
}
test('target is at least 120s away and pins UTC minute/hour/day/month, not every minute',()=>{
 const target=nextClockTarget(Date.parse('2026-12-31T23:59:45Z'));
 expect(target).toBe('2027-01-01T00:02:00.000Z');expect(clockFixture({nonce:crypto.randomUUID(),targetAt:target}).cron).toBe('2 0 1 1 *');
});
test('one real clock occurrence is observed, immediately disabled, verified and deleted without /test',async()=>{
 const f=fixture();await runRoutineClockCanary(f.input);
 expect(f.effects.map(e=>e.method)).toEqual(['POST','PATCH','DELETE']);expect(f.effects[0]!.body).toMatchObject({cron:'2 12 7 9 *',timezone:'UTC',enabled:true});
 expect(f.state).toMatchObject({runId:f.runId,scheduledFor:f.state.targetAt,schedulerDelayMs:200});expect(f.state.disabledAt).toBeDefined();expect(f.state.removedAt).toBeDefined();expect(f.state.passedAt).toBeDefined();
});
test('lost create response reconciles the exact definition without resubmission',async()=>{
 const f=fixture(),api=f.input.api;let lose=true;f.input.api=async(path,method,body)=>{const value=await api(path,method,body);if(lose&&method==='POST'){lose=false;throw Error('ROUTINE_CLOCK_API_UNREACHABLE');}return value;};
 await runRoutineClockCanary(f.input);expect(f.effects.filter(e=>e.method==='POST')).toHaveLength(1);expect(f.state.removedAt).toBeDefined();
});
test('a restarted create intent without an observed definition never POSTs again',async()=>{
 const f=fixture();f.state.createRequestedAt='2026-09-07T11:59:59Z';await expect(runRoutineClockCanary(f.input)).rejects.toThrow('CREATION_UNRESOLVED');expect(f.effects).toHaveLength(0);
});
test('restart after a lost create observes the existing annual schedule and same target',async()=>{
 const f=fixture();f.state.createRequestedAt='2026-09-07T11:59:59Z';f.setRoutine(f.existing());await runRoutineClockCanary(f.input);
 expect(f.effects.map(e=>e.method)).toEqual(['PATCH','DELETE']);
});
test('an enabled definition is disabled and deleted even if occurrence observation times out',async()=>{
 const f=fixture(),api=f.input.api;
 f.input.api=async(path,method,body)=>path.endsWith('/history')?{runs:[],missed:[]}:api(path,method,body);
 f.input.sleep=async()=>{f.setTime(Date.parse(f.state.targetAt)+121_000);};
 await expect(runRoutineClockCanary(f.input)).rejects.toThrow('FIRE_TIMEOUT');expect(f.effects.map(e=>e.method)).toEqual(['POST','PATCH','DELETE']);expect(f.state.passedAt).toBeUndefined();
});
test('edits to a fixture prevent disable and delete, including an arbitrary journal routine ID',async()=>{
 const f=fixture();f.state.routineId=f.routineId;f.setRoutine({...f.existing(),prompt:'User changed this'});
 await expect(runRoutineClockCanary(f.input)).rejects.toThrow('ROUTINE_CHANGED');expect(f.effects).toHaveLength(0);
});
test('wrong scheduledFor or duplicate occurrences cannot count as a passing clock proof',async()=>{
 for(const duplicate of [false,true]){
  const f=fixture(),api=f.input.api;f.input.api=async(path,method,body)=>{
   if(path.endsWith('/history'))return {runs:Array.from({length:duplicate?2:1},()=>({id:f.runId,scheduledFor:duplicate?f.state.targetAt:'2026-09-07T11:00:00Z',acceptedAt:f.state.targetAt})),missed:[]};
   return api(path,method,body);
  };
  await expect(runRoutineClockCanary(f.input)).rejects.toThrow('OCCURRENCE_MISMATCH');expect(f.state.passedAt).toBeUndefined();expect(f.effects.map(e=>e.method)).toEqual(['POST','PATCH','DELETE']);
 }
});
test('completed journal revalidation neither creates nor enables a routine',async()=>{
 const f=fixture();await runRoutineClockCanary(f.input);const count=f.effects.length;await runRoutineClockCanary(f.input);expect(f.effects).toHaveLength(count);
});
test('foreign owner is rejected before any routine effect',async()=>{
 const f=fixture();f.state.ownerId='foreign';await expect(runRoutineClockCanary(f.input)).rejects.toThrow('OWNER_CHANGED');expect(f.effects).toHaveLength(0);
});
test('a too-close target fails without creating an annual leftover',async()=>{
 const f=fixture();f.setTime(Date.parse(f.state.targetAt)-80_000);await expect(runRoutineClockCanary(f.input)).rejects.toThrow('TARGET_TOO_SOON');expect(f.effects).toHaveLength(0);
});
test('a lost cleanup response is reconciled as already removed without touching another definition',async()=>{
 const f=fixture(),api=f.input.api;let lose=true;
 f.input.api=async(path,method,body)=>{const value=await api(path,method,body);if(lose&&method==='DELETE'){lose=false;throw Error('ROUTINE_CLOCK_API_UNREACHABLE');}return value;};
 await expect(runRoutineClockCanary(f.input)).rejects.toThrow('API_UNREACHABLE');expect(f.state.passedAt).toBeDefined();expect(f.state.removedAt).toBeUndefined();
 await runRoutineClockCanary(f.input);expect(f.effects.filter(e=>e.method==='DELETE')).toHaveLength(1);expect(f.state.removedAt).toBeDefined();
});
test('a user reenable between the disable check and final cleanup read prevents deletion',async()=>{
 const f=fixture(),api=f.input.api;let cleanupReads=0;
 f.input.api=async(path,method,body)=>{
  if(f.state.passedAt&&path.endsWith('/routines')&&(method??'GET')==='GET'&&++cleanupReads===3)f.setRoutine({...f.existing(),enabled:true});
  return api(path,method,body);
 };
 await expect(runRoutineClockCanary(f.input)).rejects.toThrow('ROUTINE_REENABLED');
 expect(f.effects.filter(e=>e.method==='DELETE')).toHaveLength(0);expect(f.state.deleteRequestedAt).toBeUndefined();expect(f.state.removedAt).toBeUndefined();
});
