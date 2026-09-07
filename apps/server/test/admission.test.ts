import {afterEach,beforeAll,expect,test} from 'bun:test';
import {db,migrate} from '../src/store';
import {
  AdmissionConflict,
  cancelMachineAdmission,
  completeMachineAdmission,
  configureOfferMachineLimits,
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
beforeAll(async()=>{await migrate();await db.unsafe(await Bun.file(new URL('../src/admission.sql',import.meta.url)).text());});
afterEach(async()=>{
 for(const id of companions.splice(0))await db`UPDATE companions SET retired_at=now(),prepare_requested=false WHERE id=${id}`;
});

async function fixture(ownerId=crypto.randomUUID(),name='Admission fixture'){
 await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${ownerId},${name},${ownerId+'@example.test'},true) ON CONFLICT DO NOTHING`;
 const id=crypto.randomUUID();companions.push(id);
 await db`INSERT INTO companions(id,owner_id,name,instructions,provider,create_key,agent_secret,prepare_requested)
  VALUES(${id},${ownerId},${name},'','box',${crypto.randomUUID()},'secret',false)`;
 return {ownerId,id};
}

test('account defaults are durable and a lower personal active ceiling wins',async()=>{
 const {ownerId}=await fixture();
 expect(await effectiveAccountLimits(ownerId)).toEqual({active:2,startsPerHour:10,queue:20});
 await setPersonalActiveLimit(ownerId,1);
 expect(await effectiveAccountLimits(ownerId)).toEqual({active:1,startsPerHour:10,queue:20});
 await expect(setPersonalActiveLimit(ownerId,3)).rejects.toBeInstanceOf(AdmissionConflict);
});

test('simultaneous coordinators cannot reserve beyond the account ceiling',async()=>{
 const machines=await Promise.all(Array.from({length:5},(_,index)=>fixture(index?undefined:undefined,'Concurrent '+index)));
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
 const {ownerId,id}=await fixture(),requestId=crypto.randomUUID();
 const first=await requestMachineAdmission(ownerId,{requestId,companionId:id,kind:'configuration'});
 const repeated=await requestMachineAdmission(ownerId,{requestId,companionId:id,kind:'configuration'});
 expect(repeated).toEqual(first);expect(first.state).toBe('admitted');
 await expect(requestMachineAdmission(ownerId,{requestId,companionId:id,kind:'resume'})).rejects.toBeInstanceOf(AdmissionConflict);
 expect(await db`SELECT id FROM machine_admission_requests WHERE id=${requestId}`).toHaveLength(1);
});

test('eligible requests are admitted FIFO while a blocked head does not block the next request',async()=>{
 const first=await fixture(undefined,'First'),second=await fixture(first.ownerId,'Second'),third=await fixture(first.ownerId,'Third');
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
 const first=await fixture(),second=await fixture(first.ownerId),third=await fixture(first.ownerId);
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
 const first=await fixture(),second=await fixture(first.ownerId);
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
 const {ownerId,id}=await fixture(),requestId=crypto.randomUUID();
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
 const {ownerId,id}=await fixture(),requestId=crypto.randomUUID();
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
 const {ownerId,id}=await fixture();await requestMachineAdmission(ownerId,{requestId:crypto.randomUUID(),companionId:id,kind:'configuration'});
 await db`UPDATE companions SET status='ready',prepare_requested=false,ready_at='2026-09-07 09:00:00+00',machine_activity_at='2026-09-07 09:00:00+00',box_id='lease-box' WHERE id=${id}`;
 await renewMachineLease(ownerId,id,new Date('2026-09-07T09:50:00Z'));
 const calls:string[]=[],provider={archive:async()=>{calls.push('archive');return true;}};
 await progressIdleMachines(db,provider,{now:new Date('2026-09-07T10:19:59Z')});expect(calls).toEqual([]);
 await progressIdleMachines(db,provider,{now:new Date('2026-09-07T10:20:00Z')});expect(calls).toEqual(['archive']);
});
