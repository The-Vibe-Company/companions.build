import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,mkdir,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BoxError,type Box} from '../../packages/box/client';
import {contentVerifiedJournal,distributionManifest,distributionReady,manifestDigest,publishDistribution,saveDistributionJournal,type DistributionBoxes,type DistributionJournal,type DistributionManifest} from './distribution-verification';
const manifest:DistributionManifest={version:1,files:['companion-agent','helper.py','resource.wasm'].map(path=>({path,size:3,sha256:createHash('sha256').update('new').digest('hex')}))};
function state():DistributionJournal{return {version:1,name:'fixture-v12',key:crypto.randomUUID(),startedAt:'2026-09-07T10:00:00.000Z',manifest,manifestDigest:manifestDigest(manifest),sha256:'a'.repeat(64)};}
function fixture(){
 let time=Date.parse('2026-09-07T10:00:01.000Z'),durable=state(),snapshot=false,installed=false,restoreStale=false,installStale=false,loseCreate=false,loseSnapshot=false,failArchive=false;
 const machines=new Map<string,Box>(),keys=new Map<string,string>(),events:string[]=[],checkpoints:DistributionJournal[]=[];
 const box:DistributionBoxes={
  async create(key,template){
   events.push('create '+key+' '+(template??'fresh'));
   const checkpoint=template?durable.verification?.key:durable.key;expect(checkpoint).toBe(key);
   let id=keys.get(key);if(!id){id=template?'verify-box':'source-box';keys.set(key,id);machines.set(id,{id,state:'ready',setupStatus:'done'});}
   if(template&&loseCreate){loseCreate=false;throw new BoxError('box_unreachable');}
   return {...machines.get(id)!};
  },
  async get(id){return {...machines.get(id)!};},async resume(id){events.push('resume '+id);machines.get(id)!.state='ready';},
  async command(id,command){if(command.startsWith('if [ ! -e /opt/companions ]')){events.push('check fresh '+id);return 'fresh';}if(command==='sync'){events.push('sync '+id);return '';}events.push('verify '+id);expect(command).toContain('/opt/companions');const stale=id==='source-box'?installStale:restoreStale;return JSON.stringify(stale?{...manifest,files:manifest.files.map(file=>({...file,sha256:'b'.repeat(64)}))}:manifest);},
  async snapshot(id,name){events.push('capture '+name);expect(durable.snapshotRequestedAt).toBeDefined();expect(durable.installedVerifiedAt).toBeDefined();expect(installed).toBe(true);snapshot=true;if(loseSnapshot){loseSnapshot=false;throw new BoxError('box_unreachable');}},
  async getSnapshot(){events.push('observe capture');if(!snapshot)throw new BoxError('box_not_found',404);return {snapshot:{status:'ready'}};},
  async stop(id){events.push('archive '+id);if(failArchive){failArchive=false;throw new BoxError('box_unreachable');}machines.get(id)!.state='archived';},
 };
 return {box,events,checkpoints,machines,keys,get durable(){return structuredClone(durable);},set restoreStale(value:boolean){restoreStale=value;},set installStale(value:boolean){installStale=value;},set loseCreate(value:boolean){loseCreate=value;},set loseSnapshot(value:boolean){loseSnapshot=value;},set failArchive(value:boolean){failArchive=value;},
  async save(value:DistributionJournal){durable=structuredClone(value);checkpoints.push(structuredClone(value));},
  async install(id:string){events.push('install '+id);expect(durable.manifestDigest).toBe(manifestDigest(manifest));installed=true;},
  now:()=>time,sleep:async(ms:number)=>{time+=ms;},advance(ms:number){time+=ms;},
 };
}

test('a fresh source and independent restored Box must both match every pinned file before publication',async()=>{
 const f=fixture(),s=f.durable;await publishDistribution(s,f);
 expect(contentVerifiedJournal(s)).toBe(true);expect(s.verification!.boxId).not.toBe(s.boxId);expect(s.sourceArchivedAt).toBeDefined();expect(s.verification!.archivedAt).toBeDefined();
 expect(f.events.filter(e=>e.startsWith('create '))).toHaveLength(2);expect(f.events.find(e=>e.startsWith('create '))).toEndWith('fresh');
 expect(f.events.indexOf('verify source-box')).toBeLessThan(f.events.indexOf('capture fixture-v12'));
 expect(f.events.indexOf('verify verify-box')).toBeLessThan(f.events.indexOf('archive source-box'));
 const count=f.events.length;await publishDistribution(f.durable,f);expect(f.events.slice(count)).toEqual(['observe capture']);
});

test('stale installed bytes block snapshot submission; stale restored bytes block completed/content proof',async()=>{
 for(const phase of ['install','restore'] as const){
  const f=fixture();if(phase==='install')f.installStale=true;else f.restoreStale=true;
  await expect(publishDistribution(f.durable,f)).rejects.toThrow('DISTRIBUTION_CONTENT_MISMATCH');
  expect(f.durable.completedAt).toBeUndefined();expect(f.durable.contentVerifiedAt).toBeUndefined();expect(contentVerifiedJournal(f.durable)).toBe(false);
  if(phase==='install')expect(f.events.some(e=>e.startsWith('capture '))).toBe(false);
  else{
   expect(f.durable.verification!.errorCode).toBe('DISTRIBUTION_CONTENT_MISMATCH');const firstEvents=f.events.length;
   await expect(publishDistribution(f.durable,f)).rejects.toThrow('DISTRIBUTION_CONTENT_MISMATCH');
   expect(f.events.slice(firstEvents).some(e=>e.startsWith('capture ')||e.startsWith('install ')||e.startsWith('create '))).toBe(false);
  }
 }
});

test('a lost verifier create response retries only its persisted key and refuses an expired ambiguity',async()=>{
 const f=fixture();f.loseCreate=true;await expect(publishDistribution(f.durable,f)).rejects.toThrow('box_unreachable');
 const captured=f.durable.verification!.key;expect(f.durable.verification!.boxId).toBeUndefined();await publishDistribution(f.durable,f);
 expect(f.events.filter(e=>e.startsWith('create '+captured))).toHaveLength(2);expect(f.keys.size).toBe(2);expect(contentVerifiedJournal(f.durable)).toBe(true);
 const expired=fixture();expired.loseCreate=true;await expect(publishDistribution(expired.durable,expired)).rejects.toThrow();expired.advance(23*3600_000);
 const before=expired.events.filter(e=>e.startsWith('create ')).length;await expect(publishDistribution(expired.durable,expired)).rejects.toThrow('DISTRIBUTION_CREATION_UNRESOLVED');expect(expired.events.filter(e=>e.startsWith('create '))).toHaveLength(before);
});

test('an accepted but ambiguous snapshot is observed without reinstalling or repeating its POST',async()=>{
 const f=fixture();f.loseSnapshot=true;await expect(publishDistribution(f.durable,f)).rejects.toThrow('box_unreachable');expect(f.durable.snapshotRequestedAt).toBeDefined();
 const before=f.events.length;await publishDistribution(f.durable,f);expect(contentVerifiedJournal(f.durable)).toBe(true);
 expect(f.events.slice(before).some(e=>e.startsWith('capture ')||e.startsWith('install '))).toBe(false);
});

test('cleanup failure preserves content proof and retries only archival on the recorded Boxes',async()=>{
 const f=fixture();f.failArchive=true;await expect(publishDistribution(f.durable,f)).rejects.toThrow('box_unreachable');expect(contentVerifiedJournal(f.durable)).toBe(true);
 const verifier=f.durable.verification!.boxId,before=f.events.length;await publishDistribution(f.durable,f);expect(f.durable.verification!.boxId).toBe(verifier);
 expect(f.events.slice(before).some(e=>e.startsWith('create ')||e.startsWith('install ')||e.startsWith('verify ')||e.startsWith('capture '))).toBe(false);
});

test('legacy completed journals without a pinned manifest never rebuild or claim publishability',async()=>{
 const f=fixture(),legacy={key:'old-key',boxId:'reused-source',completedAt:'2026-09-07T10:00:00.000Z',snapshotRequestedAt:'2026-09-07T09:00:00.000Z'};
 expect(contentVerifiedJournal(legacy)).toBe(false);await expect(publishDistribution(legacy as any,f)).rejects.toThrow('DISTRIBUTION_LEGACY_JOURNAL_UNVERIFIED');expect(f.events).toEqual([]);
});

test('ready/setup guard delays installation through pending/running, rejects failed, and accepts absent setup',async()=>{
 expect(distributionReady({state:'ready'})).toBe(true);expect(distributionReady({state:'running',setupStatus:'done'})).toBe(true);
 expect(distributionReady({state:'ready',setupStatus:'pending'})).toBe(false);expect(distributionReady({state:'idle',setupStatus:'running'})).toBe(false);expect(()=>distributionReady({state:'ready',setupStatus:'failed'})).toThrow('DISTRIBUTION_BOX_SETUP_FAILED');
 const f=fixture(),get=f.box.get.bind(f.box);let reads=0;
 f.box.get=async id=>{const value=await get(id);if(id==='source-box'&&++reads<4){expect(f.events).not.toContain('install source-box');return {...value,setupStatus:reads<3?'pending':'running'};}return value;};
 await publishDistribution(f.durable,f);expect(contentVerifiedJournal(f.durable)).toBe(true);expect(reads).toBeGreaterThanOrEqual(4);
});

test('manifest covers every flat binary/helper/resource and journal replacement persists it; links fail closed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'companions-manifest-'));
 try{
  for(const name of ['resource.wasm','companion-agent','new-helper.py'])await writeFile(join(root,name),name);
  const m=await distributionManifest(root);expect(m.files.map(f=>f.path)).toEqual(['companion-agent','new-helper.py','resource.wasm']);
  const path=join(root,'journal','release.json');await saveDistributionJournal(path,{manifest:m,digest:manifestDigest(m)});expect(JSON.parse(await readFile(path,'utf8')).digest).toBe(manifestDigest(m));
  await rm(join(root,'journal'),{recursive:true});await symlink('/etc/passwd',join(root,'unsafe'));await expect(distributionManifest(root)).rejects.toThrow('DISTRIBUTION_NOT_FLAT');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('transient restored-file transport errors retry only read-only verification within a deadline',async()=>{
 const f=fixture(),command=f.box.command.bind(f.box);let attempts=0;
 f.box.command=async(id,script,timeout)=>{if(id==='verify-box'&&++attempts<=2)throw new BoxError('box_request_failed',502);return command(id,script,timeout);};
 await publishDistribution(f.durable,f);expect(attempts).toBe(3);expect(contentVerifiedJournal(f.durable)).toBe(true);expect(f.events.filter(e=>e.startsWith('create '))).toHaveLength(2);expect(f.events.filter(e=>e.startsWith('install '))).toHaveLength(1);
 const stalled=fixture(),read=stalled.box.command.bind(stalled.box);
 stalled.box.command=async(id,script,timeout)=>{if(id==='verify-box')throw new BoxError('box_request_failed',502);return read(id,script,timeout);};
 await expect(publishDistribution(stalled.durable,{...stalled,timeoutMs:3000})).rejects.toThrow('DISTRIBUTION_PROVIDER_TIMEOUT');expect(contentVerifiedJournal(stalled.durable)).toBe(false);
});

test('an existing distribution on the purported fresh source is refused before installation or capture',async()=>{
 const f=fixture(),command=f.box.command.bind(f.box);
 f.box.command=async(id,script,timeout)=>script.startsWith('if [ ! -e /opt/companions ]')?'existing':command(id,script,timeout);
 await expect(publishDistribution(f.durable,f)).rejects.toThrow('DISTRIBUTION_SOURCE_NOT_FRESH');
 expect(f.events.some(e=>e.startsWith('install ')||e.startsWith('capture '))).toBe(false);expect(f.durable.sourceVerifiedFreshAt).toBeUndefined();
});
