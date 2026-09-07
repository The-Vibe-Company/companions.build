import {afterEach,beforeAll,expect,test} from 'bun:test';
import {db,migrate} from '../src/store';
import {
  AdmissionConflict,
  cancelMachineAdmission,
  completeMachineAdmission,
  configureOfferMachineLimits,
  configureProviderMachineLimits,
  effectiveAccountLimits,
  progressMachineAdmissions,
  progressIdleMachines,
  recordMachineActivity,
  renewMachineLease,
  requestMachineAdmission,
  requestMachineAdmissionInTransaction,
  setPersonalActiveLimit,
} from '../src/admission';

const companions:string[]=[];
const providerDefaults={active:1000,startsPerMinute:1000,startsPerHour:10000,startsPerDay:100000};
beforeAll(async()=>{await migrate();await db`ALTER TABLE companions ADD COLUMN IF NOT EXISTS specialist_draft_id uuid`;await db`ALTER TABLE machine_provider_limits ADD COLUMN IF NOT EXISTS cooldown_until timestamptz`;await db.unsafe(await Bun.file(new URL('../src/admission.sql',import.meta.url)).text());await configureProviderMachineLimits(providerDefaults);});
afterEach(async()=>{
 for(const id of companions.splice(0))await db`UPDATE companions SET retired_at=now(),prepare_requested=false WHERE id=${id}`;
 await configureProviderMachineLimits(providerDefaults);
 await db`UPDATE machine_provider_limits SET cooldown_until=null WHERE singleton=true`;
});

async function fixture(ownerId=crypto.randomUUID(),name='Admission fixture',options:{specialist?:boolean;temporary?:boolean}={}){
 await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${ownerId},${name},${ownerId+'@example.test'},true) ON CONFLICT DO NOTHING`;
 const id=crypto.randomUUID();companions.push(id);
 const draftId=options.specialist?crypto.randomUUID():null;
 if(draftId)await db`INSERT INTO agent_templates(id,owner_id,name) VALUES(${draftId},${ownerId},${name+' template'})`;
 await db`INSERT INTO companions(id,owner_id,name,instructions,provider,create_key,agent_secret,prepare_requested,specialist_draft_id,temporary)
  VALUES(${id},${ownerId},${name},'','box',${crypto.randomUUID()},'secret',false,${draftId},${options.temporary??false})`;
 return {ownerId,id,draftId};
}

test('account defaults are durable and a lower personal active ceiling wins',async()=>{
 const {ownerId}=await fixture();
 expect(await effectiveAccountLimits(ownerId)).toEqual({active:2,startsPerHour:10,queue:20});
 await setPersonalActiveLimit(ownerId,1);
 expect(await effectiveAccountLimits(ownerId)).toEqual({active:1,startsPerHour:10,queue:20});
 await expect(setPersonalActiveLimit(ownerId,3)).rejects.toBeInstanceOf(AdmissionConflict);
});

test('simultaneous specialist requests cannot reserve beyond the account ceiling',async()=>{
 const machines=await Promise.all(Array.from({length:5},(_,index)=>fixture(undefined,'Concurrent '+index,{temporary:true})));
 const ownerId=machines[0].ownerId;
 for(let index=1;index<machines.length;index++){
  await db`UPDATE companions SET owner_id=${ownerId} WHERE id=${machines[index].id}`;
 }
 await configureOfferMachineLimits(ownerId,{active:2,startsPerHour:10,queue:20});
 const decisions=await Promise.all(machines.map(machine=>requestMachineAdmission(ownerId,{requestId:crypto.randomUUID(),companionId:machine.id,kind:'test'})));
 expect(decisions.filter(value=>value.state==='admitted')).toHaveLength(2);
 expect(decisions.filter(value=>value.state==='queued')).toHaveLength(3);
});

test('stable requests are idempotent and changed requests conflict',async()=>{
 const {ownerId,id}=await fixture(undefined,'Idempotent',{specialist:true}),requestId=crypto.randomUUID();
 const first=await requestMachineAdmission(ownerId,{requestId,companionId:id,kind:'configuration'});
 const repeated=await requestMachineAdmission(ownerId,{requestId,companionId:id,kind:'configuration'});
 expect(repeated).toEqual(first);expect(first.state).toBe('admitted');
 await expect(requestMachineAdmission(ownerId,{requestId,companionId:id,kind:'resume'})).rejects.toBeInstanceOf(AdmissionConflict);
 expect(await db`SELECT id FROM machine_admission_requests WHERE id=${requestId}`).toHaveLength(1);
});

test('eligible requests are admitted FIFO while a blocked head does not block the next request',async()=>{
 const first=await fixture(undefined,'First',{specialist:true}),second=await fixture(first.ownerId,'Second',{temporary:true}),third=await fixture(first.ownerId,'Third',{temporary:true});
 await effectiveAccountLimits(first.ownerId);
 await db`UPDATE machine_account_limits SET offer_active_limit=1 WHERE owner_id=${first.ownerId}`;
 const active=await requestMachineAdmission(first.ownerId,{requestId:crypto.randomUUID(),companionId:first.id,kind:'configuration'});
 const blockedId=crypto.randomUUID(),eligibleId=crypto.randomUUID();
 await requestMachineAdmission(first.ownerId,{requestId:blockedId,companionId:second.id,kind:'intervention'});
 await requestMachineAdmission(first.ownerId,{requestId:eligibleId,companionId:third.id,kind:'intervention'});
 await db`UPDATE machine_admission_requests SET released_at=now(),state='completed' WHERE id=${active.id}`;
 await progressMachineAdmissions(db,{eligible:async request=>request.id===blockedId?{eligible:false,reason:'connection_required'}:{eligible:true}});
 expect((await db`SELECT state,waiting_reason FROM machine_admission_requests WHERE id=${blockedId}`)[0]).toMatchObject({state:'queued',waiting_reason:'connection_required'});
 expect((await db`SELECT state FROM machine_admission_requests WHERE id=${eligibleId}`)[0].state).toBe('admitted');
});

test('hourly starts and queue length are enforced without silently accepting overflow',async()=>{
 const first=await fixture(undefined,'First',{specialist:true}),second=await fixture(first.ownerId,'Second',{temporary:true}),third=await fixture(first.ownerId,'Third',{temporary:true});
 await effectiveAccountLimits(first.ownerId);
 await db`UPDATE machine_account_limits SET offer_active_limit=2,starts_per_hour_limit=1,queue_limit=1 WHERE owner_id=${first.ownerId}`;
 const admitted=await requestMachineAdmission(first.ownerId,{requestId:crypto.randomUUID(),companionId:first.id,kind:'configuration'});
 await db`UPDATE machine_admission_requests SET state='completed',released_at=now() WHERE id=${admitted.id}`;
 const queued=await requestMachineAdmission(first.ownerId,{requestId:crypto.randomUUID(),companionId:second.id,kind:'test'});
 expect(queued).toMatchObject({state:'queued',waitingReason:'hourly_start_limit'});
 const refused=await requestMachineAdmission(first.ownerId,{requestId:crypto.randomUUID(),companionId:third.id,kind:'test'});
 expect(refused).toMatchObject({state:'refused',waitingReason:'queue_full'});
});

test('cancelling queued work is final and cannot replay during later progression',async()=>{
 const first=await fixture(undefined,'First',{specialist:true}),second=await fixture(first.ownerId,'Second',{temporary:true});
 await effectiveAccountLimits(first.ownerId);
 await db`UPDATE machine_account_limits SET offer_active_limit=1 WHERE owner_id=${first.ownerId}`;
 await requestMachineAdmission(first.ownerId,{requestId:crypto.randomUUID(),companionId:first.id,kind:'configuration'});
 const requestId=crypto.randomUUID();await requestMachineAdmission(first.ownerId,{requestId,companionId:second.id,kind:'test'});
 expect((await cancelMachineAdmission(first.ownerId,requestId)).state).toBe('cancelled');
 await db`UPDATE machine_admission_requests SET state='completed',released_at=now() WHERE companion_id=${first.id}`;
 await progressMachineAdmissions(db);
 expect((await db`SELECT state FROM machine_admission_requests WHERE id=${requestId}`)[0].state).toBe('cancelled');
 expect((await db`SELECT prepare_requested FROM companions WHERE id=${second.id}`)[0].prepare_requested).toBe(false);
});

test('cancelling admission cancels undispatched work and fails its active specialist operation',async()=>{
 const source=await fixture(undefined,'Cancelled source',{specialist:true}),image=await fixture(source.ownerId,'Cancelled image',{temporary:true}),tested=await fixture(source.ownerId,'Cancelled test',{temporary:true});
 await db`INSERT INTO specialist_drafts(template_id,companion_id,base_revision,name) VALUES(${source.draftId},${source.id},1,'Cancelled source')`;
 const runId=crypto.randomUUID(),operationId=crypto.randomUUID();
 await db`INSERT INTO runs(id,companion_id,client_message_id,content,status) VALUES(${runId},${tested.id},${crypto.randomUUID()},'Representative test','preparing')`;
 await db`INSERT INTO specialist_operations(id,template_id,owner_id,generation,kind,fingerprint,prompt,snapshot_name,source_snapshot_name,status,image_companion_id,test_companion_id,run_id)
  VALUES(${operationId},${source.draftId},${source.ownerId},1,'test','fingerprint','Representative test',${'image-'+operationId},${'source-'+operationId},'running',${image.id},${tested.id},${runId})`;
 await requestMachineAdmission(source.ownerId,{requestId:operationId,companionId:tested.id,kind:'test'});
 expect((await cancelMachineAdmission(source.ownerId,operationId)).state).toBe('cancelled');
 expect((await db`SELECT status,cancel_requested,finished_at FROM runs WHERE id=${runId}`)[0]).toMatchObject({status:'cancelled',cancel_requested:true,finished_at:expect.any(Date)});
 expect((await db`SELECT status,error,finished_at FROM specialist_operations WHERE id=${operationId}`)[0]).toMatchObject({status:'failed',error:'Machine admission was cancelled.',finished_at:expect.any(Date)});
 expect((await db`SELECT status,error FROM specialist_drafts WHERE template_id=${source.draftId}`)[0]).toEqual({status:'error',error:'Machine admission was cancelled.'});
 for(const id of [image.id,tested.id])expect((await db`SELECT archive_requested_at,prepare_requested FROM companions WHERE id=${id}`)[0]).toMatchObject({archive_requested_at:expect.any(Date),prepare_requested:false});
});

test('cancelling dispatched work defers archival until executor cancellation settles',async()=>{
 const tested=await fixture(undefined,'Dispatched test',{temporary:true}),requestId=crypto.randomUUID(),runId=crypto.randomUUID();
 await db`UPDATE companions SET status='ready',box_id='running-box',endpoint_secret='running-endpoint' WHERE id=${tested.id}`;
 await db`INSERT INTO runs(id,companion_id,client_message_id,content,status,dispatched) VALUES(${runId},${tested.id},${crypto.randomUUID()},'Running test','running',true)`;
 await requestMachineAdmission(tested.ownerId,{requestId,companionId:tested.id,kind:'test'});
 expect(await cancelMachineAdmission(tested.ownerId,requestId)).toMatchObject({state:'cancelling',waitingReason:'run_cancel_pending'});
 expect((await db`SELECT cancel_requested FROM runs WHERE id=${runId}`)[0].cancel_requested).toBe(true);
 expect((await db`SELECT archive_requested_at FROM companions WHERE id=${tested.id}`)[0].archive_requested_at).toBeNull();
 await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE id=${runId}`;
 await progressIdleMachines(db,{archive:async()=>{throw Error('temporary archival belongs to lifecycle');}},{now:new Date()});
 expect((await db`SELECT archive_requested_at FROM companions WHERE id=${tested.id}`)[0].archive_requested_at).toBeInstanceOf(Date);
});

test('transactional admission allows a companion and its reservation to commit together',async()=>{
 const ownerId=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${ownerId},'Atomic',${'atomic-'+ownerId+'@example.test'},true)`;
 const id=crypto.randomUUID(),requestId=crypto.randomUUID();companions.push(id);
 await db.begin(async tx=>{
  await tx`INSERT INTO companions(id,owner_id,name,instructions,provider,create_key,agent_secret,prepare_requested) VALUES(${id},${ownerId},'Atomic','','box',${crypto.randomUUID()},'secret',false)`;
  await requestMachineAdmissionInTransaction(tx,ownerId,{requestId,companionId:id,kind:'intervention'});
 });
 expect((await db`SELECT state FROM machine_admission_requests WHERE id=${requestId}`)[0].state).toBe('admitted');
 expect((await db`SELECT prepare_requested FROM companions WHERE id=${id}`)[0].prepare_requested).toBe(true);
});

test('capture reserves a slot without starting the ordinary daemon lifecycle',async()=>{
 const {ownerId,id}=await fixture(undefined,'Capture',{temporary:true}),requestId=crypto.randomUUID();
 const admitted=await requestMachineAdmission(ownerId,{requestId,companionId:id,kind:'capture'});
 expect(admitted.state).toBe('admitted');
 expect((await db`SELECT prepare_requested FROM companions WHERE id=${id}`)[0].prepare_requested).toBe(false);
 expect((await completeMachineAdmission(ownerId,requestId)).state).toBe('completed');
});

test('activity and explicit leases update the idle deadline durably',async()=>{
 const {ownerId,id}=await fixture();
 const at=new Date('2026-09-07T10:00:00.000Z');
 await recordMachineActivity(ownerId,id,at);
 await renewMachineLease(ownerId,id,new Date('2026-09-07T10:05:00.000Z'));
 expect((await db`SELECT machine_activity_at,keep_alive_until FROM companions WHERE id=${id}`)[0]).toMatchObject({machine_activity_at:at,keep_alive_until:new Date('2026-09-07T10:35:00.000Z')});
});

test('silent active Pi work prevents idle archival and confirmation releases capacity',async()=>{
 const {ownerId,id}=await fixture(undefined,'Idle draft',{specialist:true}),requestId=crypto.randomUUID();
 await requestMachineAdmission(ownerId,{requestId,companionId:id,kind:'configuration'});
 await db`UPDATE companions SET status='ready',prepare_requested=false,ready_at='2026-09-07 09:00:00+00',machine_activity_at='2026-09-07 09:00:00+00',box_id='box-id' WHERE id=${id}`;
 const runId=crypto.randomUUID();
 await db`INSERT INTO runs(id,companion_id,client_message_id,content,status,dispatched,started_at) VALUES(${runId},${id},${crypto.randomUUID()},'Long quiet work','running',true,'2026-09-07 09:00:00+00')`;
 const calls:string[]=[];let confirmed=false;
 const provider={archive:async(companion:any)=>{calls.push(companion.id);return confirmed;}};
 await progressIdleMachines(db,provider,{now:new Date('2026-09-07T10:00:00Z')});expect(calls).toEqual([]);
 await db`UPDATE runs SET status='succeeded',finished_at='2026-09-07 09:20:00+00' WHERE id=${runId}`;
 await progressIdleMachines(db,provider,{now:new Date('2026-09-07T10:00:00Z')});
 expect(calls).toEqual([id]);
 expect((await db`SELECT archived_at FROM companions WHERE id=${id}`)[0].archived_at).toBeNull();
 expect((await db`SELECT state FROM machine_admission_requests WHERE id=${requestId}`)[0].state).toBe('admitted');
 confirmed=true;await progressIdleMachines(db,provider,{now:new Date('2026-09-07T10:01:00Z')});
 expect((await db`SELECT status,archived_at FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'archived',archived_at:new Date('2026-09-07T10:01:00Z')});
 expect((await db`SELECT state,released_at FROM machine_admission_requests WHERE id=${requestId}`)[0]).toMatchObject({state:'completed',released_at:new Date('2026-09-07T10:01:00Z')});
});

test('a keep-alive lease resets the full thirty minute idle window',async()=>{
 const {ownerId,id}=await fixture(undefined,'Leased draft',{specialist:true});await requestMachineAdmission(ownerId,{requestId:crypto.randomUUID(),companionId:id,kind:'configuration'});
 await db`UPDATE companions SET status='ready',prepare_requested=false,ready_at='2026-09-07 09:00:00+00',machine_activity_at='2026-09-07 09:00:00+00',box_id='lease-box' WHERE id=${id}`;
 await renewMachineLease(ownerId,id,new Date('2026-09-07T09:50:00Z'));
 const calls:string[]=[],provider={archive:async()=>{calls.push('archive');return true;}};
 await progressIdleMachines(db,provider,{now:new Date('2026-09-07T10:19:59Z')});expect(calls).toEqual([]);
 await progressIdleMachines(db,provider,{now:new Date('2026-09-07T10:20:00Z')});expect(calls).toEqual(['archive']);
});

test('active specialist operations protect their source and artifacts from idle archival',async()=>{
 const source=await fixture(undefined,'Protected source',{specialist:true}),image=await fixture(source.ownerId,'Protected image',{temporary:true});
 await db`INSERT INTO specialist_drafts(template_id,companion_id,base_revision,name) VALUES(${source.draftId},${source.id},1,'Protected source')`;
 const operationId=crypto.randomUUID();
 await db`INSERT INTO specialist_operations(id,template_id,owner_id,generation,kind,fingerprint,snapshot_name,source_snapshot_name,status,image_companion_id)
  VALUES(${operationId},${source.draftId},${source.ownerId},1,'publish','fingerprint',${'image-'+operationId},${'source-'+operationId},'preparing',${image.id})`;
 await db`UPDATE companions SET status='ready',prepare_requested=false,ready_at='2026-09-07 09:00:00+00',machine_activity_at='2026-09-07 09:00:00+00',box_id='retained-box' WHERE id IN (${source.id},${image.id})`;
 const calls:string[]=[];
 await progressIdleMachines(db,{archive:async companion=>{calls.push(companion.id);return true;}},{now:new Date('2026-09-07T10:00:00Z')});
 expect(calls).toEqual([]);
});

test('an explicit source handoff archives despite its active specialist operation',async()=>{
 const source=await fixture(undefined,'Handoff source',{specialist:true});
 await db`INSERT INTO specialist_drafts(template_id,companion_id,base_revision,name) VALUES(${source.draftId},${source.id},1,'Handoff source')`;
 const operationId=crypto.randomUUID();
 await db`INSERT INTO specialist_operations(id,template_id,owner_id,generation,kind,fingerprint,snapshot_name,source_snapshot_name,status)
  VALUES(${operationId},${source.draftId},${source.ownerId},1,'test','fingerprint',${'image-'+operationId},${'source-'+operationId},'capturing')`;
 await db`UPDATE companions SET status='ready',prepare_requested=false,box_id='source-box',archive_requested_at='2026-09-07 10:00:00+00' WHERE id=${source.id}`;
 const calls:string[]=[];
 await progressIdleMachines(db,{archive:async companion=>{calls.push(companion.id);return true;}},{now:new Date('2026-09-07T10:01:00Z')});
 expect(calls).toEqual([source.id]);
 expect((await db`SELECT status,archived_at FROM companions WHERE id=${source.id}`)[0]).toMatchObject({status:'archived',archived_at:new Date('2026-09-07T10:01:00Z')});
});

test('account pressure archives a completed unleased specialist before the ordinary idle deadline',async()=>{
 const idle=await fixture(undefined,'Idle slot',{specialist:true}),waiting=await fixture(idle.ownerId,'Waiting work',{temporary:true});
 await configureOfferMachineLimits(idle.ownerId,{active:1,startsPerHour:10,queue:20});
 const active=await requestMachineAdmission(idle.ownerId,{requestId:crypto.randomUUID(),companionId:idle.id,kind:'configuration'});
 await db`UPDATE companions SET status='ready',prepare_requested=false,ready_at='2026-09-07 09:59:00+00',machine_activity_at='2026-09-07 09:59:00+00',box_id='idle-slot' WHERE id=${idle.id}`;
 expect(await requestMachineAdmission(idle.ownerId,{requestId:crypto.randomUUID(),companionId:waiting.id,kind:'test'})).toMatchObject({state:'queued',waitingReason:'active_limit'});
 const calls:string[]=[];
 await progressIdleMachines(db,{archive:async companion=>{calls.push(companion.id);return true;}},{now:new Date('2026-09-07T10:00:00Z')});
 expect(calls).toEqual([idle.id]);
 expect((await db`SELECT state FROM machine_admission_requests WHERE id=${active.id}`)[0].state).toBe('completed');
});

test('idle archival waits for input files and interrupts the run only after provider confirmation',async()=>{
 const draft=await fixture(undefined,'Waiting draft',{specialist:true}),runId=crypto.randomUUID();
 await db`UPDATE companions SET status='ready',prepare_requested=false,ready_at='2026-09-07 09:00:00+00',machine_activity_at='2026-09-07 09:00:00+00',box_id='waiting-box' WHERE id=${draft.id}`;
 await db`INSERT INTO runs(id,companion_id,client_message_id,content,status,dispatched,created_at,started_at) VALUES(${runId},${draft.id},${crypto.randomUUID()},'Question','needs_input',true,'2026-09-07 09:00:00+00','2026-09-07 09:00:00+00')`;
 const calls:string[]=[];
 await progressIdleMachines(db,{archive:async()=>{calls.push('archive');return true;}},{now:new Date('2026-09-07T10:00:00Z'),filesDurable:async()=>false});
 expect(calls).toEqual([]);
 await progressIdleMachines(db,{archive:async()=>{calls.push('archive');return true;}},{now:new Date('2026-09-07T10:00:00Z'),filesDurable:async()=>true});
 expect((await db`SELECT status,finished_at FROM runs WHERE id=${runId}`)[0]).toMatchObject({status:'interrupted',finished_at:expect.any(Date)});
 expect(calls).toEqual(['archive']);
});

test('a preparing specialist without an observed machine still needs account capacity',async()=>{
 const {ownerId,id}=await fixture(undefined,'Uncreated preparing draft',{specialist:true});
 await configureOfferMachineLimits(ownerId,{active:0,startsPerHour:10,queue:20});
 await db`UPDATE companions SET status='preparing',preparation_started_at=now() WHERE id=${id}`;
 expect(await requestMachineAdmission(ownerId,{requestId:crypto.randomUUID(),companionId:id,kind:'configuration'})).toMatchObject({state:'queued',waitingReason:'active_limit'});
});

test('an admitted resume occupies capacity even while the prior archived timestamp remains',async()=>{
 const resumed=await fixture(undefined,'Resume draft',{specialist:true}),next=await fixture(resumed.ownerId,'Next intervention',{temporary:true});
 await configureOfferMachineLimits(resumed.ownerId,{active:1,startsPerHour:10,queue:20});
 await db`UPDATE companions SET status='archived',archived_at=now(),box_id='retained-disk' WHERE id=${resumed.id}`;
 expect((await requestMachineAdmission(resumed.ownerId,{requestId:crypto.randomUUID(),companionId:resumed.id,kind:'resume'})).state).toBe('admitted');
 expect(await requestMachineAdmission(resumed.ownerId,{requestId:crypto.randomUUID(),companionId:next.id,kind:'intervention'})).toMatchObject({state:'queued',waitingReason:'active_limit'});
});

test('a new request cannot jump an older account request when capacity becomes free',async()=>{
 const active=await fixture(undefined,'Active',{specialist:true}),older=await fixture(active.ownerId,'Older',{temporary:true}),newer=await fixture(active.ownerId,'Newer',{temporary:true});
 await configureOfferMachineLimits(active.ownerId,{active:1,startsPerHour:10,queue:20});
 const activeRequest=await requestMachineAdmission(active.ownerId,{requestId:crypto.randomUUID(),companionId:active.id,kind:'configuration'});
 const olderRequest=await requestMachineAdmission(active.ownerId,{requestId:crypto.randomUUID(),companionId:older.id,kind:'test'});
 await completeMachineAdmission(active.ownerId,activeRequest.id);
 const newerRequest=await requestMachineAdmission(active.ownerId,{requestId:crypto.randomUUID(),companionId:newer.id,kind:'test'});
 expect(olderRequest.state).toBe('queued');expect(newerRequest).toMatchObject({state:'queued',waitingReason:'fifo'});
 await progressMachineAdmissions(db);
 expect((await db`SELECT state FROM machine_admission_requests WHERE id=${olderRequest.id}`)[0].state).toBe('admitted');
 expect((await db`SELECT state FROM machine_admission_requests WHERE id=${newerRequest.id}`)[0].state).toBe('queued');
});

test('normal Companions neither consume specialist account slots nor enter specialist idle archival',async()=>{
 const coordinator=await fixture(undefined,'Coordinator'),specialist=await fixture(coordinator.ownerId,'Specialist',{specialist:true});
 await configureOfferMachineLimits(coordinator.ownerId,{active:1,startsPerHour:1,queue:1});
 await db`UPDATE companions SET status='ready',box_id='coordinator-box',ready_at='2026-09-07 09:00:00+00',machine_activity_at='2026-09-07 09:00:00+00' WHERE id=${coordinator.id}`;
 expect((await requestMachineAdmission(coordinator.ownerId,{requestId:crypto.randomUUID(),companionId:specialist.id,kind:'configuration'})).state).toBe('admitted');
 const calls:string[]=[];await progressIdleMachines(db,{archive:async()=>{calls.push('archive');return true;}},{now:new Date('2026-09-07T10:00:00Z')});
 expect(calls).toEqual([]);expect((await db`SELECT archive_requested_at FROM companions WHERE id=${coordinator.id}`)[0].archive_requested_at).toBeNull();
});

test('a queued normal Companion does not consume the specialist queue allowance',async()=>{
 const coordinator=await fixture(undefined,'Queued coordinator'),specialist=await fixture(coordinator.ownerId,'Queued specialist',{specialist:true});
 await configureOfferMachineLimits(coordinator.ownerId,{active:2,startsPerHour:10,queue:1});
 await configureProviderMachineLimits({active:0,startsPerMinute:1000,startsPerHour:10000,startsPerDay:100000});
 expect((await requestMachineAdmission(coordinator.ownerId,{requestId:crypto.randomUUID(),companionId:coordinator.id,kind:'resume'})).state).toBe('queued');
 expect(await requestMachineAdmission(coordinator.ownerId,{requestId:crypto.randomUUID(),companionId:specialist.id,kind:'configuration'})).toMatchObject({state:'queued',waitingReason:'provider_active_limit'});
});

test('provider rolling start reservations apply across accounts',async()=>{
 const first=await fixture(undefined,'Provider first',{specialist:true}),second=await fixture(undefined,'Provider second',{specialist:true});
 await configureProviderMachineLimits({active:100,startsPerMinute:1000,startsPerHour:10000,startsPerDay:100000});
 const started=await requestMachineAdmission(first.ownerId,{requestId:crypto.randomUUID(),companionId:first.id,kind:'configuration'});await completeMachineAdmission(first.ownerId,started.id);
 await configureProviderMachineLimits({active:100,startsPerMinute:1,startsPerHour:10000,startsPerDay:100000});
 expect(await requestMachineAdmission(second.ownerId,{requestId:crypto.randomUUID(),companionId:second.id,kind:'configuration'})).toMatchObject({state:'queued',waitingReason:'provider_start_minute_limit'});
 await configureProviderMachineLimits(providerDefaults);
});

test('provider cooldown blocks admission before active-machine exemptions',async()=>{
 const specialist=await fixture(undefined,'Cooldown resume',{specialist:true});
 await db`UPDATE companions SET status='ready',box_id='existing-box',endpoint_secret='existing-endpoint' WHERE id=${specialist.id}`;
 await db`UPDATE machine_provider_limits SET cooldown_until='2099-01-01 00:00:00+00' WHERE singleton=true`;
 expect(await requestMachineAdmission(specialist.ownerId,{requestId:crypto.randomUUID(),companionId:specialist.id,kind:'resume'})).toMatchObject({state:'queued',waitingReason:'provider_cooldown'});
});

test('the global active safeguard includes normal Companions',async()=>{
 const coordinator=await fixture(undefined,'Global coordinator'),specialist=await fixture(undefined,'Global specialist',{specialist:true});
 await db`UPDATE companions SET status='ready',box_id='global-coordinateur-box' WHERE id=${coordinator.id}`;
 await configureProviderMachineLimits({active:1,startsPerMinute:1000,startsPerHour:10000,startsPerDay:100000});
 expect(await requestMachineAdmission(specialist.ownerId,{requestId:crypto.randomUUID(),companionId:specialist.id,kind:'configuration'})).toMatchObject({state:'queued',waitingReason:'provider_active_limit'});
 await configureProviderMachineLimits(providerDefaults);
});
