import {createHash,randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {BoxClient,BoxError} from '../../../packages/box/client';
import {config} from './config';
import {db} from './store';
import {distributionManifest,manifestDigest,publishDistribution,verifyDistribution,type DistributionBoxes,type DistributionJournal,type DistributionManifest} from '../../../scripts/lib/distribution-verification';
import {templateInstallScript,runtimeProbeScript} from '../../../scripts/lib/template-install';

/** The executor leader and image publisher are session locks; registry changes use
 * a separate transaction lock so a long publication never stalls Companion starts. */
export const EXECUTOR_LOCK_ID=721440139;
export const MANAGED_BASE_IMAGE_PUBLISH_LOCK_ID=721440142;
export const MANAGED_BASE_IMAGE_REGISTRY_LOCK_ID=721440143;
const RETRY_MS=60_000;
const CHECK_MS=60_000;

type SQLLike=any;
type ManagedJournal=DistributionJournal&{
 sourceCreateIntentAt?:string;sourceCreateRetryAt?:string;sourceCreateUnresolvedAt?:string;
 verifierCreateIntentAt?:string;verifierCreateRetryAt?:string;verifierCreateUnresolvedAt?:string;
 installIntentAt?:string;
};
type Artifact={releaseDigest:string;manifest:DistributionManifest;archive:Buffer;archiveDigest:string};
type ManagedBox=DistributionBoxes&{
 writeFile(id:string,path:string,content:string,encoding?:string):Promise<unknown>;
 deleteSnapshot(name:string):Promise<unknown>;
};
type CoordinatorOptions={database?:SQLLike;box?:ManagedBox|null;directory?:string;now?:()=>number;artifact?:()=>Promise<Artifact>;enabled?:boolean};

let defaultArtifact:Promise<Artifact>|undefined;
async function archiveDirectory(directory:string){
 const child=Bun.spawn(['tar','-czf','-','-C',directory,'.'],{stdout:'pipe',stderr:'pipe'});
 const [code,bytes,error]=await Promise.all([child.exited,new Response(child.stdout).arrayBuffer(),new Response(child.stderr).text()]);
 if(code!==0)throw Error('MANAGED_IMAGE_ARCHIVE_FAILED');
 if(!bytes.byteLength||bytes.byteLength>512*1024*1024)throw Error('MANAGED_IMAGE_ARCHIVE_INVALID');
 void error;
 return Buffer.from(bytes);
}
async function readArtifact(directory=realpathSync('dist/agent')):Promise<Artifact>{
 const manifest=await distributionManifest(directory),releaseDigest=manifestDigest(manifest),archive=await archiveDirectory(directory);
 return {releaseDigest,manifest,archive,archiveDigest:createHash('sha256').update(archive).digest('hex')};
}
export function managedBaseImageArtifact(directory?:string){
 if(directory)return readArtifact(realpathSync(directory));
 return defaultArtifact??=readArtifact();
}
export async function managedBaseImageReleaseDigest(){return (await managedBaseImageArtifact()).releaseDigest;}

function safeCode(error:unknown){
 if(error instanceof BoxError&&/^[a-z0-9_]{1,80}$/.test(error.code))return error.code;
 const value=error instanceof Error?error.message:'';
 if(/^[A-Z][A-Z0-9_]{0,79}$/.test(value))return value.toLowerCase();
 return 'managed_image_publication_failed';
}
function iso(now:()=>number){return new Date(now()).toISOString();}
function snapshotStatus(value:any){return value?.snapshot?.status??value?.namedSnapshot?.status??value?.status;}

async function readyForRelease(sql:SQLLike,releaseDigest:string){
 const [row]=await sql`SELECT snapshot_name FROM managed_base_images
   WHERE release_digest=${releaseDigest} AND status='ready' AND deleted_at IS NULL
   ORDER BY generation DESC LIMIT 1`;
 return row?.snapshot_name as string|undefined;
}

/** Resolve only the distribution shipped with this server process. An older ready
 * row can never silently become the default after a deploy. */
export async function resolveManagedBaseImage(sql:SQLLike=db):Promise<string|null>{
 let digest:string;try{digest=await managedBaseImageReleaseDigest();}catch{return null;}
 return await readyForRelease(sql,digest)??null;
}

/** Atomically pins the selected image before Box creation. Explicit template and
 * specialist snapshots are not owned by this registry and pass through unchanged. */
export async function pinManagedBaseImage(companionId:string,sql:SQLLike=db,guard:()=>Promise<void>=async()=>{}):Promise<string|null>{
 let digest:string;try{digest=await managedBaseImageReleaseDigest();}catch{return null;}
 return sql.begin(async(tx:SQLLike)=>{
  const [lock]=await tx`SELECT pg_try_advisory_xact_lock(${MANAGED_BASE_IMAGE_REGISTRY_LOCK_ID}) AS owned`;
  if(!lock?.owned)return null;
  await guard();
  const [companion]=await tx`SELECT snapshot_name,box_id,create_started_at FROM companions WHERE id=${companionId} FOR UPDATE`;
  if(!companion)return null;
  if(companion.snapshot_name){
   const [managed]=await tx`SELECT release_digest,status,delete_intent_at,deleted_at FROM managed_base_images WHERE snapshot_name=${companion.snapshot_name}`;
   if(!managed)return companion.snapshot_name;
   const usable=['ready','retired'].includes(managed.status)&&!managed.delete_intent_at&&!managed.deleted_at;
   if(usable&&(managed.release_digest===digest||companion.box_id||companion.create_started_at))return companion.snapshot_name;
   // Once an external create may have happened, its exact image reference is immutable.
   if(companion.box_id||companion.create_started_at)return null;
  }
  const selected=await readyForRelease(tx,digest);if(!selected)return null;
  await tx`UPDATE companions SET snapshot_name=${selected} WHERE id=${companionId}
    AND box_id IS NULL AND create_started_at IS NULL`;
  await guard();
  return selected;
 });
}

export async function managedBaseImageError(sql:SQLLike=db):Promise<string|null>{
 let digest:string|null=null;try{digest=await managedBaseImageReleaseDigest();}catch{}
 if(digest){
  const [row]=await sql`SELECT error_code FROM managed_base_images WHERE release_digest=${digest}
    AND error_code IS NOT NULL ORDER BY generation DESC LIMIT 1`;
  if(row?.error_code)return row.error_code;
 }
 const [state]=await sql`SELECT error_code FROM managed_base_image_state WHERE singleton=true`;
 return state?.error_code??null;
}

function creationFields(state:ManagedJournal,key:string){
 if(key===state.key)return {intent:'sourceCreateIntentAt',retry:'sourceCreateRetryAt',unresolved:'sourceCreateUnresolvedAt',target:'source'} as const;
 if(key===state.verification?.key)return {intent:'verifierCreateIntentAt',retry:'verifierCreateRetryAt',unresolved:'verifierCreateUnresolvedAt',target:'verifier'} as const;
 throw Error('MANAGED_IMAGE_CREATE_KEY_INVALID');
}

function managedProvider(raw:ManagedBox,state:ManagedJournal,save:(state:ManagedJournal)=>Promise<void>,guard:()=>Promise<void>,now:()=>number):ManagedBox{
 const effect=async<T>(operation:()=>Promise<T>)=>{await guard();return operation();};
 return {
  async create(key,template){
   const fields=creationFields(state,key),current=fields.target==='source'?state.boxId:state.verification?.boxId;
   if(current)return effect(()=>raw.get(current));
   const retry=(state as any)[fields.retry];
   if(retry&&Date.parse(retry)>now())throw new BoxError('box_start_rate_limited',429);
   if((state as any)[fields.intent]){
    (state as any)[fields.unresolved]??=iso(now);await save(state);
    throw Error('MANAGED_IMAGE_CREATE_UNRESOLVED');
   }
   delete (state as any)[fields.retry];(state as any)[fields.intent]=iso(now);await save(state);
   try{
    // save() fenced the durable intent immediately before this provider call.
    const created=await raw.create(key,template);
    if(fields.target==='source')state.boxId=created.id;else state.verification!.boxId=created.id;
    await save(state);return created;
   }catch(error){
    if(error instanceof BoxError&&error.status===429){
     delete (state as any)[fields.intent];(state as any)[fields.retry]=new Date(now()+RETRY_MS).toISOString();await save(state);throw error;
    }
    (state as any)[fields.unresolved]=iso(now);await save(state);throw Error('MANAGED_IMAGE_CREATE_UNRESOLVED');
   }
  },
  get:id=>effect(()=>raw.get(id)),async resume(id){
   if(id===state.boxId&&state.sourceArchivedAt){delete state.sourceArchivedAt;await save(state);}
   if(id===state.verification?.boxId&&state.verification.archivedAt){delete state.verification.archivedAt;await save(state);}
   return effect(()=>raw.resume(id));
  },command:(id,command,timeout)=>effect(()=>raw.command(id,command,timeout)),
  snapshot:(id,name)=>effect(()=>raw.snapshot(id,name)),getSnapshot:name=>effect(()=>raw.getSnapshot(name)),stop:id=>effect(()=>raw.stop(id)),
  writeFile:(id,path,content,encoding)=>effect(()=>raw.writeFile(id,path,content,encoding)),
  deleteSnapshot:name=>effect(()=>raw.deleteSnapshot(name)),
 };
}

async function referenced(sql:SQLLike,name:string){
 const [row]=await sql`SELECT
   EXISTS(SELECT 1 FROM companions WHERE snapshot_name=${name} AND box_id IS NULL)
   OR EXISTS(SELECT 1 FROM agent_templates WHERE snapshot_name=${name} OR prepared_disk_snapshot=${name})
   OR EXISTS(SELECT 1 FROM template_revisions WHERE snapshot_name=${name} OR prepared_disk_snapshot=${name})
   OR EXISTS(SELECT 1 FROM template_candidates WHERE snapshot_name=${name})
   OR EXISTS(SELECT 1 FROM specialist_operations WHERE snapshot_name=${name} OR source_snapshot_name=${name})
   OR EXISTS(SELECT 1 FROM portable_software_bases WHERE provider_snapshot_name=${name})
   OR EXISTS(SELECT 1 FROM portable_software_builds WHERE provider_snapshot_name=${name})
   OR EXISTS(SELECT 1 FROM portable_software_results WHERE provider_snapshot_name=${name}) AS value`;
 return !!row?.value;
}

async function cleanupOne(sql:SQLLike,box:ManagedBox,row:any,now:()=>number){
 if(row.deleted_at)return true;
 if(row.delete_intent_at){
  try{await box.getSnapshot(row.snapshot_name);await sql`UPDATE managed_base_images SET delete_intent_at=null,error_code=null,updated_at=now() WHERE id=${row.id}`;row.delete_intent_at=null;}
  catch(error){
   if(!(error instanceof BoxError&&error.status===404)){
    await sql`UPDATE managed_base_images SET retry_at=${new Date(now()+RETRY_MS)},error_code=${safeCode(error)},updated_at=now() WHERE id=${row.id}`;return false;
   }
  }
  if(row.delete_intent_at){await sql`UPDATE managed_base_images SET status='deleted',deleted_at=now(),updated_at=now() WHERE id=${row.id}`;return true;}
 }
 const marked=await sql.begin(async(tx:SQLLike)=>{
  await tx`SELECT pg_advisory_xact_lock(${MANAGED_BASE_IMAGE_REGISTRY_LOCK_ID})`;
  const [fresh]=await tx`SELECT id FROM managed_base_images WHERE id=${row.id} AND deleted_at IS NULL FOR UPDATE`;
  if(!fresh||await referenced(tx,row.snapshot_name))return false;
  await tx`UPDATE managed_base_images SET delete_intent_at=${iso(now)},updated_at=now() WHERE id=${row.id}`;return true;
 });
 if(!marked)return false;
 try{await box.deleteSnapshot(row.snapshot_name);await sql`UPDATE managed_base_images SET status='deleted',deleted_at=now(),error_code=null,updated_at=now() WHERE id=${row.id}`;return true;}
 catch(error){
  if(error instanceof BoxError&&(error.status===404)){await sql`UPDATE managed_base_images SET status='deleted',deleted_at=now(),updated_at=now() WHERE id=${row.id}`;return true;}
  if(error instanceof BoxError&&error.status===409){await sql`UPDATE managed_base_images SET delete_intent_at=null,retry_at=now()+interval '60 seconds',error_code=${safeCode(error)},updated_at=now() WHERE id=${row.id}`;return false;}
  await sql`UPDATE managed_base_images SET retry_at=${new Date(now()+RETRY_MS)},error_code='managed_image_delete_unresolved',updated_at=now() WHERE id=${row.id}`;return false;
 }
}

async function cleanupObsolete(sql:SQLLike,box:ManagedBox,now:()=>number){
 const rows=await sql`SELECT id,snapshot_name,deleted_at,delete_intent_at FROM managed_base_images WHERE
   (status IN ('retired','missing','failed') OR (status='blocked'
     AND jsonb_exists(journal,'snapshotRequestedAt') AND jsonb_exists(journal,'sourceArchivedAt')
     AND jsonb_exists(journal->'verification','boxId') AND jsonb_exists(journal->'verification','archivedAt')))
   AND deleted_at IS NULL
   AND (retry_at IS NULL OR retry_at<=now()) ORDER BY created_at`;
 let count=0;for(const row of rows)if(await cleanupOne(sql,box,row,now))count++;
 return count;
}

async function archiveOwnedBoxes(box:ManagedBox,state:ManagedJournal,save:(value:ManagedJournal)=>Promise<void>,now:()=>number){
 const entries:Array<[string|undefined,'sourceArchivedAt'|'archivedAt']>=[[state.boxId,'sourceArchivedAt'],[state.verification?.boxId,'archivedAt']];
 let complete=true;
 for(const [id,field] of entries){
  if(!id)continue;
  const container=field==='sourceArchivedAt'?state:state.verification!;
  try{
   let current=await box.get(id);if(current.state!=='archived')await box.stop(id);
   const deadline=now()+60_000;
   while(current.state!=='archived'){if(now()>=deadline)throw Error('MANAGED_IMAGE_ARCHIVE_TIMEOUT');await Bun.sleep(2_000);current=await box.get(id);}
   (container as any)[field]=iso(now);await save(state);
  }catch{complete=false;}
 }
 return complete;
}

export class ManagedBaseImageCoordinator{
 private job:Promise<void>|null=null;
 private closing=false;
 private leaderPid:number|null=null;
 private readonly database:SQLLike;
 private readonly box:ManagedBox|null;
 private readonly now:()=>number;
 private readonly artifact:()=>Promise<Artifact>;
 private readonly enabled:boolean;
 private nextAttemptAt=0;
 constructor(options:CoordinatorOptions={}){
  this.database=options.database??db;this.now=options.now??Date.now;this.artifact=options.artifact??(()=>managedBaseImageArtifact(options.directory));
  this.box=Object.hasOwn(options,'box')?options.box!:(config.boxKey?new BoxClient(config.boxKey) as unknown as ManagedBox:null);
  this.enabled=options.enabled??((config as typeof config&{managedBoxTemplate?:boolean}).managedBoxTemplate===true);
 }
 get active(){return !!this.job;}
 async schedule(leader:SQLLike){
  if(this.closing||this.job||!this.box||!this.enabled||this.now()<this.nextAttemptAt)return;
  const [identity]=await leader`SELECT pg_backend_pid() AS pid,
    EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=${EXECUTOR_LOCK_ID} AND granted) AS owned`;
  if(!identity?.owned||(this.leaderPid!==null&&this.leaderPid!==identity.pid))throw Error('Executor ownership lost');
  this.leaderPid=identity.pid;
  this.job=this.progress(identity.pid).catch(()=>{this.nextAttemptAt=this.now()+RETRY_MS;console.error('managed_base_image_progress_failed');}).finally(()=>{this.job=null;});
 }
 private async progress(leaderPid:number){
  const sql=await this.database.reserve();let locked=false;
  try{
   const [claim]=await sql`SELECT pg_try_advisory_lock(${MANAGED_BASE_IMAGE_PUBLISH_LOCK_ID}) AS owned`;if(!claim?.owned)return;locked=true;
   const guard=async()=>{const [held]=await sql`SELECT
     EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=${leaderPid} AND objid=${EXECUTOR_LOCK_ID} AND granted)
     AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=${MANAGED_BASE_IMAGE_PUBLISH_LOCK_ID} AND granted) AS owned`;
    if(this.closing||!held?.owned)throw Error('Executor ownership lost');};
   let artifact:Artifact;
   try{artifact=await this.artifact();await sql`UPDATE managed_base_image_state SET error_code=null,updated_at=now() WHERE singleton=true`;}
   catch(error){this.nextAttemptAt=this.now()+RETRY_MS;await sql`UPDATE managed_base_image_state SET error_code=${safeCode(error)},updated_at=now() WHERE singleton=true`;return;}
   const box=managedProvider(this.box!,{} as ManagedJournal,async()=>{},guard,this.now);
   const stranded=await sql`SELECT id,journal FROM managed_base_images WHERE status='blocked' AND (retry_at IS NULL OR retry_at<=now())`;
   for(const item of stranded){
    const state=item.journal as ManagedJournal;
    const save=async(value:ManagedJournal)=>{await guard();await sql`UPDATE managed_base_images SET journal=${value}::jsonb,updated_at=now() WHERE id=${item.id}`;};
    const archived=await archiveOwnedBoxes(managedProvider(this.box!,state,save,guard,this.now),state,save,this.now);
    const captured=archived&&!!state.snapshotRequestedAt&&!!state.sourceArchivedAt&&!!state.verification?.boxId&&!!state.verification.archivedAt;
    await sql`UPDATE managed_base_images SET retry_at=${captured?null:new Date(this.now()+(archived?24*3600_000:RETRY_MS))},updated_at=now() WHERE id=${item.id}`;
   }
   const [ready]=await sql`SELECT id,snapshot_name,provider_checked_at FROM managed_base_images WHERE release_digest=${artifact.releaseDigest} AND status='ready' LIMIT 1`;
   if(ready&&(!ready.provider_checked_at||this.now()-new Date(ready.provider_checked_at).getTime()>=CHECK_MS)){
    try{
     const observed=await box.getSnapshot(ready.snapshot_name),status=snapshotStatus(observed);
     if(status==='failed')await sql`UPDATE managed_base_images SET status='failed',error_code='managed_image_snapshot_failed',provider_checked_at=now(),updated_at=now() WHERE id=${ready.id}`;
     else if(status==='ready')await sql`UPDATE managed_base_images SET provider_checked_at=now(),error_code=null,updated_at=now() WHERE id=${ready.id}`;
     else if(status==='pending')await sql`UPDATE managed_base_images SET provider_checked_at=now(),updated_at=now() WHERE id=${ready.id}`;
     else throw Error('MANAGED_IMAGE_SNAPSHOT_STATUS_INVALID');
    }catch(error){if(error instanceof BoxError&&error.status===404)await sql`UPDATE managed_base_images SET status='missing',error_code='managed_image_snapshot_missing',provider_checked_at=now(),updated_at=now() WHERE id=${ready.id}`;else throw error;}
   }
   // Finish one already persisted publication from any release before considering
   // this deployment. Its archive is in PostgreSQL and is safe across restarts.
   let [row]=await sql`SELECT id,status,retry_at FROM managed_base_images WHERE status='publishing' ORDER BY created_at LIMIT 1`;
   if(row?.retry_at&&new Date(row.retry_at).getTime()>this.now())return;
   if(!row&&await readyForRelease(sql,artifact.releaseDigest)){await cleanupObsolete(sql,box,this.now);return;}
   if(!row){
    await cleanupObsolete(sql,box,this.now);
    row=await sql.begin(async(tx:SQLLike)=>{
     await tx`SELECT pg_advisory_xact_lock(${MANAGED_BASE_IMAGE_REGISTRY_LOCK_ID})`;
     const [latest]=await tx`SELECT status,retry_at FROM managed_base_images WHERE release_digest=${artifact.releaseDigest} ORDER BY generation DESC LIMIT 1 FOR UPDATE`;
     if(latest?.status==='blocked'||(latest?.retry_at&&new Date(latest.retry_at).getTime()>this.now()))return null;
     const [state]=await tx`SELECT namespace FROM managed_base_image_state WHERE singleton=true FOR UPDATE`;
     const [sequence]=await tx`SELECT COALESCE(max(generation),0)+1 AS generation FROM managed_base_images WHERE release_digest=${artifact.releaseDigest}`;
     const generation=Number(sequence.generation),namespace=String(state.namespace).replaceAll('-','').slice(0,8);
     const name=`cb-${namespace}-${artifact.releaseDigest.slice(0,20)}-g${generation}`;
     const journal:ManagedJournal={version:1,name,key:randomUUID(),startedAt:iso(this.now),manifest:artifact.manifest,manifestDigest:manifestDigest(artifact.manifest),sha256:artifact.archiveDigest};
     const [inserted]=await tx`INSERT INTO managed_base_images(id,release_digest,generation,snapshot_name,archive,journal)
       VALUES(${randomUUID()},${artifact.releaseDigest},${generation},${name},${artifact.archive},${journal}::jsonb)
       ON CONFLICT(release_digest,generation) DO NOTHING RETURNING *`;
     return inserted??(await tx`SELECT * FROM managed_base_images WHERE release_digest=${artifact.releaseDigest} ORDER BY generation DESC LIMIT 1`)[0];
    });
   }
   if(!row||row.status!=='publishing')return;
   if(!row.journal)[row]=await sql`SELECT * FROM managed_base_images WHERE id=${row.id}`;
   const state=row.journal as ManagedJournal;
   const save=async(value:ManagedJournal)=>{await guard();await sql`UPDATE managed_base_images SET journal=${value}::jsonb,updated_at=now() WHERE id=${row.id}`;};
   const provider=managedProvider(this.box!,state,save,guard,this.now);
   try{
    await publishDistribution(state,{box:provider,save,now:this.now,install:async id=>{
     if(state.installIntentAt){
      // Observe an interrupted installation rather than execute its commands twice.
      try{await verifyDistribution(provider,id,state.manifest);await provider.command(id,runtimeProbeScript);return;}
      catch{throw Error('MANAGED_IMAGE_INSTALL_UNRESOLVED');}
     }
     state.installIntentAt=iso(this.now);await save(state);
     const archive=Buffer.from(row.archive);if(createHash('sha256').update(archive).digest('hex')!==state.sha256)throw Error('DISTRIBUTION_ARCHIVE_MISMATCH');
     const directory=`/tmp/companions-${state.sha256.slice(0,16)}`;
     await provider.command(id,`mkdir -p ${directory}`);
     for(let start=0,index=0;start<archive.length;start+=3*1024*1024,index++)await provider.writeFile(id,`${directory}/part-${String(index).padStart(5,'0')}`,archive.subarray(start,start+3*1024*1024).toString('base64'),'base64');
     await provider.command(id,`cat ${directory}/part-* > ${directory}/agent.tar.gz`,60);
     await provider.command(id,templateInstallScript(directory,state.sha256),60);
     await provider.command(id,`rm -rf -- ${directory}`);
    }});
    if(!await archiveOwnedBoxes(provider,state,save,this.now))throw Error('MANAGED_IMAGE_ARCHIVE_TIMEOUT');
    await sql.begin(async(tx:SQLLike)=>{
     await guard();
     await tx`SELECT pg_advisory_xact_lock(${MANAGED_BASE_IMAGE_REGISTRY_LOCK_ID})`;
     if(row.release_digest===artifact.releaseDigest){
      await tx`UPDATE managed_base_images SET status='retired',retired_at=now(),updated_at=now() WHERE status='ready' AND id<>${row.id}`;
      await tx`UPDATE managed_base_images SET status='ready',ready_at=now(),error_code=null,retry_at=null,provider_checked_at=now(),updated_at=now() WHERE id=${row.id}`;
     }else await tx`UPDATE managed_base_images SET status='retired',retired_at=now(),error_code=null,retry_at=null,provider_checked_at=now(),updated_at=now() WHERE id=${row.id}`;
     await guard();
    });
    await cleanupObsolete(sql,provider,this.now);
   }catch(error){
    const code=safeCode(error);
    if(error instanceof BoxError&&error.code==='box_snapshot_limit'){
     // If the account has no spare slot, reclaim only obsolete managed releases.
     // The registry lock and reference check protect creations still using them.
     await sql.begin(async(tx:SQLLike)=>{
      await guard();
      await tx`SELECT pg_advisory_xact_lock(${MANAGED_BASE_IMAGE_REGISTRY_LOCK_ID})`;
      await tx`UPDATE managed_base_images SET status='retired',retired_at=now(),updated_at=now()
       WHERE status='ready' AND release_digest<>${artifact.releaseDigest}`;
      await guard();
     });
     const removed=await cleanupObsolete(sql,provider,this.now);
     await sql`UPDATE managed_base_images SET status='publishing',error_code=${removed?'box_snapshot_limit':'managed_image_snapshot_capacity_unavailable'},retry_at=${new Date(this.now()+(removed?RETRY_MS:5*RETRY_MS))},updated_at=now() WHERE id=${row.id}`;
    }else if(['managed_image_create_unresolved','managed_image_install_unresolved','distribution_content_mismatch','distribution_content_unreadable','distribution_source_not_fresh','distribution_name_already_exists','distribution_archive_mismatch'].includes(code))await sql`UPDATE managed_base_images SET status='blocked',error_code=${code},retry_at=null,updated_at=now() WHERE id=${row.id}`;
    else if(code==='distribution_capture_failed')await sql`UPDATE managed_base_images SET status='failed',error_code=${code},retry_at=${new Date(this.now()+RETRY_MS)},updated_at=now() WHERE id=${row.id}`;
    else await sql`UPDATE managed_base_images SET error_code=${code},retry_at=${new Date(this.now()+RETRY_MS)},updated_at=now() WHERE id=${row.id}`;
    await archiveOwnedBoxes(provider,state,save,this.now);
   }
  }finally{if(locked)try{await sql`SELECT pg_advisory_unlock(${MANAGED_BASE_IMAGE_PUBLISH_LOCK_ID})`;}catch{}sql.release();}
 }
 async close(){this.closing=true;if(this.job)await Promise.allSettled([this.job]);}
}
