import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readdir,open,rename,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {BoxError,type Box} from '../../packages/box/client';

export type DistributionManifest={version:1;files:Array<{path:string;size:number;sha256:string}>};
export type DistributionJournal={version:1;name:string;key:string;startedAt:string;boxId?:string;manifest:DistributionManifest;manifestDigest:string;sha256:string;sourceVerifiedFreshAt?:string;installedVerifiedAt?:string;snapshotRequestedAt?:string;snapshotRejectedAt?:string;snapshotRejectedCode?:string;contentVerifiedAt?:string;completedAt?:string;sourceArchivedAt?:string;verification?:{key:string;startedAt:string;boxId?:string;failedAt?:string;errorCode?:string;archivedAt?:string};software?:unknown};
export interface DistributionBoxes{
 create(key:string,template?:string):Promise<Box>;get(id:string):Promise<Box>;resume(id:string):Promise<unknown>;
 command(id:string,command:string,timeoutSeconds?:number):Promise<string>;snapshot(id:string,name:string):Promise<unknown>;getSnapshot(name:string):Promise<any>;stop(id:string):Promise<unknown>;
}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function validateManifest(value:unknown):DistributionManifest{
 const manifest=value as DistributionManifest;
 if(manifest?.version!==1||!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>128)throw Error('DISTRIBUTION_MANIFEST_INVALID');
 let last='';for(const file of manifest.files){
  if(!file||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(file.path)||file.path<=last||!Number.isSafeInteger(file.size)||file.size<0||file.size>512*1024*1024||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('DISTRIBUTION_MANIFEST_INVALID');last=file.path;
 }
 if(!manifest.files.some(file=>file.path==='companion-agent'))throw Error('DISTRIBUTION_MANIFEST_INVALID');
 return {version:1,files:manifest.files.map(({path,size,sha256})=>({path,size,sha256}))};
}
export function manifestDigest(value:DistributionManifest){return hash(JSON.stringify(validateManifest(value)));}
export async function distributionManifest(directory:string):Promise<DistributionManifest>{
 const files:DistributionManifest['files']=[];
 for(const path of (await readdir(directory)).sort()){
  const full=join(directory,path),stat=await lstat(full);if(!stat.isFile()||stat.isSymbolicLink())throw Error('DISTRIBUTION_NOT_FLAT');
  const digest=createHash('sha256');for await(const chunk of createReadStream(full))digest.update(chunk);
  files.push({path,size:stat.size,sha256:digest.digest('hex')});
 }
 return validateManifest({version:1,files});
}
/** Atomic journal replacement: an external effect never precedes its durable intent. */
export async function saveDistributionJournal(path:string,value:unknown){
 await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.'+randomUUID()+'.tmp';
 const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
 await rename(temporary,path);const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
}
export function distributionReady(box:Pick<Box,'state'|'setupStatus'>){
 if(box.setupStatus==='failed')throw Error('DISTRIBUTION_BOX_SETUP_FAILED');
 return ['ready','idle','running'].includes(box.state)&&(!box.setupStatus||box.setupStatus==='done');
}
export function validateDistributionJournal(value:any):asserts value is DistributionJournal{
 if(value?.version!==1||!value.manifest)throw Error('DISTRIBUTION_LEGACY_JOURNAL_UNVERIFIED');
 if(!/^[a-z0-9-]{1,60}$/.test(value.name)||typeof value.key!=='string'||!Number.isFinite(Date.parse(value.startedAt))||!/^[a-f0-9]{64}$/.test(value.sha256)||manifestDigest(value.manifest)!==value.manifestDigest)throw Error('DISTRIBUTION_JOURNAL_INVALID');
}
export function contentVerifiedJournal(value:any){
 try{
  validateDistributionJournal(value);
  const accepted=Date.parse(value.snapshotRequestedAt??''),verified=Date.parse(value.contentVerifiedAt??''),completed=Date.parse(value.completedAt??''),rejected=Date.parse(value.snapshotRejectedAt??'');
  return !!value.boxId&&!!value.verification?.boxId&&value.verification.boxId!==value.boxId&&Number.isFinite(accepted)&&Number.isFinite(verified)&&Number.isFinite(completed)&&accepted<=verified&&verified<=completed&&(!value.snapshotRejectedAt||(Number.isFinite(rejected)&&rejected<accepted));
 }catch{return false;}
}
export function distributionVerificationCommand(manifest:DistributionManifest){
 const payload=Buffer.from(JSON.stringify(validateManifest(manifest))).toString('base64');
 return `sudo -n python3 - <<'VERIFY_DISTRIBUTION'\nimport base64,hashlib,json,os,stat\nfrom pathlib import Path\nexpected=json.loads(base64.b64decode('${payload}'))\nroot=Path('/opt/companions')\nobserved=[]\nif root.is_dir() and not root.is_symlink():\n for item in expected['files']:\n  path=root/item['path']\n  try:\n   fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)\n   with os.fdopen(fd,'rb') as file:\n    metadata=os.fstat(file.fileno())\n    if not stat.S_ISREG(metadata.st_mode): continue\n    digest=hashlib.sha256()\n    for chunk in iter(lambda:file.read(1024*1024),b''): digest.update(chunk)\n    observed.append({'path':item['path'],'size':metadata.st_size,'sha256':digest.hexdigest()})\n  except OSError: pass\nprint(json.dumps({'version':1,'files':observed}))\nVERIFY_DISTRIBUTION`;
}
export async function verifyDistribution(box:DistributionBoxes,id:string,manifest:DistributionManifest){
 let observed:unknown;try{const output=await box.command(id,distributionVerificationCommand(manifest),60);if(output.length>64*1024)throw Error();observed=JSON.parse(output);}catch(error){if(error instanceof BoxError&&(error.code==='box_unreachable'||error.status>=500))throw error;throw Error('DISTRIBUTION_CONTENT_UNREADABLE');}
 try{if(manifestDigest(observed as DistributionManifest)!==manifestDigest(manifest))throw Error();}catch{throw Error('DISTRIBUTION_CONTENT_MISMATCH');}
}
/** Operator-only publication. A named capture is reconciled, never submitted twice. */
export async function publishDistribution(state:DistributionJournal,deps:{box:DistributionBoxes;save:(state:DistributionJournal)=>Promise<void>;install:(id:string)=>Promise<void>;now?:()=>number;sleep?:(ms:number)=>Promise<void>;timeoutMs?:number}){
 validateDistributionJournal(state);const {box,save}=deps,now=deps.now??Date.now,sleep=deps.sleep??(ms=>Bun.sleep(ms));
 const timestamp=()=>new Date(now()).toISOString();
 async function wait(check:()=>Promise<boolean>){const deadline=now()+(deps.timeoutMs??600_000);while(!await check()){if(now()>=deadline)throw Error('DISTRIBUTION_PROVIDER_TIMEOUT');await sleep(2000);}}
 const verified=async(id:string)=>wait(async()=>{try{await verifyDistribution(box,id,state.manifest);return true;}catch(error){if(error instanceof BoxError&&(error.code==='box_unreachable'||error.status>=500))return false;throw error;}});
 const creationWindow=(started:string)=>{const age=now()-Date.parse(started);if(!Number.isFinite(age)||age<0||age>=23*3600_000)throw Error('DISTRIBUTION_CREATION_UNRESOLVED');};
 const ready=async(id:string)=>{if((await box.get(id)).state==='archived')await box.resume(id);await wait(async()=>distributionReady(await box.get(id)));};
 if(!state.snapshotRequestedAt&&!state.completedAt){
  try{await box.getSnapshot(state.name);throw Error('DISTRIBUTION_NAME_ALREADY_EXISTS');}catch(error){if(!(error instanceof BoxError&&error.status===404))throw error;}
  if(!state.boxId){creationWindow(state.startedAt);const created=await box.create(state.key);state.boxId=created.id;await save(state);}
  await ready(state.boxId);
  if(!state.sourceVerifiedFreshAt){
   const fresh=await box.command(state.boxId,'if [ ! -e /opt/companions ] && [ ! -L /opt/companions ]; then printf fresh; else printf existing; fi');
   if(fresh!=='fresh')throw Error('DISTRIBUTION_SOURCE_NOT_FRESH');state.sourceVerifiedFreshAt=timestamp();await save(state);
  }
  await deps.install(state.boxId);
  // Flush before capture. This is durability hygiene, not proof that a provider
  // correctly captures directory exchanges: only the independent restore proves that.
  await box.command(state.boxId,'sync',60);await verified(state.boxId);
  state.installedVerifiedAt=timestamp();await save(state);
  state.snapshotRequestedAt=timestamp();await save(state);
  try{await box.snapshot(state.boxId,state.name);}catch(error){
   if(error instanceof BoxError&&error.code==='box_snapshot_limit'){state.snapshotRejectedAt=timestamp();state.snapshotRejectedCode=error.code;delete state.snapshotRequestedAt;await save(state);}throw error;
  }
 }
 if(!state.snapshotRequestedAt||!state.boxId)throw Error('DISTRIBUTION_JOURNAL_INVALID');
 await wait(async()=>{const result=await box.getSnapshot(state.name),status=result.snapshot?.status??result.namedSnapshot?.status??result.status;if(status==='failed')throw Error('DISTRIBUTION_CAPTURE_FAILED');return status==='ready';});
 if(!contentVerifiedJournal(state)){
  state.verification??={key:randomUUID(),startedAt:timestamp()};await save(state);
  if(!state.verification.boxId){creationWindow(state.verification.startedAt);const created=await box.create(state.verification.key,state.name);if(created.id===state.boxId)throw Error('DISTRIBUTION_VERIFIER_NOT_INDEPENDENT');state.verification.boxId=created.id;await save(state);}
  await ready(state.verification.boxId);
  try{await verified(state.verification.boxId);}catch(error){state.verification.failedAt=timestamp();state.verification.errorCode=error instanceof Error&&error.message==='DISTRIBUTION_CONTENT_MISMATCH'?'DISTRIBUTION_CONTENT_MISMATCH':'DISTRIBUTION_CONTENT_UNREADABLE';await save(state);throw error;}
  delete state.verification.failedAt;delete state.verification.errorCode;
  state.contentVerifiedAt=timestamp();state.completedAt=timestamp();await save(state);
 }
 // Cleanup is separately checkpointed. A cleanup failure does not erase the proof,
 // and retrying it never builds, creates a second verifier or resubmits the capture.
 for(const [id,archived] of [[state.boxId,state.sourceArchivedAt],[state.verification!.boxId!,state.verification!.archivedAt]] as const){
  if(archived)continue;if((await box.get(id)).state!=='archived')await box.stop(id);await wait(async()=>(await box.get(id)).state==='archived');
  if(id===state.boxId)state.sourceArchivedAt=timestamp();else state.verification!.archivedAt=timestamp();await save(state);
 }
 return state;
}
