import {beforeAll,afterEach,test,expect} from 'bun:test';
import {db,migrate,createCompanion} from '../src/store';
import {config} from '../src/config';
import {prepareBox,machinePreparationReady} from '../src/machines';
import {managedBaseImageReleaseDigest} from '../src/managed-base-image';
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
