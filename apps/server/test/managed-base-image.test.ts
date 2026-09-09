import {afterEach,beforeAll,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {BoxError} from '../../../packages/box/client';
import {manifestDigest,type DistributionManifest} from '../../../scripts/lib/distribution-verification';
import {acquireExecutor} from '../src/executor';
import {ManagedBaseImageCoordinator} from '../src/managed-base-image';
import {createCompanion,db,migrate} from '../src/store';
import {config} from '../src/config';

const owner='00000000-0000-4000-8000-000000000001';
const companions:string[]=[];

beforeAll(async()=>{
 await migrate();
 await db.unsafe(await Bun.file(new URL('../src/managed-base-image.sql',import.meta.url)).text());
});
afterEach(async()=>{
 for(const id of companions.splice(0))await db`UPDATE companions SET prepare_requested=false,retired_at=now() WHERE id=${id}`;
 await db`DELETE FROM managed_base_images`;
});

async function leader(){
 const sql=await acquireExecutor();if(!sql)throw Error('Test executor lock unavailable');
 return {sql,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};
}
async function settled(...items:ManagedBaseImageCoordinator[]){
 const deadline=Date.now()+5_000;
 while(items.some(item=>item.active)){if(Date.now()>deadline)throw Error('Coordinator did not settle');await Bun.sleep(5);}
}

function artifact(content:string){
 const bytes=Buffer.from(content),manifest:DistributionManifest={version:1,files:[{path:'companion-agent',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
 const archive=Buffer.from(`archive:${content}`);
 return {releaseDigest:manifestDigest(manifest),manifest,archive,archiveDigest:createHash('sha256').update(archive).digest('hex')};
}

class FakeBox {
 boxes=new Map<string,{id:string;state:string;setupStatus:string}>();
 snapshots=new Set<string>();
 creates:Array<{key:string;template?:string}>=[];
 deletes:string[]=[];
 stops:string[]=[];
 verificationCount=0;
 rateLimits=0;
 ambiguousCreates=0;
 snapshotLimits=0;
 snapshotState='ready';
 mismatchVerification=false;
 deleteSawArchived:boolean[]=[];
 constructor(public manifest:DistributionManifest){}
 async create(key:string,template?:string){
  this.creates.push({key,template});
  if(this.rateLimits>0){this.rateLimits--;throw new BoxError('box_start_rate_limited',429);}
  if(this.ambiguousCreates>0){this.ambiguousCreates--;throw new BoxError('box_unreachable');}
  const id=`bx_managed_${this.creates.length}`;const box={id,state:'ready',setupStatus:'done'};this.boxes.set(id,box);return box;
 }
 async get(id:string){const box=this.boxes.get(id);if(!box)throw new BoxError('box_not_found',404);return {...box};}
 async resume(id:string){const box=this.boxes.get(id);if(!box)throw new BoxError('box_not_found',404);box.state='ready';}
 async command(_id:string,command:string){
  if(command.includes('expected=json.loads')){
   this.verificationCount++;
   if(this.mismatchVerification&&this.verificationCount===2)return JSON.stringify({...this.manifest,files:this.manifest.files.map(file=>({...file,size:file.size+1}))});
   return JSON.stringify(this.manifest);
  }
  if(command.includes("printf fresh"))return 'fresh';
  return '';
 }
 async snapshot(_id:string,name:string){if(this.snapshotLimits>0){this.snapshotLimits--;throw new BoxError('box_snapshot_limit',409);}this.snapshots.add(name);return {};}
 async getSnapshot(name:string){if(!this.snapshots.has(name))throw new BoxError('box_not_found',404);return {status:this.snapshotState};}
 async stop(id:string){const box=this.boxes.get(id);if(!box)throw new BoxError('box_not_found',404);box.state='archived';this.stops.push(id);}
 async writeFile(){return {};}
 async deleteSnapshot(name:string){
  if(!this.snapshots.has(name))throw new BoxError('box_not_found',404);
  this.deleteSawArchived.push([...this.boxes.values()].every(box=>box.state==='archived'));
  this.snapshots.delete(name);this.deletes.push(name);return {};
 }
}

function coordinator(box:FakeBox,value:ReturnType<typeof artifact>,now:()=>number=Date.now){
 return new ManagedBaseImageCoordinator({database:db,box:box as any,artifact:async()=>value,now,enabled:true});
}

test('consuming managed images without publication permission makes no provider or database effects',async()=>{
 const previous={managed:config.managedBoxTemplate,publish:config.publishManagedBoxTemplate};
 config.managedBoxTemplate=true;config.publishManagedBoxTemplate=false;
 let artifacts=0;
 const value=artifact('shared-account'),box=new FakeBox(value.manifest);
 const publisher=new ManagedBaseImageCoordinator({box:box as any,artifact:async()=>{artifacts++;return value;}});
 try{
  await publisher.schedule((()=>{throw Error('Unexpected database access');}) as any);
  expect(publisher.active).toBe(false);expect(artifacts).toBe(0);
  expect(box.creates).toHaveLength(0);expect(box.deletes).toHaveLength(0);expect(box.stops).toHaveLength(0);
 }finally{await publisher.close();config.managedBoxTemplate=previous.managed;config.publishManagedBoxTemplate=previous.publish;}
});

test('concurrent coordinators publish one verified image and archive both owned Boxes',async()=>{
 const value=artifact('release-one'),box=new FakeBox(value.manifest),lock=await leader();
 const first=coordinator(box,value),second=coordinator(box,value);
 try{
  await Promise.all([first.schedule(lock.sql),second.schedule(lock.sql)]);
  await settled(first,second);
  const rows=await db`SELECT * FROM managed_base_images WHERE release_digest=${value.releaseDigest}`;
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({generation:1,status:'ready',error_code:null});
  expect(box.creates).toHaveLength(2);expect(box.creates[1].template).toBe(rows[0].snapshot_name);
  expect(box.verificationCount).toBe(2);expect(box.stops).toHaveLength(2);
  expect([...box.boxes.values()].map(item=>item.state)).toEqual(['archived','archived']);
  expect(rows[0].journal).toMatchObject({boxId:box.stops[0],sourceArchivedAt:expect.any(String),contentVerifiedAt:expect.any(String),completedAt:expect.any(String),verification:{boxId:box.stops[1],archivedAt:expect.any(String)}});
 }finally{await first.close();await second.close();await lock.close();}
});

test('a rejected start waits and retries the same persisted generation and request key',async()=>{
 let clock=Date.parse('2026-09-09T12:00:00.000Z');const now=()=>clock;
 const value=artifact('rate-limited-release'),box=new FakeBox(value.manifest),lock=await leader();box.rateLimits=1;
 try{
  const initial=coordinator(box,value,now);await initial.schedule(lock.sql);await settled(initial);await initial.close();
  const [deferred]=await db`SELECT id,generation,journal,retry_at FROM managed_base_images WHERE release_digest=${value.releaseDigest}`;
  expect(deferred).toMatchObject({generation:1,retry_at:expect.any(Date)});expect(box.creates).toHaveLength(1);
  const key=deferred.journal.key;
  const early=coordinator(box,value,now);await early.schedule(lock.sql);await settled(early);await early.close();
  expect(box.creates).toHaveLength(1);
  clock+=60_001;const retry=coordinator(box,value,now);await retry.schedule(lock.sql);await settled(retry);await retry.close();
  const rows=await db`SELECT id,generation,status,journal FROM managed_base_images WHERE release_digest=${value.releaseDigest}`;
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:deferred.id,generation:1,status:'ready'});
  expect(rows[0].journal.key).toBe(key);expect(box.creates[1].key).toBe(key);
 }finally{await lock.close();}
});

test('an ambiguous create remains blocked after coordinator reconstruction without replay',async()=>{
 const value=artifact('ambiguous-release'),box=new FakeBox(value.manifest),lock=await leader();box.ambiguousCreates=1;
 try{
  const initial=coordinator(box,value);await initial.schedule(lock.sql);await settled(initial);await initial.close();
  const [blocked]=await db`SELECT id,generation,status,error_code,journal FROM managed_base_images WHERE release_digest=${value.releaseDigest}`;
  expect(blocked).toMatchObject({generation:1,status:'blocked',error_code:'managed_image_create_unresolved'});
  expect(blocked.journal).toMatchObject({sourceCreateIntentAt:expect.any(String),sourceCreateUnresolvedAt:expect.any(String)});
  const recovered=coordinator(box,value);await recovered.schedule(lock.sql);await settled(recovered);await recovered.close();
  expect(box.creates).toHaveLength(1);
  const rows=await db`SELECT id FROM managed_base_images WHERE release_digest=${value.releaseDigest}`;
  expect(rows).toHaveLength(1);expect(rows[0].id).toBe(blocked.id);
 }finally{await lock.close();}
});

test('a deleted ready snapshot is republished once as the next generation',async()=>{
 const value=artifact('deleted-ready-release'),box=new FakeBox(value.manifest),lock=await leader();
 try{
  const initial=coordinator(box,value);await initial.schedule(lock.sql);await settled(initial);await initial.close();
  const [original]=await db`SELECT id,snapshot_name FROM managed_base_images WHERE release_digest=${value.releaseDigest}`;
  box.snapshots.delete(original.snapshot_name);
  await db`UPDATE managed_base_images SET provider_checked_at=now()-interval '2 minutes' WHERE id=${original.id}`;
  const rebuilt=coordinator(box,value);await rebuilt.schedule(lock.sql);await settled(rebuilt);await rebuilt.close();
  const rows=await db`SELECT id,generation,status FROM managed_base_images WHERE release_digest=${value.releaseDigest} ORDER BY generation`;
  expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({id:original.id,generation:1,status:'deleted'});expect(rows[1]).toMatchObject({generation:2,status:'ready'});
  const stable=coordinator(box,value);await stable.schedule(lock.sql);await settled(stable);await stable.close();
  expect(await db`SELECT id FROM managed_base_images WHERE release_digest=${value.releaseDigest}`).toHaveLength(2);
 }finally{await lock.close();}
});

test('a pending observation keeps the verified generation ready',async()=>{
 const value=artifact('pending-observation-release'),box=new FakeBox(value.manifest),lock=await leader();
 try{
  const initial=coordinator(box,value);await initial.schedule(lock.sql);await settled(initial);await initial.close();
  const [published]=await db`SELECT id,generation,snapshot_name FROM managed_base_images WHERE release_digest=${value.releaseDigest}`;
  box.snapshotState='pending';
  await db`UPDATE managed_base_images SET provider_checked_at=now()-interval '2 minutes' WHERE id=${published.id}`;
  const observed=coordinator(box,value);await observed.schedule(lock.sql);await settled(observed);await observed.close();
  const rows=await db`SELECT id,generation,status,deleted_at FROM managed_base_images WHERE release_digest=${value.releaseDigest}`;
  expect(rows).toEqual([{id:published.id,generation:1,status:'ready',deleted_at:null}]);
  expect(box.deletes).toEqual([]);expect(box.creates).toHaveLength(2);
 }finally{await lock.close();}
});

test('a captured snapshot blocked by verifier failure is reclaimed without republishing the bad release',async()=>{
 const value=artifact('blocked-verifier-release'),box=new FakeBox(value.manifest),lock=await leader();box.mismatchVerification=true;
 try{
  const failed=coordinator(box,value);await failed.schedule(lock.sql);await settled(failed);await failed.close();
  const [blocked]=await db`SELECT id,snapshot_name,status,error_code,journal FROM managed_base_images WHERE release_digest=${value.releaseDigest}`;
  expect(blocked).toMatchObject({status:'blocked',error_code:'distribution_content_mismatch',journal:{snapshotRequestedAt:expect.any(String),sourceArchivedAt:expect.any(String),verification:{boxId:expect.any(String),archivedAt:expect.any(String)}}});
  expect(box.snapshots.has(blocked.snapshot_name)).toBe(true);

  box.mismatchVerification=false;box.verificationCount=0;
  const recovered=coordinator(box,value);await recovered.schedule(lock.sql);await settled(recovered);await recovered.close();
  const rows=await db`SELECT id,generation,status,deleted_at FROM managed_base_images WHERE release_digest=${value.releaseDigest} ORDER BY generation`;
  expect(rows).toEqual([{id:blocked.id,generation:1,status:'blocked',deleted_at:expect.any(Date)}]);
  expect(box.deletes).toContain(blocked.snapshot_name);expect(box.deleteSawArchived).toEqual([true]);
  expect(box.creates).toHaveLength(2);
  const stable=coordinator(box,value);await stable.schedule(lock.sql);await settled(stable);await stable.close();
  expect(box.creates).toHaveLength(2);
 }finally{await lock.close();}
});

test('snapshot capacity retries the same source and journal after the cooldown',async()=>{
 let clock=Date.parse('2026-09-09T12:00:00.000Z');const now=()=>clock;
 const value=artifact('snapshot-capacity-release'),box=new FakeBox(value.manifest),lock=await leader();box.snapshotLimits=1;
 try{
  const initial=coordinator(box,value,now);await initial.schedule(lock.sql);await settled(initial);await initial.close();
  const [waiting]=await db`SELECT id,generation,status,error_code,retry_at,journal FROM managed_base_images WHERE release_digest=${value.releaseDigest}`;
  expect(waiting).toMatchObject({generation:1,status:'publishing',error_code:'managed_image_snapshot_capacity_unavailable',retry_at:expect.any(Date)});
  expect(box.creates).toHaveLength(1);expect([...box.boxes.values()][0].state).toBe('archived');
  const key=waiting.journal.key,source=waiting.journal.boxId;
  clock+=5*60_000+1;const retry=coordinator(box,value,now);await retry.schedule(lock.sql);await settled(retry);await retry.close();
  const rows=await db`SELECT id,generation,status,journal FROM managed_base_images WHERE release_digest=${value.releaseDigest}`;
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:waiting.id,generation:1,status:'ready'});
  expect(rows[0].journal).toMatchObject({key,boxId:source,sourceArchivedAt:expect.any(String),verification:{archivedAt:expect.any(String)}});
  expect(box.creates.filter(item=>item.template===undefined)).toHaveLength(1);
 }finally{await lock.close();}
});

test('release cleanup deletes only unreferenced managed snapshots',async()=>{
 const old=artifact('old-release'),box=new FakeBox(old.manifest),lock=await leader();
 try{
  const first=coordinator(box,old);await first.schedule(lock.sql);await settled(first);await first.close();
  const [published]=await db`SELECT * FROM managed_base_images WHERE release_digest=${old.releaseDigest}`;
  const existing=await createCompanion(owner,{name:'Existing Box',provider:'box',prepare:false});companions.push(existing.id);
  await db`UPDATE companions SET snapshot_name=${published.snapshot_name},box_id='bx_existing' WHERE id=${existing.id}`;

  const protectedName=`cb-protected-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`;
  const protectedId=crypto.randomUUID(),protectedRelease='f'.repeat(64);
  await db`INSERT INTO managed_base_images(id,release_digest,generation,snapshot_name,archive,journal,status,retired_at)
   VALUES(${protectedId},${protectedRelease},1,${protectedName},${Buffer.from('protected')},${{version:1}}::jsonb,'retired',now())`;
  box.snapshots.add(protectedName);
  const pending=await createCompanion(owner,{name:'Pending fork',provider:'box',prepare:false});companions.push(pending.id);
  await db`UPDATE companions SET snapshot_name=${protectedName},box_id=null,create_started_at=null WHERE id=${pending.id}`;
  const unrelated=`outside-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`;box.snapshots.add(unrelated);

  const replacement=artifact('replacement-release');box.manifest=replacement.manifest;
  const next=coordinator(box,replacement);await next.schedule(lock.sql);await settled(next);await next.close();
  expect(box.deletes).toEqual([published.snapshot_name]);
  expect(box.snapshots.has(published.snapshot_name)).toBe(false);
  expect(box.snapshots.has(protectedName)).toBe(true);expect(box.snapshots.has(unrelated)).toBe(true);
  expect((await db`SELECT status,deleted_at FROM managed_base_images WHERE id=${published.id}`)[0]).toMatchObject({status:'deleted',deleted_at:expect.any(Date)});
  expect((await db`SELECT status,deleted_at FROM managed_base_images WHERE id=${protectedId}`)[0]).toMatchObject({status:'retired',deleted_at:null});
 }finally{await lock.close();}
});
