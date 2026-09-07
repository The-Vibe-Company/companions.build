import {expect,test} from 'bun:test';
import {routineChatState,routineFixture,runRoutineChatCanary} from './live-routine-chat-canary';
function fixture(){
 const state=routineChatState.parse({companionId:crypto.randomUUID(),boxId:'bx_fixture',nonce:crypto.randomUUID(),backgroundMessageId:crypto.randomUUID(),chatMessageId:crypto.randomUUID()});
 const backgroundId=crypto.randomUUID(),chatId=crypto.randomUUID(),definition=routineFixture(state.nonce),routineId=crypto.randomUUID();
 let routine:any=null,time=Date.parse('2026-09-07T12:00:00Z'),bg=false,chat=false,done=false,reads=0,authorized=false,saves=0;
 const effects:Array<{path:string;method:string;body:any}>=[],journal:any[]=[];
 const input={state,now:()=>time,async sleep(ms:number){time+=ms;done=true;},async save(){saves++;journal.push(structuredClone(state));},
  async api(path:string,method='GET',body?:any):Promise<any>{
   if(path==='/me')return {user:{id:'owner-a'}};
   if(path==='/companions/'+state.companionId){authorized=true;return {companion:{id:state.companionId,boxId:state.boxId,provider:'box',desktopTaken:false,retiredAt:null},runs:[
    ...(bg?[{id:backgroundId,lane:'background',source:'routine',status:done?'succeeded':'running',resultText:done?'BACKGROUND_OK':null,preparedAt:'2026-09-07T12:00:00Z',finishedAt:done?'2026-09-07T12:00:40Z':null}]:[]),
    ...(chat?[{id:chatId,lane:'main',source:'chat',status:'succeeded',resultText:'CHAT_OK',preparedAt:'2026-09-07T12:00:01Z',finishedAt:'2026-09-07T12:00:05Z'}]:[]),
   ]};}
   if(method==='GET'&&path.endsWith('/routines'))return {routines:routine?[routine]:[]};
   effects.push({path,method,body});expect(saves).toBeGreaterThan(0);
   if(method==='POST'&&path.endsWith('/routines')){expect(state.createRequestedAt).toBeDefined();routine={...body,id:routineId,companionId:state.companionId};return {routine};}
   if(path.endsWith('/test')){expect(state.backgroundRequestedAt).toBeDefined();expect(body.clientMessageId).toBe(state.backgroundMessageId);bg=true;return {runId:backgroundId};}
   if(path.endsWith('/messages')){expect(state.chatRequestedAt).toBeDefined();expect(body.clientMessageId).toBe(state.chatMessageId);chat=true;return {runId:chatId};}
   if(method==='DELETE'){routine=null;return {ok:true};}throw Error('UNEXPECTED_FIXTURE_CALL');
  },async readMarker(name:string){expect(authorized).toBe(true);reads++;return name===definition.start?state.nonce:done?state.nonce:null;}
 };
 return {input,state,definition,routineId,backgroundId,chatId,effects,journal,get reads(){return reads;},setRoutine(r:any){routine=r;},existing(){return {...definition,id:routineId,companionId:state.companionId,enabled:false,cron:'0 0 * * *',timezone:'UTC'};},setDone(){done=true;}};
}
test('manual disabled routine proves headless/chat overlap, exact file and results, then deletes only its routine',async()=>{
 const f=fixture();await runRoutineChatCanary(f.input);
 expect(f.state).toMatchObject({routineRemoved:true,fileVerified:true,chatFinishedDuringBackground:true,chatSeconds:4,backgroundSeconds:40,chatLeadSeconds:35});
 expect(f.effects.map(e=>[e.method,e.path.split('/').pop()])).toEqual([['POST','routines'],['POST','test'],['POST','messages'],['DELETE',f.routineId]]);
 expect(f.effects[0]!.body.enabled).toBe(false);expect(f.journal[0].backgroundMessageId).toBe(f.state.backgroundMessageId);expect(f.journal[0].chatMessageId).toBe(f.state.chatMessageId);
 expect(JSON.stringify(f.state)).not.toContain('prompt');
});
test('lost create response resumes by exact disabled definition without a second POST create',async()=>{
 const f=fixture();f.state.createRequestedAt='2026-09-07T11:59:00Z';f.setRoutine(f.existing());await runRoutineChatCanary(f.input);
 expect(f.effects.filter(e=>e.method==='POST'&&e.path.endsWith('/routines'))).toHaveLength(0);expect(f.state.routineRemoved).toBe(true);
});
test('unresolved creation is never blindly repeated',async()=>{
 const f=fixture();f.state.createRequestedAt='2026-09-07T11:59:00Z';await expect(runRoutineChatCanary(f.input)).rejects.toThrow('CREATION_UNRESOLVED');expect(f.effects).toHaveLength(0);expect(f.reads).toBe(0);
});
test('create transport loss preserves the disabled definition for exact reconciliation on rerun',async()=>{
 const f=fixture(),api=f.input.api;let lose=true;
 f.input.api=async(path,method,body)=>{const value=await api(path,method,body);if(lose&&method==='POST'&&path.endsWith('/routines')){lose=false;throw Error('ROUTINE_CHAT_API_UNREACHABLE');}return value;};
 await expect(runRoutineChatCanary(f.input)).rejects.toThrow('API_UNREACHABLE');expect(f.effects.filter(e=>e.method==='DELETE')).toHaveLength(0);
 await runRoutineChatCanary(f.input);expect(f.effects.filter(e=>e.method==='POST'&&e.path.endsWith('/routines'))).toHaveLength(1);
});
test('lost /test response resolves the same client ID instead of creating a new task',async()=>{
 const f=fixture(),api=f.input.api;let lose=true;
 f.input.api=async(path,method,body)=>{const value=await api(path,method,body);if(lose&&path.endsWith('/test')){lose=false;throw Error('ROUTINE_CHAT_API_UNREACHABLE');}return value;};
 await expect(runRoutineChatCanary(f.input)).rejects.toThrow('API_UNREACHABLE');expect(f.effects.filter(e=>e.method==='DELETE')).toHaveLength(0);
 await runRoutineChatCanary(f.input);const tests=f.effects.filter(e=>e.path.endsWith('/test'));expect(tests).toHaveLength(2);expect(tests[0]!.body).toEqual(tests[1]!.body);
});
test('foreign owner fails before Box access or routine mutation',async()=>{
 const f=fixture();f.state.ownerId='owner-b';await expect(runRoutineChatCanary(f.input)).rejects.toThrow('OWNER_CHANGED');expect(f.effects).toHaveLength(0);expect(f.reads).toBe(0);
});
test('an enabled or changed definition is neither invoked nor deleted',async()=>{
 const f=fixture();f.setRoutine({...f.existing(),enabled:true});await expect(runRoutineChatCanary(f.input)).rejects.toThrow('ROUTINE_CHANGED');expect(f.effects).toHaveLength(0);
});
test('a completed tool hidden behind a stale running projection does not count as overlap',async()=>{
 const f=fixture(),read=f.input.readMarker;f.input.readMarker=async name=>name===f.definition.done?f.state.nonce:read(name);
 await expect(runRoutineChatCanary(f.input)).rejects.toThrow('CHAT_WAITED_FOR_BACKGROUND');expect(f.state.passedAt).toBeUndefined();expect(f.state.routineRemoved).toBe(true);
});
test('a passed journal can be checked again without creating another routine or run',async()=>{
 const f=fixture();await runRoutineChatCanary(f.input);const before=f.effects.length;await runRoutineChatCanary(f.input);expect(f.effects).toHaveLength(before);
});
test('an API-authorized Companion with a different Box identity still denies every direct read',async()=>{
 const f=fixture(),api=f.input.api;f.input.api=async(path,method,body)=>{const value=await api(path,method,body);if(value.companion)value.companion.boxId='bx_other';return value;};
 await expect(runRoutineChatCanary(f.input)).rejects.toThrow('OWNED_RELEASED_BOX_REQUIRED');expect(f.effects).toHaveLength(0);expect(f.reads).toBe(0);
});
test('identity fields reject shell syntax before constructing any provider command',()=>{
 const f=fixture();expect(routineChatState.safeParse({...f.state,boxId:'bx_fixture; id'}).success).toBe(false);
 expect(routineChatState.safeParse({...f.state,nonce:'../../other'}).success).toBe(false);
 expect(routineChatState.safeParse({...f.state,companionId:'other; id'}).success).toBe(false);
});
