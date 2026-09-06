import {beforeAll,afterEach,expect,test} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {acquireExecutor} from '../src/executor';
import {migrateLifecycle,progressLifecycle,handleLifecycle,type LifecycleMachines} from '../src/lifecycle';
import {saveTemplate,allowTemplate,adoptTemplate,LifecycleConflict} from '../src/templates';
import {spawnChild,delegateTask,delegationStatus} from '../src/delegation';
import {dataDir} from '../src/config';
import {prepareLocal,pauseMachine} from '../src/machines';
import {join} from 'node:path';
import {migrateDeliverySkills,type DeliverySkillDependencies} from '../src/delivery-skills';
import {createHash} from 'node:crypto';
const owner='00000000-0000-4000-8000-000000000001',other='lifecycle-other-owner';
const owned:string[]=[];
beforeAll(async()=>{await migrate();await migrateLifecycle();await migrateDeliverySkills();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${other},'Other','lifecycle-other@example.test',true) ON CONFLICT DO NOTHING`;});
afterEach(async()=>{for(const id of owned.splice(0)){await db`UPDATE delegations SET finished_at=now() WHERE parent_id=${id}`;await db`UPDATE template_candidates SET status='failed' WHERE source_companion_id IN (SELECT id FROM companions WHERE parent_id=${id}) AND status IN ('queued','capturing','ready')`;await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id} AND status IN ('queued','preparing','running','needs_input')`;await db`UPDATE companions SET retired_at=now(),prepare_requested=false,desktop_taken=false,desktop_paused_at=null WHERE id=${id} OR parent_id=${id}`;}});
async function parent(ownerId=owner,provider:'local'|'box'='box'){const value=await createCompanion(ownerId,{name:'Parent',instructions:'',provider});owned.push(value.id);await db`UPDATE companions SET prepare_requested=false WHERE id=${value.id}`;return value.id as string;}
async function setup(){const id=await parent();const template=await saveTemplate(owner,{name:'Developer',instructions:'Use the supplied brief.'});await allowTemplate(owner,id,{templateId:template.id,maxChildren:2});return {id,template};}
async function leader(){const sql=await acquireExecutor();if(!sql)throw Error('Test executor lock unavailable');return {sql,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};}
function fake(){
 const calls:string[]=[];let snapshot:'missing'|'pending'|'ready'|'failed'='missing';
 const machine:LifecycleMachines={async prepare(c,checkpoint){calls.push('prepare '+c.id);await checkpoint('box-'+c.id);return 'http://fake.local';},async health(){calls.push('health');return {ready:true};},async pause(_c,value){calls.push('pause '+value);},async archive(c){calls.push('archive '+c.id);return true;},async snapshot(_c,name){calls.push('snapshot '+name);snapshot='pending';},async snapshotStatus(){calls.push('snapshot GET');return snapshot;}};
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
 expect(child).toMatchObject({parent_id:id,temporary:true,prepare_requested:true,template_revision:1});
 await expect(spawnChild(owner,child.id,null,crypto.randomUUID(),{templateId:template.id,prompt:'More'})).rejects.toBeInstanceOf(LifecycleConflict);
 await expect(allowTemplate(owner,child.id,{templateId:template.id,maxChildren:2})).rejects.toBeInstanceOf(LifecycleConflict);
 expect((await db`SELECT agent_secret FROM companions WHERE parent_id=${id}`)[0].agent_secret).not.toBe((await db`SELECT agent_secret FROM companions WHERE id=${id}`)[0].agent_secret);
});

test('duplicate spawn returns the same child and pins its template revision',async()=>{
 const {id,template}=await setup(),command=crypto.randomUUID(),input={templateId:template.id,prompt:'Work'};
 const first=await spawnChild(owner,id,null,command,input);expect(await spawnChild(owner,id,null,command,input)).toEqual(first);
 await expect(spawnChild(owner,id,null,command,{...input,prompt:'Changed'})).rejects.toBeInstanceOf(LifecycleConflict);
 await saveTemplate(owner,{id:template.id,expectedRevision:1,name:'Changed',instructions:'New brief'});
 expect((await db`SELECT instructions,template_revision FROM companions WHERE id=${first.companionId}`)[0]).toMatchObject({instructions:'Use the supplied brief.',template_revision:1});
});

test('open desktop persists a wake without chat; confirmed takeover survives browser closure and releases',async()=>{
 const id=await parent();const f=fake(),lock=await leader();
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

test('failed physical freeze is never projected as a confirmed takeover',async()=>{
 const id=await parent(),f=fake(),lock=await leader();f.machine.pause=async()=>{throw Error('provider payload with secret');};
 try{await handleLifecycle({operation:'desktop_takeover',companionId:id},owner);await progressLifecycle(lock.sql,{},f.machine);
  const [row]=await db`SELECT desktop_taken,desktop_paused_at,error FROM companions WHERE id=${id}`;
  expect(row.desktop_taken).toBe(true);expect(row.desktop_paused_at).toBeNull();expect(row.error).toBe('Desktop takeover could not be confirmed. The agent may still be running.');
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

test('snapshot recovery observes its durable name and activates only after ready',async()=>{
 const {id,template}=await setup(),child=await spawnChild(owner,id,null,crypto.randomUUID(),{templateId:template.id,prompt:'Install software'});
 await db`UPDATE companions SET box_id='snapshot-source',prepare_requested=false WHERE id=${child.companionId}`;
 await db`UPDATE runs SET status='succeeded',finished_at=now(),result_text='Installed' WHERE id=${child.runId}`;
 const command=crypto.randomUUID();await adoptTemplate(owner,id,command,{templateId:template.id,childId:child.companionId,expectedRevision:1});
 const f=fake(),lock=await leader();
 try{
  f.machine.snapshot=async(_c,name)=>{f.calls.push('snapshot '+name);f.setSnapshot('pending');throw Error('Lost response after provider accepted snapshot');};
  await db`UPDATE companions SET desktop_taken=true,desktop_paused_at=now() WHERE id=${child.companionId}`;
  await progressLifecycle(lock.sql,{deliverySkills:f.deliverySkills},f.machine);expect(f.calls).toEqual([]);
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

test('child finalization waits for durable files and parent review, then archives only that child',async()=>{
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

(process.env.RUN_LOCAL_ACCEPTANCE==='1'?test:test.skip)('physical Docker takeover freezes all subprocesses until explicit release',async()=>{
 const id=await parent(owner,'local');const [companion]=await db`SELECT * FROM companions WHERE id=${id}`;
 await prepareLocal(companion);
 const listing=Bun.spawn(['docker','ps','--filter',`label=companions.build.verification=${process.env.COMPANIONS_VERIFY_RUN??'development'}`,'--format','{{.Names}}'],{stdout:'pipe'});
 const names=(await new Response(listing.stdout).text()).trim().split('\n');await listing.exited;
 const name=names.find(name=>name.endsWith(id));if(!name)throw Error('Owned test container missing');
 const marker=join(dataDir,'agents',id,'freeze-test');
 const writer=Bun.spawn(['docker','exec',name,'sh','-c','sleep 0.4; printf done > /state/freeze-test'],{stdout:'ignore',stderr:'pipe'});
 try{
  await pauseMachine(companion,true);await Bun.sleep(700);expect(await Bun.file(marker).exists()).toBe(false);
  await pauseMachine(companion,false);expect(await writer.exited).toBe(0);expect(await Bun.file(marker).text()).toBe('done');
 }finally{await pauseMachine(companion,false);}
},15_000);
