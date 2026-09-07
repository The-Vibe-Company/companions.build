import { beforeAll, afterEach, expect, test } from 'bun:test';
import { BoxError } from '../../../packages/box/client';
import { db, migrate } from '../src/store';
import { acquireExecutor, claimQueuedRuns } from '../src/executor';
import { activateSoftwareBase, enqueueTemplateSoftware, registerSoftwareBase, getSoftwareBuild } from '../src/software';
import { saveTemplate } from '../src/templates';
import { SoftwareBuildCoordinator, type SoftwareBuildMachines, type SoftwareRuntimeHooks } from '../src/software-runtime';
import { softwareManifestDigest } from '../../../packages/control/software';
import { createCompanion, acceptMessage } from '../src/store';

const base={id:'software-runtime-base',providerSnapshotName:'software-runtime-base',distributionDigest:'a'.repeat(64),resolverConfigDigest:'b'.repeat(64),distro:{family:'ubuntu',suite:'noble',architecture:'amd64'}};
const digest='d'.repeat(64);
const manifest={version:1 as const,base:{id:base.id,distributionDigest:base.distributionDigest,distro:base.distro},apt:{roots:['jq:amd64=1.7.1'],packages:[{id:'jq:amd64=1.7.1',name:'jq',version:'1.7.1',architecture:'amd64',sha256:'c'.repeat(64),dependencies:[]}]},npm:{roots:[],packages:[]}};
let leader:any;let pid:number;
let coordinators:SoftwareBuildCoordinator[]=[];
beforeAll(async()=>{await migrate();await registerSoftwareBase(base);await activateSoftwareBase(base.id);});
afterEach(async()=>{
 if(leader){await leader`SELECT pg_advisory_unlock(721440139)`;leader.release();leader=null;}
 await Promise.all(coordinators.map(c=>c.close()));coordinators=[];
 await db`UPDATE portable_software_builds SET status=CASE WHEN status='ready' THEN 'ready' ELSE 'failed' END,cleanup_status='complete'`;
});
async function fixture(){
 leader=await acquireExecutor();expect(leader).not.toBeNull();[{pid}]=await leader`SELECT pg_backend_pid() AS pid`;
 const owner=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${owner},'Build owner',${`${owner}@example.test`},true)`;
 const template=await saveTemplate(owner,{name:'Software',instructions:'Use jq',avatar:{shape:1,color:2,face:3}});
 const build=await enqueueTemplateSoftware(owner,crypto.randomUUID(),{templateId:template.id,expectedRevision:1,apt:[{name:'jq',version:'1.7.1'}],npm:[]});
 let time=Date.now();const c=new SoftwareBuildCoordinator(db,2,()=>time);coordinators.push(c);
 return {owner,template,build,c,advance:(ms:number)=>{time+=ms;},row:()=>getSoftwareBuild(owner,build.id)};
}
function fake(){
 const calls:string[]=[];const keys:string[]=[];let archived=false;let snapshot='ready' as 'ready'|'missing'|'pending'|'failed';
 const verified={phase:'verified',requestDigest:digest,manifestDigest:softwareManifestDigest(manifest),errorCode:null,readyForCapture:true};
 const machines:SoftwareBuildMachines={
  create:async b=>{calls.push('create');keys.push(b.createKey);return {id:`box-${b.id}`};},
  get:async()=>{calls.push('get');return {state:archived?'archived':'ready'};},
  resume:async()=>{calls.push('resume');archived=false;},
  prepareHelper:async()=>{calls.push('prepare');return {requestDigest:digest};},
  statusHelper:async()=>{calls.push('status');return null;},
  runHelper:async()=>{calls.push('run');return verified;},
  readManifest:async()=>{calls.push('manifest');return manifest;},
  snapshot:async()=>{calls.push('snapshot');},getSnapshot:async()=>{calls.push('snapshotGet');return {state:snapshot};},
  archive:async()=>{calls.push('archive');archived=true;},
 };
 const hooks:SoftwareRuntimeHooks={machines,canStartWork:async()=>true,onReady:async()=>{calls.push('ready');}};
 return {machines,hooks,calls,keys,verified,setArchived:(value:boolean)=>archived=value,setSnapshot:(value:typeof snapshot)=>snapshot=value};
}
async function idle(c:SoftwareBuildCoordinator){for(let i=0;i<100&&c.activeCount;i++)await Bun.sleep(10);expect(c.activeCount).toBe(0);}

test('verified manifest, snapshot and owner result commit before observed cleanup; old revision remains valid',async()=>{
 const f=await fixture(),m=fake();
 await db`UPDATE agent_templates SET software_build_id=null WHERE id=${f.template.id}`;
 await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'capturing',helperRequestDigest:digest,resolvedManifestDigest:softwareManifestDigest(manifest)});
 expect(m.calls).toEqual(['create','get','prepare','status','run','manifest','snapshot']);
 await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'ready',cleanupStatus:'pending'});
 await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'ready',cleanupStatus:'complete'});
 expect(m.calls.filter(c=>c==='ready')).toHaveLength(1);
 expect((await db`SELECT software_build_id FROM agent_templates WHERE id=${f.template.id}`)[0].software_build_id).toBeNull();
});

test('lost create reply retries the persisted key and never creates a replacement identity',async()=>{
 const f=await fixture(),m=fake();const create=m.machines.create;let first=true;
 m.machines.create=async(b,ctx)=>{const result=await create(b,ctx);if(first){first=false;throw Error('secret provider payload');}return result;};
 await f.c.progress(f.build.id,pid,m.hooks);expect((await f.row())?.boxId).toBeNull();
 await f.c.progress(f.build.id,pid,m.hooks);expect(m.keys).toEqual([f.build.createKey,f.build.createKey]);
 expect((await f.row())?.status).toBe('capturing');
});

test('snapshot intent survives lost POST reply and missing GET; deadline fails without another POST',async()=>{
 const f=await fixture(),m=fake();m.machines.snapshot=async()=>{m.calls.push('snapshot');throw Error('lost reply');};m.setSnapshot('missing');
 await f.c.progress(f.build.id,pid,m.hooks);
 for(let i=0;i<3;i++)await f.c.progress(f.build.id,pid,m.hooks);
 expect(m.calls.filter(c=>c==='snapshot')).toHaveLength(1);expect(m.calls.filter(c=>c==='snapshotGet')).toHaveLength(3);
 f.advance(31*60_000);await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'failed',errorCode:'software_build_deadline'});
 expect(m.calls.filter(c=>c==='snapshot')).toHaveLength(1);
});

for(const stage of ['create','get','prepareHelper','statusHelper','runHelper','readManifest','snapshot','getSnapshot','archive'] as const){
 test(`leader loss after ${stage} prevents every subsequent effect/checkpoint`,async()=>{
  const f=await fixture(),m=fake();
  if(stage==='getSnapshot'||stage==='archive')await f.c.progress(f.build.id,pid,m.hooks);
  const original=m.machines[stage] as any;
  (m.machines as any)[stage]=async(...args:any[])=>{const result=await original(...args);await leader`SELECT pg_advisory_unlock(721440139)`;return result;};
  await f.c.progress(f.build.id,pid,m.hooks);
  const count=m.calls.length;await f.c.progress(f.build.id,pid,m.hooks);expect(m.calls).toHaveLength(count);
  if(stage==='create')expect((await f.row())?.boxId).toBeNull();
  if(stage==='snapshot')expect((await f.row())?.status).toBe('capturing');
  if(stage==='getSnapshot')expect(m.calls).not.toContain('ready');
 });
}

test('a leader already lost never contacts a machine',async()=>{
 const f=await fixture(),m=fake();await leader`SELECT pg_advisory_unlock(721440139)`;
 await f.c.progress(f.build.id,pid,m.hooks);expect(m.calls).toEqual([]);
});

test('entitlement denial fails visibly before create, but revoked owners still get cleanup and reconciliation',async()=>{
 const f=await fixture(),m=fake();m.hooks.canStartWork=async()=>false;
 await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'failed',errorCode:'software_subscription_required'});expect(m.calls).toEqual([]);
});

test('revocation during GET prevents helper effects and still archives the owned machine',async()=>{
 const f=await fixture(),m=fake();let allowed=true;m.hooks.canStartWork=async()=>allowed;
 const get=m.machines.get;m.machines.get=async(b,ctx)=>{const value=await get(b,ctx);allowed=false;return value;};
 await f.c.progress(f.build.id,pid,m.hooks);
 expect(m.calls).toEqual(['create','get','get','archive']);expect((await f.row())?.errorCode).toBe('software_subscription_required');
});

test('helper failures and digest changes never capture or rerun failed installation',async()=>{
 const f=await fixture(),m=fake();m.machines.statusHelper=async()=>({...m.verified,phase:'failed',errorCode:'software_build_install_interrupted',readyForCapture:false});
 await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'failed',errorCode:'software_build_install_interrupted'});
 expect(m.calls).not.toContain('run');expect(m.calls).not.toContain('snapshot');
});

test('snapshot observed ready retries a rolled-back result callback without new snapshot',async()=>{
 const f=await fixture(),m=fake();let first=true;
 m.hooks.onReady=async tx=>{await tx`UPDATE portable_software_builds SET error_code='test_callback' WHERE id=${f.build.id}`;if(first){first=false;throw Error('crash before commit');}};
 await f.c.progress(f.build.id,pid,m.hooks);await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'capturing',errorCode:null});
 await f.c.progress(f.build.id,pid,m.hooks);expect((await f.row())?.status).toBe('ready');
 expect(m.calls.filter(c=>c==='snapshot')).toHaveLength(1);
});

test('cleanup failure is visible and retried by observation without rebuilding or losing ready result',async()=>{
 const f=await fixture(),m=fake();const archive=m.machines.archive;let first=true;
 m.machines.archive=async(b,ctx)=>{if(first){first=false;throw Error('private failure');}return archive(b,ctx);};
 await f.c.progress(f.build.id,pid,m.hooks);await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'ready',cleanupStatus:'error'});
 await f.c.progress(f.build.id,pid,m.hooks);await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'ready',cleanupStatus:'complete'});expect(m.calls.filter(c=>c==='create')).toHaveLength(1);
});

test('two blocked builds leave leader and pool available for warm chat admission; repeated scans dedupe jobs',async()=>{
 const f=await fixture(),m=fake();
 for(let i=0;i<2;i++){
  const t=await saveTemplate(f.owner,{name:`Build ${i}`,instructions:'Use jq',avatar:{shape:1,color:2,face:3}});
  await enqueueTemplateSoftware(f.owner,crypto.randomUUID(),{templateId:t.id,expectedRevision:1,apt:[{name:'jq',version:'1.7.1'}],npm:[]});
 }
 let release!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve);
 m.machines.create=async b=>{m.calls.push('create');await blocked;return {id:`box-${b.id}`};};
 try{
  await f.c.schedule(leader,m.hooks);await f.c.schedule(leader,m.hooks);
  for(let i=0;i<100&&m.calls.length<2;i++)await Bun.sleep(10);
  expect(f.c.activeCount).toBe(2);expect(m.calls).toHaveLength(2);
  // No network call holds either the leader or a transaction connection.
  const companion=await createCompanion(f.owner,{name:'Warm',provider:'local'});
  const run=await acceptMessage(f.owner,companion.id,crypto.randomUUID(),'Still responsive');
  await claimQueuedRuns(leader);
  expect((await db`SELECT status FROM runs WHERE id=${run}`)[0].status).toBe('preparing');
 }finally{release();await idle(f.c);}
});

test('a generation changed during GET fences the stale job before helper commands',async()=>{
 const f=await fixture(),m=fake();const get=m.machines.get;
 m.machines.get=async(b,ctx)=>{const result=await get(b,ctx);await db`UPDATE portable_software_builds SET updated_at=clock_timestamp() WHERE id=${f.build.id}`;return result;};
 await f.c.progress(f.build.id,pid,m.hooks);expect(m.calls).toEqual(['create','get']);
});

test('owner retention prevents orphan builds, and a missing build never contacts the provider',async()=>{
 const f=await fixture(),m=fake();
 let rejected=false;try{await db`DELETE FROM "user" WHERE id=${f.owner}`;}catch{rejected=true;}expect(rejected).toBe(true);
 await f.c.progress(crypto.randomUUID(),pid,m.hooks);expect(m.calls).toEqual([]);
});

test('the root callback is rolled back when leadership is lost inside its transaction',async()=>{
 const f=await fixture(),m=fake();
 m.hooks.onReady=async tx=>{
  await tx`UPDATE portable_software_builds SET error_code='callback_not_committed' WHERE id=${f.build.id}`;
  await leader`SELECT pg_advisory_unlock(721440139)`;
 };
 await f.c.progress(f.build.id,pid,m.hooks);await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'capturing',errorCode:null});expect(m.calls).not.toContain('archive');
});

test('a pinned helper digest conflict is terminal before any run or snapshot',async()=>{
 const f=await fixture(),m=fake();m.machines.statusHelper=async()=>({...m.verified,requestDigest:'e'.repeat(64)});
 await f.c.progress(f.build.id,pid,m.hooks);
 expect((await f.row())?.errorCode).toBe('software_helper_digest_changed');expect(m.calls).not.toContain('run');expect(m.calls).not.toContain('snapshot');
});

test('invalid roots never become a captured result despite a self-consistent helper manifest digest',async()=>{
 const f=await fixture(),m=fake();const wrong={...manifest,apt:{roots:[],packages:[]}};
 m.machines.runHelper=async()=>({...m.verified,manifestDigest:softwareManifestDigest(wrong)});m.machines.readManifest=async()=>wrong;
 await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'failed',errorCode:'software_manifest_invalid',manifestId:null});expect(m.calls).not.toContain('snapshot');
});

test('nested adapter mutations recheck entitlement after their own read',async()=>{
 const f=await fixture(),m=fake();let allowed=true;m.hooks.canStartWork=async()=>allowed;
 m.machines.prepareHelper=async(_b,ctx)=>{allowed=false;await ctx.assertActive();m.calls.push('unsafe-write');return {requestDigest:digest};};
 await f.c.progress(f.build.id,pid,m.hooks);expect(m.calls).not.toContain('unsafe-write');
 expect((await f.row())?.errorCode).toBe('software_subscription_required');
});


test('explicit snapshot quota rejection fails immediately and cleans up without another capture',async()=>{
 const f=await fixture(),m=fake();m.machines.snapshot=async()=>{m.calls.push('snapshot');throw new BoxError('box_snapshot_limit',409);};
 await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'failed',errorCode:'software_snapshot_limit',cleanupStatus:'pending'});
 await f.c.progress(f.build.id,pid,m.hooks);
 expect(await f.row()).toMatchObject({status:'failed',cleanupStatus:'complete'});
 expect(m.calls.filter(c=>c==='snapshot')).toHaveLength(1);
 expect(m.calls).not.toContain('snapshotGet');
 expect(m.calls).not.toContain('ready');
});
