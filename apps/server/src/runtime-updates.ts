import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {config,decrypt} from './config';
import {agentRequest,ExecutionStopped} from './machines';
import {BoxClient} from '../../../packages/box/client';
import {runtimeRelease,sha256,type RuntimeRelease} from '../../../packages/box/runtime-release';

type FileIdentity={path:string;size:number;sha256:string};
export type UpdateRelease=RuntimeRelease&{bundle:FileIdentity[]};
type Observation={state:string;code?:string;digest?:string;installedReleaseId?:string};
export interface RuntimeUpdateMachine{
 release:UpdateRelease;
 installerHash:string;
 health(companion:any):Promise<any>;
 awake?(companion:any):Promise<boolean>;
 stage(job:any,guard:()=>Promise<void>):Promise<Observation>;
 apply(job:any,guard:()=>Promise<void>):Promise<Observation>;
 inspect(job:any,action:'status'|'reconcile'|'rollback',guard:()=>Promise<void>):Promise<Observation>;
 drain(companion:any):Promise<void>;
 undrain(companion:any):Promise<void>;
}
/** Verification and execution share one immutable in-memory buffer inside the privileged process. */
export const verifiedInstallerBootstrap=`import hashlib,json,os,stat,sys
path,expected=sys.argv[1:3]
sys.argv=[path,*sys.argv[3:]]
try:
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,"rb") as source:
  if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise ValueError()
  payload=source.read(1024*1024)
 if hashlib.sha256(payload).hexdigest()!=expected: raise ValueError()
except (OSError,ValueError):
 print(json.dumps({"state":"failed","code":"INSTALLER_CHECKSUM_MISMATCH"}))
 raise SystemExit(1)
exec(compile(payload,path,"exec"),{"__name__":"__main__","__file__":path})`;
function shellQuote(value:string){return "'"+value.replaceAll("'","'\\''")+"'";}
let cached:RuntimeUpdateMachine|null|undefined;
export function runtimeUpdateMachine():RuntimeUpdateMachine|null{
 if(cached!==undefined)return cached;
 if(!config.boxKey)return cached=null;
 const directory=resolve('dist/agent'),release=runtimeRelease(directory);
 const manifest=readFileSync(`${directory}/runtime-release.json`);
 if(JSON.stringify(JSON.parse(manifest.toString()))!==JSON.stringify(release))throw Error('RUNTIME_RELEASE_INVALID');
 const installer=readFileSync(new URL('../../../packages/box/linux/update-runtime.py',import.meta.url));
 const bundle=[...release.files,{path:'runtime-release.json',size:manifest.length,sha256:sha256(manifest)}];
 const box=new BoxClient(config.boxKey);
 function location(job:any){
  if(!/^[a-f0-9-]{36}$/.test(job.id)||!/^bx_[a-zA-Z0-9_-]+$/.test(job.box_id)||!/^[a-f0-9]{64}$/.test(job.installer_sha256))throw Error('RUNTIME_UPDATE_IDENTITY_INVALID');
  return `/tmp/companions-runtime-${job.id}`;
 }
 async function invoke(job:any,action:string,guard:()=>Promise<void>,args=''){
  const path=location(job);await guard();
  // The wrapper preserves the installer's fixed JSON result for deferred/failure exits.
  const command=`(sudo -n python3 -I -c ${shellQuote(verifiedInstallerBootstrap)} ${path}/update-runtime.py ${job.installer_sha256} ${action} ${args}; true)`;
  const raw=await box.command(job.box_id,command,120);
  try{
   const result=JSON.parse(raw.trim());
   if(typeof result.state!=='string'||result.code!==undefined&&!/^[A-Z_]{1,80}$/.test(result.code))throw Error();
   return result as Observation;
  }catch{throw Error('RUNTIME_UPDATE_INVALID_RESULT');}
 }
 const tokenRequest=(c:any,path:string,method='GET')=>agentRequest(decrypt(c.endpoint_secret),decrypt(c.agent_secret),path,method);
 cached={release:{...release,bundle},installerHash:sha256(installer),
  health:c=>tokenRequest(c,'/health'),
  async awake(c){const state=await box.get(c.box_id);return ['running','idle','ready'].includes(state.state)&&(!state.archiveAfter||Date.parse(state.archiveAfter)>Date.now()+10*60_000);},
  async drain(c){await tokenRequest(c,'/maintenance','POST');},
  async undrain(c){await tokenRequest(c,'/maintenance','DELETE');},
  async stage(job,guard){
   const state=await box.get(job.box_id);if(!['running','idle','ready'].includes(state.state))return {state:'deferred',code:'MACHINE_NOT_RUNNING'};
   if(job.target_version!==release.id||job.installer_sha256!==sha256(installer))return {state:'deferred',code:'RELEASE_SUPERSEDED'};
   const path=location(job);await guard();await box.command(job.box_id,`mkdir -p ${path} ${path}-parts && chmod 700 ${path} ${path}-parts`);
   await guard();await box.writeFile(job.box_id,`${path}/update-runtime.py`,installer.toString('utf8'));
   const probe=await invoke(job,'probe',guard);
   if(probe.code!=='OK')return {state:'deferred',code:probe.code??'UNSAFE_RUNTIME'};
   for(const file of bundle){
    const bytes=readFileSync(`${directory}/${file.path}`);
    if(sha256(bytes)!==file.sha256)throw Error('RUNTIME_RELEASE_CHANGED');
    const chunks=[];
    for(let offset=0,index=0;offset<bytes.length;offset+=3*1024*1024,index++){
     const chunk=`${path}-parts/${file.path}.part-${index}`;chunks.push(chunk);await guard();
     await box.writeFile(job.box_id,chunk,bytes.subarray(offset,offset+3*1024*1024).toString('base64'),'base64');
    }
    await guard();await box.command(job.box_id,`cat ${chunks.join(' ')} > ${path}/${file.path} && printf '%s  %s\\n' ${file.sha256} ${path}/${file.path} | sha256sum -c - >/dev/null`);
   }
   return {state:'staged'};
  },
  async apply(job,guard){
   const files=job.manifest.bundle as FileIdentity[];
   const names={'companion-agent':'companion-agent','photon_rs_bg.wasm':'photon-rs-bg-wasm','package.json':'package-json','runtime-release.json':'manifest'} as Record<string,string>;
   const args=files.map(f=>{if(!names[f.path]||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('RUNTIME_RELEASE_INVALID');return `--${names[f.path]}-sha256 ${f.sha256}`;}).join(' ');
   return invoke(job,'apply',guard,`--update-id ${job.id} --staging-dir ${location(job)} ${args}`);
  },
  inspect:(job,action,guard)=>invoke(job,action,guard,`--update-id ${job.id}`),
 };
 return cached;
}
export function idleAgent(health:any):boolean{
 return health?.ready===true&&health.maintenanceReady!==false&&health.activeRunId===null&&health.activeRuns?.main===null&&health.activeRuns?.background===null&&Array.isArray(health.parkedRuns)&&health.parkedRuns.length===0;
}
/** Runs inside the existing per-Companion lifecycle job. SQL fences dispatch before any upload.
 * An old executor must be stopped during rollout; no update replaces or resumes a Box. */
export async function progressRuntimeUpdate(sql:any,companionId:string,assertLeader:()=>Promise<void>,machine:RuntimeUpdateMachine|null=runtimeUpdateMachine(),clock:()=>number=Date.now):Promise<boolean>{
 if(!machine)return false;
 await assertLeader();
 let [job]=await sql`SELECT * FROM runtime_updates WHERE companion_id=${companionId} AND finished_at IS NULL`;
 let [companion]=await sql`SELECT * FROM companions WHERE id=${companionId}`;
 if(!companion)return false;
 if(job&&companion.runtime_update_checked_at&&clock()-new Date(companion.runtime_update_checked_at).getTime()<10_000)return true;
 if(!job){
  if(companion.provider!=='box'||!companion.box_id||companion.status!=='ready'||!companion.endpoint_secret||companion.archived_at||companion.retired_at||companion.archive_requested_at||companion.prepare_requested)return false;
  if(companion.runtime_update_target===machine.release.id&&(companion.runtime_update_status==='current'||companion.runtime_update_status==='failed'||companion.runtime_update_checked_at&&clock()-new Date(companion.runtime_update_checked_at).getTime()<300_000))return false;
  job=await sql.begin(async(tx:any)=>{
   await assertLeader();
   // Serialize update admission with run admission, and limit rollout to one Box at a time.
   const [lock]=await tx`SELECT pg_try_advisory_xact_lock(721440144) AS owned`;if(!lock.owned)return null;
   if((await tx`SELECT id FROM runtime_updates WHERE finished_at IS NULL LIMIT 1`).length)return null;
   const [c]=await tx`SELECT * FROM companions WHERE id=${companionId} FOR UPDATE`;
   if(!c||c.retired_at||c.archive_requested_at||c.prepare_requested||c.archived_at||c.box_id!==companion.box_id)return null;
   const [activity]=await tx`SELECT
    EXISTS(SELECT 1 FROM runs WHERE companion_id=${companionId} AND status IN ('preparing','running','needs_input'))
    OR EXISTS(SELECT 1 FROM machine_admission_requests WHERE companion_id=${companionId} AND state IN ('queued','cancelling')) AS busy`;
   if(activity.busy||c.desktop_taken||c.desktop_paused_at){
    await tx`UPDATE companions SET runtime_update_target=${machine.release.id},runtime_update_status='deferred',runtime_update_error='AGENT_BUSY',runtime_update_checked_at=now() WHERE id=${companionId}`;return null;
   }
   const [created]=await tx`INSERT INTO runtime_updates(id,companion_id,box_id,target_version,manifest,installer_sha256,state)
    VALUES(${crypto.randomUUID()},${companionId},${c.box_id},${machine.release.id},${machine.release},${machine.installerHash},'staging') RETURNING *`;
   await tx`UPDATE companions SET runtime_update_target=${machine.release.id},runtime_update_status='updating',runtime_update_error=null,runtime_update_checked_at=now() WHERE id=${companionId}`;
   return created;
  });
  if(!job)return false;
 }
 async function guard(){
  await assertLeader();
  const [c]=await sql`SELECT box_id,runtime_update_status FROM companions WHERE id=${companionId}`;
  if(c?.box_id!==job.box_id||!['updating','blocked'].includes(c.runtime_update_status))throw new ExecutionStopped('Runtime update authority changed');
 }
 async function phase(state:string){await guard();await sql`UPDATE runtime_updates SET state=${state} WHERE id=${job.id} AND finished_at IS NULL`;job.state=state;}
 async function finish(state:'succeeded'|'deferred'|'failed',code:string,version:string|null=null){
  await guard();
  // Reopen the legacy/new daemon only after its current identity and health are observed.
  if(state!=='succeeded'&&job.state!=='staging'){
   const health=await machine!.health(companion);
   if(!health?.ready||!idleAgent(health))throw Error('RUNTIME_RECOVERY_UNCONFIRMED');
   if(health?.maintenanceSupported)await machine!.undrain(companion);
   version=health?.runtimeVersion??version;
  }
  await sql.begin(async(tx:any)=>{
   await guard();
   await tx`UPDATE runtime_updates SET state=${state},error=${state==='succeeded'?null:code},finished_at=now() WHERE id=${job.id}`;
   await tx`UPDATE companions SET runtime_version=COALESCE(${version},runtime_version),runtime_update_status=${state==='succeeded'?'current':state},runtime_update_error=${state==='succeeded'?null:code},runtime_update_checked_at=now() WHERE id=${companionId}`;
  });
 }
 try{
  await guard();
  await sql`UPDATE companions SET runtime_update_checked_at=now() WHERE id=${companionId}`;
  if(job.state==='staging'){
   if(machine.awake&&!await machine.awake(companion)){await finish('deferred','MACHINE_NOT_RUNNING');return true;}
   const health=await machine.health(companion);
   if(health?.runtimeVersion===job.target_version&&health.ready){if(health.maintenanceSupported)await machine.undrain(companion);await finish('succeeded','OK',job.target_version);return true;}
   if(!idleAgent(health)){await finish('deferred','AGENT_BUSY');return true;}
   const staged=await machine.stage(job,guard);
   if(staged.state==='deferred'){await finish('deferred',staged.code??'UNSAFE_RUNTIME');return true;}
   if(!idleAgent(await machine.health(companion)))throw Error('RUNTIME_AGENT_NOT_IDLE');
   await phase('draining');
   await install();
  }else if(job.state==='draining'){
   await install();
  }else{
   const result=await machine.inspect(job,'status',guard);
   if(result.state==='pending'||result.state==='failed')await accept(await machine.inspect(job,'reconcile',guard));
   else await accept(result);
  }
 }catch(error){
  if(error instanceof ExecutionStopped)throw error;
  if(job.state==='staging'){await finish('deferred','UPDATE_UNAVAILABLE');return true;}
  // A transport timeout is not permission to replay installation or release queued prompts.
  await guard();
  await sql`UPDATE companions SET runtime_update_status='blocked',runtime_update_error='RECOVERY_REQUIRED',runtime_update_checked_at=now() WHERE id=${companionId}`;
 }
 return true;
 async function install(){
  const health=await machine!.health(companion);
  if(!idleAgent(health))throw Error('RUNTIME_AGENT_NOT_IDLE');
  if(health.maintenanceSupported)await machine!.drain(companion);
  await phase('applying');
  await accept(await machine!.apply(job,guard));
 }
 async function accept(result:Observation){
  if(result.code==='UPDATE_IN_PROGRESS')return;
  if(result.state==='succeeded'){
   await phase('verifying');
   let health:any;
   for(let i=0;i<5;i++){try{health=await machine!.health(companion);if(health?.ready&&health.runtimeVersion===job.target_version)break;}catch{}await Bun.sleep(1000);}
   if(health?.ready&&health.runtimeVersion===job.target_version){
    if(health.maintenanceSupported)await machine!.undrain(companion);
    await finish('succeeded','OK',job.target_version);
   }else await accept(await machine!.inspect(job,'rollback',guard));
  }else if(result.state==='deferred')await finish('deferred',result.code??'UNSAFE_RUNTIME');
  else if(result.state==='rolled_back')await finish('failed','ROLLED_BACK');
  else if(result.state==='not_started')throw Error('RUNTIME_INSTALLATION_UNCONFIRMED');
  else throw Error('RUNTIME_RECOVERY_UNCONFIRMED');
 }
}
