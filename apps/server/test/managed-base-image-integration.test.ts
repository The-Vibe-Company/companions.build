import {beforeAll,afterEach,test,expect} from 'bun:test';
import {db,migrate,createCompanion} from '../src/store';
import {config} from '../src/config';
import {prepareBox,machinePreparationReady} from '../src/machines';
import {managedBaseImageReleaseDigest,pinManagedBaseImage,resolveManagedBaseImage} from '../src/managed-base-image';
import {BoxError} from '../../../packages/box/client';
const owner='00000000-0000-4000-8000-000000000001';
const originalManaged=config.managedBoxTemplate;
const owned:string[]=[];
beforeAll(async()=>{await migrate();});
afterEach(async()=>{
 config.managedBoxTemplate=originalManaged;
 for(const id of owned.splice(0))await db`DELETE FROM companions WHERE id=${id}`;
 await db`DELETE FROM managed_base_images`;
});
async function companion(){const row=await createCompanion(owner,{name:'Managed image race',provider:'box'});owned.push(row.id);return row;}
async function image(releaseDigest:string,status:string,options:{deleteIntent?:boolean;deleted?:boolean;readyAt?:Date}={}){
 const id=crypto.randomUUID(),name=`cb-test-${id.replaceAll('-','').slice(0,16)}`;
 await db`INSERT INTO managed_base_images(id,release_digest,generation,snapshot_name,archive,journal,status,ready_at,delete_intent_at,deleted_at)
  VALUES(${id},${releaseDigest},1,${name},${Buffer.from('test')},${{version:1}}::jsonb,${status},${options.readyAt??new Date()},${options.deleteIntent?new Date():null},${options.deleted?new Date():null})`;
 return {id,name};
}

test('last verified image carries new companions through publication and quarantine, then current wins',async()=>{
 const current=await managedBaseImageReleaseDigest(),previous='a'.repeat(64);
 const fallback=await image(previous,'ready',{readyAt:new Date(Date.now()-60_000)}),candidate=await image(current,'publishing');
 const inFlight=await companion();
 expect(await resolveManagedBaseImage()).toBe(fallback.name);
 expect(await pinManagedBaseImage(inFlight.id)).toBe(fallback.name);

 await db`UPDATE managed_base_images SET status='blocked',error_code='distribution_content_mismatch' WHERE id=${candidate.id}`;
 expect(await resolveManagedBaseImage()).toBe(fallback.name);
 await db`UPDATE companions SET create_started_at=now() WHERE id=${inFlight.id}`;
 await db`UPDATE managed_base_images SET status='retired',retired_at=now() WHERE id=${fallback.id}`;
 await db`UPDATE managed_base_images SET status='ready',ready_at=now(),error_code=null WHERE id=${candidate.id}`;

 expect(await resolveManagedBaseImage()).toBe(candidate.name);
 expect(await pinManagedBaseImage(inFlight.id)).toBe(fallback.name);
 const fresh=await companion();expect(await pinManagedBaseImage(fresh.id)).toBe(candidate.name);
});

test('quarantined, missing and deleting images are never fallback candidates',async()=>{
 const current=await managedBaseImageReleaseDigest();
 await image(current,'blocked');
 await image('b'.repeat(64),'missing');
 await image('c'.repeat(64),'failed');
 await image('d'.repeat(64),'ready',{deleteIntent:true});
 await image('e'.repeat(64),'retired',{deleted:true});
 expect(await resolveManagedBaseImage()).toBeNull();
 const row=await companion();expect(await pinManagedBaseImage(row.id)).toBeNull();
});

test('missing managed snapshot between pin and create waits for republication without replaying starts',async()=>{
 config.managedBoxTemplate=true;
 const row=await companion(),name='cb-test-deleted-base';
 await db`INSERT INTO managed_base_images(id,release_digest,generation,snapshot_name,archive,journal,status)
  VALUES(${crypto.randomUUID()},${await managedBaseImageReleaseDigest()},1,${name},${Buffer.from('test')},'{}'::jsonb,'ready')`;
 expect(await machinePreparationReady(row)).toBe(true);
 await db`UPDATE companions SET create_started_at=now(),preparation_started_at=now() WHERE id=${row.id}`;
 let creates=0;
 const provider={create:async()=>{creates++;throw new BoxError('box_not_found',404);},getSnapshot:async()=>{throw new BoxError('box_not_found',404);}};
 expect(await prepareBox(row,async()=>{throw Error('unexpected checkpoint');},async()=>{},async()=>{},provider as any)).toBeNull();
 expect((await db`SELECT snapshot_name,create_started_at,preparation_started_at FROM companions WHERE id=${row.id}`)[0])
  .toMatchObject({snapshot_name:null,create_started_at:null,preparation_started_at:null});
 expect((await db`SELECT status FROM managed_base_images WHERE snapshot_name=${name}`)[0].status).toBe('missing');
 expect(await machinePreparationReady(row)).toBe(false);
 expect(creates).toBe(1);
});

test('an explicit specialist image is preserved and an unknown create result keeps its pinned source',async()=>{
 config.managedBoxTemplate=true;
 const row=await companion();
 await db`UPDATE companions SET snapshot_name='specialist-private-source',create_started_at=now() WHERE id=${row.id}`;
 expect(await machinePreparationReady(row)).toBe(true);
 expect(row.snapshot_name).toBe('specialist-private-source');
 await expect(prepareBox(row,async()=>{},async()=>{},async()=>{},
  {create:async()=>{throw new BoxError('box_unreachable');}} as any)).rejects.toThrow('box_unreachable');
 expect((await db`SELECT snapshot_name,create_started_at FROM companions WHERE id=${row.id}`)[0])
  .toMatchObject({snapshot_name:'specialist-private-source',create_started_at:expect.any(Date)});
});
