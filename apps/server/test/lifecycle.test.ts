import {beforeAll,afterEach,expect,test} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage,detail} from '../src/store';
import {acquireExecutor} from '../src/executor';
import {migrateLifecycle,progressLifecycle,handleLifecycle,type LifecycleMachines} from '../src/lifecycle';
import {saveTemplate,allowTemplate,adoptTemplate,LifecycleConflict} from '../src/templates';
import {spawnChild,delegateTask,delegationStatus} from '../src/delegation';
import {dataDir,encrypt,config} from '../src/config';
import {prepareLocal,pauseMachine,environmentDigest,ExecutionStopped} from '../src/machines';
import {join} from 'node:path';
import {migrateDeliverySkills,type DeliverySkillDependencies} from '../src/delivery-skills';
import {createHash} from 'node:crypto';
import {configureOfferMachineLimits} from '../src/admission';
import {BoxError} from '../../../packages/box/client';
const owner='00000000-0000-4000-8000-000000000001',other='lifecycle-other-owner';
const owned:string[]=[];
beforeAll(async()=>{await migrate();await migrateLifecycle();await migrateDeliverySkills();await configureOfferMachineLimits(owner,{active:100,startsPerHour:1000,queue:100});await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${other},'Other','lifecycle-other@example.test',true) ON CONFLICT DO NOTHING`;});
afterEach(async()=>{for(const id of owned.splice(0)){await db`UPDATE delegations SET finished_at=now() WHERE parent_id=${id}`;await db`UPDATE template_candidates SET status='failed' WHERE source_companion_id IN (SELECT id FROM companions WHERE parent_id=${id}) AND status IN ('queued','capturing','ready')`;await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id} AND status IN ('queued','preparing','running','needs_input')`;await db`UPDATE companions SET retired_at=now(),prepare_requested=false,desktop_taken=false,desktop_paused_at=null WHERE id=${id} OR parent_id=${id}`;}});
async function parent(ownerId=owner,provider:'local'|'box'='box'){const value=await createCompanion(ownerId,{name:'Parent',instructions:'',provider});owned.push(value.id);await db`UPDATE companions SET prepare_requested=false WHERE id=${value.id}`;return value.id as string;}
async function setup(){const id=await parent();const template=await saveTemplate(owner,{name:'Developer',instructions:'Use the supplied brief.',modelId:'specialist-model'});await allowTemplate(owner,id,{templateId:template.id,maxChildren:2});return {id,template};}
async function leader(){const sql=await acquireExecutor();if(!sql)throw Error('Test executor lock unavailable');return {sql,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};}
function fake(desktop=false){
 const calls:string[]=[];let snapshot:'missing'|'pending'|'ready'|'failed'='missing';
 const machine:LifecycleMachines={async prepare(c,checkpoint){calls.push('prepare '+c.id);await checkpoint('box-'+c.id);return 'http://fake.local';},async health(){calls.push('health');return {ready:true,desktopBoundaryVersion:desktop?1:0};},async pause(c,value){calls.push('pause '+value);return {generation:Number(c.desktop_generation),taken:value,confirmed:true,bootId:'fixture-boot'};},async archive(c){calls.push('archive '+c.id);return true;},async snapshot(_c,name){calls.push('snapshot '+name);snapshot='pending';},async snapshotStatus(){calls.push('snapshot GET');return snapshot;}};
 const objects=new Map<string,Blob>();
 const deliverySkills:DeliverySkillDependencies={storage:{async put(key:string,bytes:Uint8Array,type:string){objects.set(key,new Blob([bytes.slice().buffer as ArrayBuffer],{type}));},async get(key:string){const value=objects.get(key);if(!value)throw Error('missing');return value;},async delete(key:string){objects.delete(key);}},async requestAgent(){calls.push('skills export');return {version:1,skills:[]};},async notifyReady(){}};
 return {machine,calls,deliverySkills,setSnapshot(value:typeof snapshot){snapshot=value;}};
}
async function portableBundle(ownerId:string,companionId:string){
 const id=crypto.randomUUID(),bytes=Buffer.from(JSON.stringify({version:1,skills:[]}));
 await db`INSERT INTO portable_skill_bundles(id,source_owner_id,source_companion_id,manifest_version,bundle_hash,object_sha256,byte_size,storage_key)
  VALUES(${id},${ownerId},${companionId},1,${createHash('sha256').update('skills-v1\0').digest('hex')},${createHash('sha256').update(bytes).digest('hex')},${bytes.length},${`test/${id}`})`;
 await db`UPDATE companions SET skill_bundle_id=${id} WHERE id=${companionId}`;return {id,bytes};
}

test('two-owner template, child and delegation authorization fail closed',async()=>{
 const {id,template}=await setup(),foreign=await parent(other);
 await expect(allowTemplate(other,foreign,{templateId:template.id,maxChildren:1})).rejects.toBeInstanceOf(LifecycleConflict);
 await expect(spawnChild(other,id,null,crypto.randomUUID(),{templateId:template.id,prompt:'Secret'})).rejects.toBeInstanceOf(LifecycleConflict);
 const run=await acceptMessage(owner,id,crypto.randomUUID(),'Parent task');
 await expect(delegateTask(owner,id,run!,crypto.randomUUID(),{companionId:foreign,prompt:'Do work'})).rejects.toBeInstanceOf(LifecycleConflict);
 await expect(handleLifecycle({operation:'open_desktop',companionId:id},other)).rejects.toBeInstanceOf(LifecycleConflict);
 expect(await db`SELECT id FROM delegations WHERE parent_id=${id}`).toHaveLength(0);
});

test('concurrent spawns obey the parent limit and children cannot create children',async()=>{
 const {id,template}=await setup();
 const attempts=await Promise.allSettled(Array.from({length:8},()=>spawnChild(owner,id,null,crypto.randomUUID(),{templateId:template.id,prompt:'Implement feature'})));
 const children=attempts.filter(item=>item.status==='fulfilled').map(item=>(item as PromiseFulfilledResult<any>).value);
 expect(children).toHaveLength(2);expect(attempts.filter(item=>item.status==='rejected')).toHaveLength(6);
 const [child]=await db`SELECT * FROM companions WHERE id=${children[0].companionId}`;
 expect(child).toMatchObject({parent_id:id,temporary:true,prepare_requested:true,template_revision:1,model_id:'specialist-model'});
 await expect(spawnChild(owner,child.id,null,crypto.randomUUID(),{templateId:template.id,prompt:'More'})).rejects.toBeInstanceOf(LifecycleConflict);
 await expect(allowTemplate(owner,child.id,{templateId:template.id,maxChildren:2})).rejects.toBeInstanceOf(LifecycleConflict);
 expect((await db`SELECT agent_secret FROM companions WHERE parent_id=${id}`)[0].agent_secret).not.toBe((await db`SELECT agent_secret FROM companions WHERE id=${id}`)[0].agent_secret);
});

test('duplicate spawn returns the same child and pins its template revision',async()=>{
 const {id,template}=await setup(),command=crypto.randomUUID(),input={templateId:template.id,prompt:'Work'};
 const first=await spawnChild(owner,id,null,command,input);expect(await spawnChild(owner,id,null,command,input)).toEqual(first);
 await expect(spawnChild(owner,id,null,command,{...input,prompt:'Changed'})).rejects.toBeInstanceOf(LifecycleConflict);
 await saveTemplate(owner,{id:template.id,expectedRevision:1,name:'Changed',instructions:'New brief'});
 expect((await db`SELECT instructions,model_id,template_revision FROM companions WHERE id=${first.companionId}`)[0]).toMatchObject({instructions:'Use the supplied brief.',model_id:'specialist-model',template_revision:1});
});

test('parent detail projects its task-linked temporary specialist without crossing owners',async()=>{
 const {id,template}=await setup(),parentRun=await acceptMessage(owner,id,crypto.randomUUID(),'Investigate this');
 const command=crypto.randomUUID(),delegated=await spawnChild(owner,id,parentRun!,command,{templateId:template.id,prompt:'Research'});
 await db`UPDATE companions SET status='ready',retired_at=now() WHERE id=${delegated.companionId}`;
 const state=await detail(owner,id);
 expect(state?.specialists).toEqual([{
  delegationId:command,parentRunId:parentRun,childRunId:delegated.runId,
  companion:{id:delegated.companionId,name:'Developer',avatar:{shape:0,color:0,face:0},status:'ready',retiredAt:expect.any(String)},
 }]);
 expect(await detail(other,id)).toBeNull();
});

test('open desktop persists a wake without chat; confirmed takeover survives browser closure and releases',async()=>{
 const id=await parent();const f=fake(true),lock=await leader();
 try{
  await handleLifecycle({operation:'open_desktop',companionId:id},owner);
  expect(f.calls).toHaveLength(0);expect(await db`SELECT id FROM runs WHERE companion_id=${id}`).toHaveLength(0);
  await progressLifecycle(lock.sql,{},f.machine);
  expect((await db`SELECT status,ready_at,prepare_requested FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'ready',prepare_requested:false});
  await handleLifecycle({operation:'desktop_takeover',companionId:id},owner);await progressLifecycle(lock.sql,{},f.machine);
  expect((await db`SELECT desktop_paused_at FROM companions WHERE id=${id}`)[0].desktop_paused_at).not.toBeNull();
  f.calls.length=0;await progressLifecycle(lock.sql,{},f.machine);expect(f.calls).toEqual([]);
  await handleLifecycle({operation:'desktop_release',companionId:id},owner);await progressLifecycle(lock.sql,{},f.machine);expect(f.calls).toEqual(['pause false']);
  expect((await db`SELECT desktop_paused_at FROM companions WHERE id=${id}`)[0].desktop_paused_at).toBeNull();
 }finally{await lock.close();}
});

test('unconfirmed GUI quiescence is never projected as a confirmed takeover',async()=>{
 const id=await parent(),f=fake(),lock=await leader();f.machine.pause=async()=>{throw Error('provider payload with secret');};
 try{await handleLifecycle({operation:'desktop_takeover',companionId:id},owner);await progressLifecycle(lock.sql,{},f.machine);
  const [row]=await db`SELECT desktop_taken,desktop_paused_at,error FROM companions WHERE id=${id}`;
  expect(row.desktop_taken).toBe(true);expect(row.desktop_paused_at).toBeNull();expect(row.error).toBe('Desktop takeover could not be confirmed. Desktop interactions may still be active.');
 }finally{await lock.close();}
});

test('a Box desktop failure does not fail the ready machine',async()=>{
 const id=await parent(),f=fake(true),lock=await leader();
 try{
  await db`UPDATE companions SET status='ready',prepare_requested=false,box_id='ready-box',endpoint_secret=${encrypt('http://ready')},desktop_boundary_version=1 WHERE id=${id}`;
  f.machine.pause=async()=>{throw new BoxError('box_unreachable');};
  await handleLifecycle({operation:'desktop_takeover',companionId:id},owner);await progressLifecycle(lock.sql,{},f.machine);
  expect((await db`SELECT status,prepare_requested,error FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'ready',prepare_requested:false,error:'Desktop takeover could not be confirmed. Desktop interactions may still be active.'});
 }finally{await lock.close();}
});

test('portable skills are imported before a cold Companion becomes ready',async()=>{
 const id=await parent(),bundle=await portableBundle(owner,id),f=fake(),lock=await leader();let statusAtImport='';
 f.deliverySkills.storage!.put=async()=>{};f.deliverySkills.storage!.get=async()=>new Blob([bundle.bytes]);
 f.deliverySkills.requestAgent=async(_endpoint,_token,path,method,body)=>{expect([path,method]).toEqual(['/skills/import','PUT']);statusAtImport=(await db`SELECT status FROM companions WHERE id=${id}`)[0].status;return {bundleHash:createHash('sha256').update('skills-v1\0').digest('hex')};};
 try{
  await db`UPDATE companions SET prepare_requested=true WHERE id=${id}`;
  await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);
  expect(statusAtImport).toBe('preparing');expect((await db`SELECT status,prepare_requested,skills_staged_hash FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'ready',prepare_requested:false,skills_staged_hash:createHash('sha256').update('skills-v1\0').digest('hex')});
 }finally{await lock.close();}
});

test('a failed portable-skill import stays visible and eventually stops retrying',async()=>{
 const id=await parent(),bundle=await portableBundle(owner,id),f=fake(),lock=await leader();let imports=0;
 f.deliverySkills.storage!.get=async()=>new Blob([bundle.bytes]);f.deliverySkills.requestAgent=async()=>{imports++;throw Error('private provider failure');};
 try{
  await db`UPDATE companions SET prepare_requested=true WHERE id=${id}`;await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);
  expect((await db`SELECT error,prepare_requested FROM companions WHERE id=${id}`)[0]).toMatchObject({error:'Machine preparation is temporarily unavailable.',prepare_requested:true});
  await db`UPDATE companions SET preparation_started_at=now()-interval '6 minutes' WHERE id=${id}`;await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);
  expect((await db`SELECT error,prepare_requested FROM companions WHERE id=${id}`)[0]).toMatchObject({error:'Machine preparation timed out. Request preparation to retry.',prepare_requested:false});expect(imports).toBe(1);
 }finally{await lock.close();}
});

test('a preparation deadline fails pending work so the executor cannot rearm it',async()=>{
 const id=await parent(),f=fake(),lock=await leader();
 try{
  await db`UPDATE companions SET prepare_requested=true,preparation_started_at=now()-interval '6 minutes' WHERE id=${id}`;
  const run=await acceptMessage(owner,id,crypto.randomUUID(),'Do not replay');
  await progressLifecycle(lock.sql,{},f.machine);
  expect(f.calls.filter(call=>call.startsWith('prepare '))).toHaveLength(0);
  expect((await db`SELECT status,prepare_requested FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'error',prepare_requested:false});
  expect((await db`SELECT status,error,dispatched FROM runs WHERE id=${run}`)[0]).toMatchObject({status:'failed',error:'Preparation timed out. Send a new message to retry.',dispatched:false});
 }finally{await lock.close();}
});

test('managed base image publication waits without starting the machine timeout',async()=>{
 const id=await parent(),f=fake(),lock=await leader();let ready=false,checks=0;
 f.machine.preparationReady=async()=>{checks++;return ready;};
 try{
  await db`UPDATE companions SET prepare_requested=true WHERE id=${id}`;
  await progressLifecycle(lock.sql,{},f.machine);
  expect(checks).toBe(1);expect(f.calls.filter(call=>call.startsWith('prepare '))).toHaveLength(0);
  expect((await db`SELECT status,error,preparation_started_at,create_started_at FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'preparing',error:'Base image publication is pending.',preparation_started_at:null,create_started_at:null});
  ready=true;await progressLifecycle(lock.sql,{},f.machine);
  expect(f.calls.filter(call=>call.startsWith('prepare '))).toHaveLength(1);
  expect((await db`SELECT status,prepare_requested,error FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'ready',prepare_requested:false,error:null});
 }finally{await lock.close();}
});

for(const failure of [new BoxError('box_not_found',404),new BoxError('box_unreachable')] as const)test(`a ${failure.code} Box create failure stops automatic preparation replay`,async()=>{
 const id=await parent(),f=fake(),lock=await leader();let attempts=0;
 f.machine.prepare=async()=>{attempts++;throw failure;};
 try{
  const run=await acceptMessage(owner,id,crypto.randomUUID(),'Start once');
  await db`UPDATE companions SET prepare_requested=true WHERE id=${id}`;
  await progressLifecycle(lock.sql,{},f.machine);await progressLifecycle(lock.sql,{},f.machine);
  expect(attempts).toBe(1);
  const expected=failure.status===404?'Machine image is unavailable. Request preparation to retry.':'Machine creation could not be confirmed. Request preparation to retry.';
  expect((await db`SELECT status,prepare_requested,error,preparation_started_at,create_started_at FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'error',prepare_requested:false,error:expected,preparation_started_at:null,create_started_at:expect.any(Date)});
  expect((await db`SELECT status,error,dispatched FROM runs WHERE id=${run}`)[0]).toMatchObject({status:'failed',error:expected,dispatched:false});
 }finally{await lock.close();}
});

test('a transient Box failure after create checkpoint retries the same machine within the original deadline',async()=>{
 const id=await parent(),f=fake(),lock=await leader();let attempts=0,creates=0;
 f.machine.prepare=async(companion,checkpoint)=>{
  attempts++;
  if(!companion.box_id){creates++;await checkpoint('box-checkpointed');throw new BoxError('box_unreachable');}
  expect(companion.box_id).toBe('box-checkpointed');return 'http://recovered.local';
 };
 try{
  await db`UPDATE companions SET prepare_requested=true WHERE id=${id}`;
  await progressLifecycle(lock.sql,{},f.machine);
  const [waiting]=await db`SELECT box_id,status,prepare_requested,error,preparation_started_at FROM companions WHERE id=${id}`;
  expect(waiting).toMatchObject({box_id:'box-checkpointed',status:'preparing',prepare_requested:true,error:'Machine preparation is temporarily unavailable.',preparation_started_at:expect.any(Date)});
  await progressLifecycle(lock.sql,{},f.machine);
  expect({attempts,creates}).toEqual({attempts:2,creates:1});
  expect((await db`SELECT status,prepare_requested,box_id,error FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'ready',prepare_requested:false,box_id:'box-checkpointed',error:null});
 }finally{await lock.close();}
});

test('a checkpointed Box retry still stops at the original preparation deadline',async()=>{
 const id=await parent(),f=fake(),lock=await leader();let attempts=0;
 f.machine.prepare=async(companion,checkpoint)=>{attempts++;if(!companion.box_id)await checkpoint('box-bounded');throw new BoxError('box_unreachable');};
 try{
  await db`UPDATE companions SET prepare_requested=true WHERE id=${id}`;
  await progressLifecycle(lock.sql,{},f.machine);expect(attempts).toBe(1);
  await db`UPDATE companions SET preparation_started_at=now()-interval '6 minutes' WHERE id=${id}`;
  await progressLifecycle(lock.sql,{},f.machine);
  expect(attempts).toBe(1);
  expect((await db`SELECT status,prepare_requested,box_id,error FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'error',prepare_requested:false,box_id:'box-bounded',error:'Machine preparation timed out. Request preparation to retry.'});
 }finally{await lock.close();}
});

test('snapshot recovery observes its durable name and activates only after ready',async()=>{
 const {id,template}=await setup(),child=await spawnChild(owner,id,null,crypto.randomUUID(),{templateId:template.id,prompt:'Install software'});
 await db`UPDATE companions SET box_id='snapshot-source',prepare_requested=false WHERE id=${child.companionId}`;
 await db`UPDATE runs SET status='succeeded',finished_at=now(),result_text='Installed' WHERE id=${child.runId}`;
 const command=crypto.randomUUID();await adoptTemplate(owner,id,command,{templateId:template.id,childId:child.companionId,expectedRevision:1});
 const f=fake(),lock=await leader();
 try{
  f.machine.snapshot=async(_c,name)=>{f.calls.push('snapshot '+name);f.setSnapshot('pending');throw Error('Lost response after provider accepted snapshot');};
  await db`UPDATE companions SET desktop_taken=true,desktop_paused_at=now() WHERE id=${child.companionId}`;
  await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);expect(f.calls.some(call=>call.startsWith('snapshot'))).toBe(false);
  await db`UPDATE companions SET desktop_taken=false,desktop_paused_at=null WHERE id=${child.companionId}`;
  await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);
  expect(f.calls.filter(call=>call.startsWith('snapshot companions-'))).toHaveLength(1);
  expect((await db`SELECT snapshot_name FROM agent_templates WHERE id=${template.id}`)[0].snapshot_name).toBeNull();
  expect((await db`SELECT retired_at FROM companions WHERE id=${child.companionId}`)[0].retired_at).toBeNull();
  f.setSnapshot('ready');await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);
  expect((await db`SELECT snapshot_name,revision FROM agent_templates WHERE id=${template.id}`)[0]).toMatchObject({snapshot_name:'companions-'+command,revision:2});
  await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);expect((await db`SELECT revision FROM agent_templates WHERE id=${template.id}`)[0].revision).toBe(2);
 }finally{await lock.close();}
});

test('concurrent promotion publishes once and its revision survives source retirement for a fresh child',async()=>{
 const {id,template}=await setup();
 const sources=await Promise.all([
  spawnChild(owner,id,null,crypto.randomUUID(),{templateId:template.id,prompt:'Prepare variant A'}),
  spawnChild(owner,id,null,crypto.randomUUID(),{templateId:template.id,prompt:'Prepare variant B'}),
 ]);
 await db`UPDATE companions SET prepare_requested=false WHERE id IN (${sources[0].companionId},${sources[1].companionId})`;
 await db`UPDATE runs SET status='succeeded',finished_at=now() WHERE id IN (${sources[0].runId},${sources[1].runId})`;
 const commands=[crypto.randomUUID(),crypto.randomUUID()];
 const attempts=await Promise.allSettled(sources.map((source,index)=>adoptTemplate(owner,id,commands[index],{templateId:template.id,childId:source.companionId,expectedRevision:1})));
 expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 const rejected=attempts.find(result=>result.status==='rejected') as PromiseRejectedResult;
 expect(rejected.reason).toBeInstanceOf(LifecycleConflict);
 const winnerIndex=attempts.findIndex(result=>result.status==='fulfilled'),winner=sources[winnerIndex];
 expect(await db`SELECT id FROM template_candidates WHERE template_id=${template.id}`).toHaveLength(1);
 expect(await db`SELECT id FROM portable_skill_exports WHERE source_template_id=${template.id} AND target_revision=2`).toHaveLength(1);

 const f=fake(),lock=await leader();
 try{
  await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);
  f.setSnapshot('ready');await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);
  expect(f.calls.filter(call=>call.startsWith('snapshot companions-'))).toHaveLength(1);
  expect((await db`SELECT revision,snapshot_name,source_companion_id,model_id FROM agent_templates WHERE id=${template.id}`)[0]).toMatchObject({revision:2,snapshot_name:'companions-'+commands[winnerIndex],source_companion_id:winner.companionId,model_id:'specialist-model'});
  expect(await db`SELECT revision FROM template_revisions WHERE template_id=${template.id} AND revision=2`).toHaveLength(1);
  expect((await db`SELECT status FROM template_candidates WHERE template_id=${template.id}`)[0].status).toBe('activated');

  await db`UPDATE delegations SET finished_at=now() WHERE run_id=${winner.runId}`;
  await db`UPDATE companions SET archive_requested_at=now(),prepare_requested=false WHERE id=${winner.companionId}`;
  await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);
  const [retired]=await db`SELECT id,retired_at,create_key,agent_secret FROM companions WHERE id=${winner.companionId}`;
  expect(retired.retired_at).not.toBeNull();

  const replica=await spawnChild(owner,id,null,crypto.randomUUID(),{templateId:template.id,prompt:'Use promoted environment'});
  const [fresh]=await db`SELECT id,template_revision,snapshot_name,create_key,agent_secret,box_id,endpoint_secret,skills_staged_hash,model_id FROM companions WHERE id=${replica.companionId}`;
  expect(fresh).toMatchObject({template_revision:2,snapshot_name:'companions-'+commands[winnerIndex],box_id:null,endpoint_secret:null,skills_staged_hash:null,model_id:'specialist-model'});
  expect(fresh.id).not.toBe(retired.id);expect(fresh.create_key).not.toBe(retired.create_key);expect(fresh.agent_secret).not.toBe(retired.agent_secret);
  const [promoted]=await db`SELECT source_companion_id FROM template_revisions WHERE template_id=${template.id} AND revision=2`;
  expect(promoted.source_companion_id).toBe(winner.companionId);
 }finally{await lock.close();}
});

test('snapshot failure at activation checkpoint recovers without repeating capture',async()=>{
 const {id,template}=await setup(),child=await spawnChild(owner,id,null,crypto.randomUUID(),{templateId:template.id,prompt:'Prepare'});
 await db`UPDATE companions SET box_id='source',prepare_requested=false WHERE id=${child.companionId}`;await db`UPDATE runs SET status='succeeded',finished_at=now() WHERE id=${child.runId}`;
 const command=crypto.randomUUID();await adoptTemplate(owner,id,command,{templateId:template.id,childId:child.companionId,expectedRevision:1});
 const f=fake(),lock=await leader();
 try{
  await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);f.setSnapshot('ready');
  await db.unsafe(`CREATE FUNCTION lifecycle_reject_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected checkpoint failure'; END $$; CREATE TRIGGER lifecycle_reject_activation BEFORE UPDATE ON agent_templates FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_activation()`);
  try{await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);}finally{await db.unsafe('DROP TRIGGER lifecycle_reject_activation ON agent_templates; DROP FUNCTION lifecycle_reject_activation()');}
  expect((await db`SELECT status FROM template_candidates WHERE id=${command}`)[0].status).toBe('capturing');
  await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);
  expect((await db`SELECT status FROM template_candidates WHERE id=${command}`)[0].status).toBe('activated');
  expect(f.calls.filter(call=>call.startsWith('snapshot companions-'))).toHaveLength(1);
 }finally{await lock.close();}
});

test('child finalization waits for durable files and parent review, then archives only that child after inactivity',async()=>{
 const {id,template}=await setup(),child=await spawnChild(owner,id,null,crypto.randomUUID(),{templateId:template.id,prompt:'Build result'});
 await db`UPDATE companions SET prepare_requested=false WHERE id=${child.companionId}`;await db`UPDATE runs SET status='succeeded',finished_at=now(),result_text='Retained result' WHERE id=${child.runId}`;
 const f=fake(),lock=await leader();let durable=false;
 try{
  await progressLifecycle(lock.sql,{filesDurable:async()=>durable},f.machine);expect(f.calls).toEqual([]);
  expect((await delegationStatus(owner,child.runId))!.returnedRunId).toBeNull();
  durable=true;await progressLifecycle(lock.sql,{filesDurable:async()=>durable},f.machine);
  const state=await delegationStatus(owner,child.runId);expect(state!.returnedRunId).not.toBeNull();expect(state!.filesSavedAt).not.toBeNull();
  await progressLifecycle(lock.sql,{filesDurable:async()=>durable},f.machine);expect(f.calls).toEqual([]);
  await db`UPDATE runs SET status='succeeded',finished_at=now() WHERE id=${state!.returnedRunId}`;
  await progressLifecycle(lock.sql,{filesDurable:async()=>durable},f.machine);await progressLifecycle(lock.sql,{filesDurable:async()=>durable},f.machine);
  expect(f.calls).toEqual([]);
  await db`UPDATE companions SET status='ready',machine_activity_at=now()-interval '31 minutes' WHERE id=${child.companionId}`;
  await db`UPDATE runs SET finished_at=now()-interval '31 minutes',started_at=now()-interval '32 minutes',created_at=now()-interval '32 minutes' WHERE companion_id=${child.companionId}`;
  await progressLifecycle(lock.sql,{filesDurable:async()=>durable},f.machine);
  expect(f.calls).toEqual(['archive '+child.companionId]);
  expect((await db`SELECT retired_at FROM companions WHERE id=${child.companionId}`)[0].retired_at).not.toBeNull();
  expect((await db`SELECT result FROM delegations WHERE run_id=${child.runId}`)[0].result.text).toBe('Retained result');
  expect((await db`SELECT retired_at FROM companions WHERE id=${id}`)[0].retired_at).toBeNull();
 }finally{await lock.close();}
});

test('usage delivery retries with the same persisted ID without repeating machine preparation',async()=>{
 const id=await parent(),f=fake(),lock=await leader();const events:string[]=[];
 try{await handleLifecycle({operation:'prepare',companionId:id},owner);
  const hook={async recordUsage(event:any){events.push(event.id);throw Error('Billing offline');}};
  await progressLifecycle(lock.sql,hook,f.machine);const first=[...events];await progressLifecycle(lock.sql,{async recordUsage(event){events.push(event.id);}},f.machine);
  expect(events).toEqual([...first,...first]);expect(f.calls.filter(c=>c.startsWith('prepare'))).toHaveLength(1);
 }finally{await lock.close();}
});

(process.env.RUN_LOCAL_ACCEPTANCE==='1'?test:test.skip)('legacy local takeover fails without freezing headless subprocesses',async()=>{
 const id=await parent(owner,'local');const [companion]=await db`SELECT * FROM companions WHERE id=${id}`;
 await prepareLocal(companion);
 const listing=Bun.spawn(['docker','ps','--filter',`label=companions.build.verification=${process.env.COMPANIONS_VERIFY_RUN??'development'}`,'--format','{{.Names}}'],{stdout:'pipe'});
 const names=(await new Response(listing.stdout).text()).trim().split('\n');await listing.exited;
 const name=names.find(name=>name.endsWith(id));if(!name)throw Error('Owned test container missing');
 const marker=join(dataDir,'agents',id,'freeze-test');
 const writer=Bun.spawn(['docker','exec',name,'sh','-c','sleep 0.4; printf done > /state/freeze-test'],{stdout:'ignore',stderr:'pipe'});
 await expect(pauseMachine(companion,true)).rejects.toThrow('desktop_isolation_upgrade_required');
 expect(await writer.exited).toBe(0);expect(await Bun.file(marker).text()).toBe('done');
},15_000);


test('a fresh preview health retry avoids repeating machine configuration',async()=>{
 const id=await parent(),f=fake(),lock=await leader();let checks=0;
 f.machine.health=async()=>{checks++;if(checks===1)throw Error('preview temporarily unavailable');return {ready:true};};
 try{
  await db`UPDATE companions SET prepare_requested=true WHERE id=${id}`;
  await progressLifecycle(lock.sql,{},f.machine);
  expect(checks).toBe(2);expect(f.calls.filter(call=>call.startsWith('prepare '))).toHaveLength(1);
  expect((await db`SELECT status,prepare_requested FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'ready',prepare_requested:false});
 }finally{await lock.close();}
});

test('two failed fresh health checks leave ordinary machine repair available',async()=>{
 const id=await parent(),f=fake(),lock=await leader();let checks=0,healthy=false;
 f.machine.health=async()=>{checks++;return {ready:healthy};};
 try{
  await db`UPDATE companions SET prepare_requested=true WHERE id=${id}`;
  await progressLifecycle(lock.sql,{},f.machine);
  expect(checks).toBe(2);
  expect((await db`SELECT status,endpoint_secret,prepare_requested FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'preparing',endpoint_secret:null,prepare_requested:true});
  healthy=true;await progressLifecycle(lock.sql,{},f.machine);
  expect(checks).toBe(3);expect(f.calls.filter(call=>call.startsWith('prepare '))).toHaveLength(2);
  expect((await db`SELECT status FROM companions WHERE id=${id}`)[0].status).toBe('ready');
 }finally{await lock.close();}
});

test('an invalid warm endpoint is cleared immediately without a fresh-preview retry',async()=>{
 const id=await parent(),f=fake(),lock=await leader();let checks=0;
 f.machine.health=async()=>{checks++;throw Error('expired warm preview');};
 try{
  const [row]=await db`SELECT agent_secret FROM companions WHERE id=${id}`;
  await db`UPDATE companions SET prepare_requested=true,status='ready',box_id='known',endpoint_secret=${encrypt('http://expired')},config_digest=${environmentDigest(row.agent_secret)} WHERE id=${id}`;
  await progressLifecycle(lock.sql,{},f.machine);
  expect(checks).toBe(1);expect(f.calls).toEqual([]);
  expect((await db`SELECT endpoint_secret FROM companions WHERE id=${id}`)[0].endpoint_secret).toBeNull();
 }finally{await lock.close();}
});

for(const change of ['leader','revocation','deadline'] as const)test(`fresh-preview retry stops after ${change} changes during first health`,async()=>{
 const id=await parent(),f=fake(),lock=await leader();let checks=0,allowed=true,prepared:any;
 const original=f.machine.prepare;f.machine.prepare=async(...args)=>{prepared=args[0];return original(...args);};
 f.machine.health=async()=>{
  checks++;
  if(change==='leader')await lock.sql`SELECT pg_advisory_unlock(721440139)`;
  if(change==='revocation')allowed=false;
  if(change==='deadline')prepared.preparation_started_at=new Date(Date.now()-6*60_000);
  throw Error('preview unavailable');
 };
 try{
  await db`UPDATE companions SET prepare_requested=true WHERE id=${id}`;
  const progress=progressLifecycle(lock.sql,{canStartWork:async()=>allowed},f.machine);
  if(change==='leader')await expect(progress).rejects.toThrow('Executor ownership required');
  else if(change==='revocation')await expect(progress).rejects.toBeInstanceOf(ExecutionStopped);
  else await progress;
  expect(checks).toBe(1);expect((await db`SELECT ready_at FROM companions WHERE id=${id}`)[0].ready_at).toBeNull();
 }finally{await lock.close();}
});


for(const active of [false,true])test(`healthy GUI takeover/release ignores platform template digest drift${active?' with both lanes active':''}`,async()=>{
 const id=await parent(),f=fake(true),lock=await leader(),previous=config.boxTemplate;
 try{
  config.boxTemplate='previous-platform-snapshot';
  const [row]=await db`SELECT agent_secret FROM companions WHERE id=${id}`;
  const staged=environmentDigest(row.agent_secret),endpoint=encrypt('http://unchanged-agent');
  await db`UPDATE companions SET status='ready',box_id='same-box',endpoint_secret=${endpoint},config_digest=${staged},desktop_boundary_version=1,ready_at=now() WHERE id=${id}`;
  const runs:string[]=[];
  if(active)for(const lane of ['main','background']){
   const run=await acceptMessage(owner,id,crypto.randomUUID(),'Keep working');runs.push(run!);
   await db`UPDATE runs SET lane=${lane},status='running',dispatched=true,started_at=now() WHERE id=${run}`;
  }
  config.boxTemplate='new-platform-snapshot';expect(environmentDigest(row.agent_secret)).not.toBe(staged);
  for(const operation of ['desktop_takeover','desktop_release']){
   await handleLifecycle({operation,companionId:id,source:'human'},owner);
   expect((await db`SELECT prepare_requested FROM companions WHERE id=${id}`)[0].prepare_requested).toBe(false);
   await progressLifecycle(lock.sql,{},f.machine);
  }
  expect(f.calls).toEqual(['pause true','pause false']);
  expect((await db`SELECT status,box_id,endpoint_secret,config_digest FROM companions WHERE id=${id}`)[0]).toMatchObject({status:'ready',box_id:'same-box',endpoint_secret:endpoint,config_digest:staged});
  if(active)expect((await db`SELECT status FROM runs WHERE companion_id=${id}`).map((r:any)=>r.status)).toEqual(['running','running']);
 }finally{config.boxTemplate=previous;await lock.close();}
});

test('explicit preparation waits for running and parked sessions while GUI remains usable',async()=>{
 const id=await parent(),f=fake(true),lock=await leader();
 try{
  const [row]=await db`SELECT agent_secret FROM companions WHERE id=${id}`;
  const staged='previous-applied-digest',endpoint=encrypt('http://still-running');
  await db`UPDATE companions SET status='ready',box_id='same-box',endpoint_secret=${endpoint},config_digest=${staged},desktop_boundary_version=1,ready_at=now() WHERE id=${id}`;
  const main=await acceptMessage(owner,id,crypto.randomUUID(),'Main'),background=await acceptMessage(owner,id,crypto.randomUUID(),'Background');
  await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${main}`;
  await db`UPDATE runs SET lane='background',status='needs_input',dispatched=true,started_at=now() WHERE id=${background}`;
  await handleLifecycle({operation:'prepare',companionId:id},owner);
  await handleLifecycle({operation:'desktop_takeover',companionId:id,source:'human'},owner);
  await progressLifecycle(lock.sql,{},f.machine);expect(f.calls).toEqual(['pause true']);
  expect((await db`SELECT prepare_requested,preparation_started_at,config_digest FROM companions WHERE id=${id}`)[0]).toMatchObject({prepare_requested:true,preparation_started_at:null,config_digest:staged});
  await db`UPDATE runs SET status='succeeded',finished_at=now() WHERE id=${main}`;
  f.calls.length=0;await progressLifecycle(lock.sql,{},f.machine);expect(f.calls).toEqual(['pause true']);
  await db`UPDATE runs SET status='succeeded',finished_at=now() WHERE id=${background}`;
  f.calls.length=0;await progressLifecycle(lock.sql,{},f.machine);
  expect(f.calls.filter(call=>call.startsWith('prepare '))).toHaveLength(1);
  expect((await db`SELECT prepare_requested,config_digest FROM companions WHERE id=${id}`)[0]).toMatchObject({prepare_requested:false,config_digest:environmentDigest(row.agent_secret)});
 }finally{await lock.close();}
});

test('an execution admitted during preparation is checked again before the next machine effect',async()=>{
 const id=await parent(),f=fake(),lock=await leader();let effects=0;
 f.machine.prepare=async(_companion,_checkpoint,_configured,beforeEffect)=>{
  const run=await acceptMessage(owner,id,crypto.randomUUID(),'Concurrent admission');
  await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${run}`;
  await beforeEffect!();effects++;return 'http://unexpected';
 };
 try{
  await handleLifecycle({operation:'prepare',companionId:id},owner);
  await expect(progressLifecycle(lock.sql,{},f.machine)).rejects.toBeInstanceOf(ExecutionStopped);
  expect(effects).toBe(0);expect((await db`SELECT config_digest FROM companions WHERE id=${id}`)[0].config_digest).toBeNull();
 }finally{await lock.close();}
});


test('a local coordinator can spawn a specialist from a published Box snapshot',async()=>{
 const id=await parent(owner,'local');
 const template=await saveTemplate(owner,{name:'Prepared specialist'});
 await db`UPDATE agent_templates SET snapshot_name='specialist-prepared',revision=2 WHERE id=${template.id}`;
 await allowTemplate(owner,id,{templateId:template.id,maxChildren:2});
 const command=crypto.randomUUID();
 const child=await spawnChild(owner,id,null,command,{templateId:template.id,prompt:'Dis bonjour.'});
 const [saved]=await db`SELECT provider,snapshot_name,template_revision,parent_id,box_id FROM companions WHERE id=${child.companionId}`;
 expect(saved).toMatchObject({provider:'box',snapshot_name:'specialist-prepared',template_revision:2,parent_id:id,box_id:null});
 expect(await spawnChild(owner,id,null,command,{templateId:template.id,prompt:'Dis bonjour.'})).toEqual(child);
});
