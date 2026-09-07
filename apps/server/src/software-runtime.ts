import type { ReservedSQL } from 'bun';
import { z } from 'zod';
import { BoxError } from '../../../packages/box/client';
import { db } from './store';
import { ownerMayStartWork } from './lifecycle';
import { recordResolvedSoftwareManifestInTransaction, SoftwareConflict, type SoftwareRoots, type SoftwareBaseRegistration } from './software';
import { softwareManifestDigest, validatePortableSoftwareManifest } from '../../../packages/control/software';

/** Only immutable, server-owned identifiers cross this adapter boundary. No tenant scripts. */
export interface SoftwareMachineBuild {
 id:string; ownerId:string; templateId:string; createKey:string; boxId:string|null;
 snapshotName:string; roots:SoftwareRoots; helperRequestDigest:string|null;
 base:SoftwareBaseRegistration;
}
export interface SoftwareEffectContext { signal:AbortSignal; assertActive():Promise<void> }
export interface SoftwareBuildMachines {
 create(build:SoftwareMachineBuild,context:SoftwareEffectContext):Promise<{id:string}>;
 get(build:SoftwareMachineBuild,context:SoftwareEffectContext):Promise<{state:'ready'|'starting'|'archived'|'missing'}>;
 resume(build:SoftwareMachineBuild,context:SoftwareEffectContext):Promise<void>;
 prepareHelper(build:SoftwareMachineBuild,context:SoftwareEffectContext):Promise<{requestDigest:string}>;
 runHelper(build:SoftwareMachineBuild,context:SoftwareEffectContext):Promise<unknown>;
 statusHelper(build:SoftwareMachineBuild,context:SoftwareEffectContext):Promise<unknown>;
 readManifest(build:SoftwareMachineBuild,context:SoftwareEffectContext):Promise<unknown>;
 snapshot(build:SoftwareMachineBuild,context:SoftwareEffectContext):Promise<void>;
 getSnapshot(build:SoftwareMachineBuild,context:SoftwareEffectContext):Promise<{state:'ready'|'pending'|'missing'|'failed'}>;
 archive(build:SoftwareMachineBuild,context:SoftwareEffectContext):Promise<void>;
}
export interface SoftwareRuntimeHooks {
 machines:SoftwareBuildMachines;
 canStartWork?(ownerId:string):Promise<boolean>;
 /** DB-only callback: publish immutable result/grant in the same fenced ready transaction. */
 onReady(tx:any,build:SoftwareMachineBuild):Promise<unknown>;
}
const helperSchema=z.object({phase:z.enum(['pending','resolving','resolved','installing','verifying','verified','failed']),
 requestDigest:z.string().regex(/^[a-f0-9]{64}$/),manifestDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
 errorCode:z.string().nullable(),readyForCapture:z.boolean()});
class Stopped extends Error {}
class BuildFailure extends Error { constructor(readonly code:string){super(code);} }
const terminal=(row:any)=>row.status==='ready'||row.status==='failed';
const deadlineMs=30*60_000;
function projection(row:any):SoftwareMachineBuild {
 return {id:row.id,ownerId:row.owner_id,templateId:row.template_id,createKey:row.create_key,boxId:row.box_id,
 snapshotName:row.provider_snapshot_name,roots:row.requested_roots,helperRequestDigest:row.helper_request_digest,
 base:{id:row.base_id,providerSnapshotName:row.base_snapshot,distributionDigest:row.distribution_digest,
 resolverConfigDigest:row.resolver_config_digest,distro:{family:row.distro_family,suite:row.distro_suite,architecture:row.distro_architecture}}};
}
/** Two bounded jobs share the pool only for short queries/transactions, never during provider I/O.
 * Adapter methods must honor signal and recheck assertActive before each nested external mutation.
 * An operation already accepted remotely can finish after leadership loss; its successor reconciles it.
 */
export class SoftwareBuildCoordinator {
 private jobs=new Map<string,Promise<void>>();
 private closing=false;
 private leaderPid:number|null=null;
 private nextAttempt=new Map<string,number>();
 constructor(private database:any=db,private limit=2,private now=()=>Date.now()) {
  if(!Number.isInteger(limit)||limit<1||limit>2)throw Error('software_concurrency_invalid');
 }
 get activeCount(){return this.jobs.size;}
 async schedule(leader:ReservedSQL,hooks:SoftwareRuntimeHooks){
  if(this.closing)return;
  const [identity]=await leader`SELECT pg_backend_pid() AS pid,EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted) AS owned`;
  if(!identity.owned||(this.leaderPid!==null&&this.leaderPid!==identity.pid))throw new Stopped();
  this.leaderPid=identity.pid;
  const rows=await leader`SELECT id FROM portable_software_builds WHERE status NOT IN ('ready','failed') OR cleanup_status<>'complete' ORDER BY updated_at,id LIMIT 100`;
  const pending=new Set(rows.map((row:any)=>row.id));
  for(const id of this.nextAttempt.keys())if(!pending.has(id)&&!this.jobs.has(id))this.nextAttempt.delete(id);
  for(const row of rows){
   if(this.jobs.size>=this.limit)break;
   if(this.jobs.has(row.id)||(this.nextAttempt.get(row.id)??0)>this.now())continue;
   const job=this.progress(row.id,identity.pid,hooks).catch(()=>{console.error('software_progress_failed');}).finally(()=>{
    this.jobs.delete(row.id);this.nextAttempt.set(row.id,this.now()+1000);
   });
   this.jobs.set(row.id,job);
  }
 }
 async close(){this.closing=true;await Promise.allSettled([...this.jobs.values()]);}
 /** Public for deterministic fault tests; production admission goes through schedule. */
 async progress(id:string,leaderPid:number,hooks:SoftwareRuntimeHooks){
  const database=this.database;
  let row:any;
  async function load(sql:any=database,locked=false){
   // Immutable older revisions may finish after the template pointer advances.
   const rows=await sql.unsafe(`SELECT b.*,b.updated_at::text AS generation,s.provider_snapshot_name AS base_snapshot,s.distribution_digest,s.resolver_config_digest,s.distro_family,s.distro_suite,s.distro_architecture,
    EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=$2 AND objid=721440139 AND granted) AS leader_owned
    FROM portable_software_builds b JOIN portable_software_bases s ON s.id=b.base_id
    JOIN "user" u ON u.id=b.owner_id JOIN agent_templates t ON t.id=b.template_id AND t.owner_id=b.owner_id
    WHERE b.id=$1 ${locked?'FOR UPDATE OF b':''}`, [id,leaderPid]);
   const current=rows[0];
   if(!current?.leader_owned||(row&&(current.generation!==row.generation||['owner_id','template_id','base_id','create_key','request_fingerprint','provider_snapshot_name'].some(key=>current[key]!==row[key]))))throw new Stopped();
   return current;
  }
  const check=async()=>{if(this.closing)throw new Stopped();await load();};
  const checkpoint=async(body:(tx:any)=>Promise<void>)=>{
   let next:any;
   await database.begin(async(tx:any)=>{await load(tx,true);await body(tx);
    const [owned]=await tx`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=${leaderPid} AND objid=721440139 AND granted) AS owned`;
    if(!owned.owned)throw new Stopped();
    // The callback can update the row; read the new generation after its changes.
    [next]=await tx`SELECT updated_at::text AS generation FROM portable_software_builds WHERE id=${id}`;
   });
   row.generation=next.generation;row=await load();
  };
  const update=async(values:Record<string,unknown>)=>checkpoint(async tx=>{
   await tx`UPDATE portable_software_builds SET ${tx(values)},updated_at=clock_timestamp() WHERE id=${id}`;
  });
  const observeReady=async()=>{
   const observedAt=new Date(this.now());
   await checkpoint(async tx=>{await tx`INSERT INTO portable_software_usage_intervals(id,build_id,owner_id,ready_at,last_observed_at)
    VALUES(${crypto.randomUUID()},${id},${row.owner_id},${observedAt},${observedAt})
    ON CONFLICT(build_id) WHERE ended_at IS NULL DO UPDATE SET last_observed_at=GREATEST(portable_software_usage_intervals.last_observed_at,EXCLUDED.last_observed_at)`;});
  };
  const observeEnded=async(reason:'archived'|'missing')=>{
   const observedAt=new Date(this.now());
   await checkpoint(async tx=>{await tx`UPDATE portable_software_usage_intervals SET ended_at=GREATEST(last_observed_at,${observedAt}),end_reason=${reason}
    WHERE build_id=${id} AND owner_id=${row.owner_id} AND ended_at IS NULL`;});
  };
  const effect=async<T>(body:(build:SoftwareMachineBuild,context:SoftwareEffectContext)=>Promise<T>,cost=false):Promise<T>=>{
   await check();
   if(cost&&!await(hooks.canStartWork??ownerMayStartWork)(row.owner_id))throw new BuildFailure('software_subscription_required');
   await check();
   const remaining=terminal(row)?60_000:Math.max(1,deadlineMs-(this.now()-new Date(row.create_started_at??row.created_at).getTime()));
   const signal=AbortSignal.timeout(Math.min(remaining,deadlineMs));
   const assertEffect=async()=>{await check();if(cost&&!await(hooks.canStartWork??ownerMayStartWork)(row.owner_id))throw new BuildFailure('software_subscription_required');await check();};
   const value=await body.call(hooks.machines,projection(row),{signal,assertActive:assertEffect});await check();return value;
  };
  const cleanup=async()=>{
   if(row.cleanup_status==='complete')return;
   if(!row.box_id){
    await update({cleanup_status:row.create_started_at?'error':'complete'});return;
   }
   try{
    const machine=await effect(hooks.machines.get);
    if(machine.state==='archived'||machine.state==='missing'){
     const observedAt=new Date(this.now());
     await checkpoint(async tx=>{
      await tx`UPDATE portable_software_usage_intervals SET ended_at=GREATEST(last_observed_at,${observedAt}),end_reason=${machine.state}
       WHERE build_id=${id} AND owner_id=${row.owner_id} AND ended_at IS NULL`;
      await tx`UPDATE portable_software_builds SET cleanup_status='complete',updated_at=clock_timestamp() WHERE id=${id}`;
     });return;
    }
    if(machine.state==='ready')await observeReady();
    // Pending is the durable stop intent. Read again on the next pass, never claim stop from its reply.
    await update({cleanup_status:'pending'});
    await effect(hooks.machines.archive);
   }catch(error){if(error instanceof Stopped)throw error;await update({cleanup_status:'error'});}
  };
  try{
   row=await load();
   if(terminal(row)){await cleanup();return;}
   if(row.create_started_at&&this.now()-new Date(row.create_started_at).getTime()>deadlineMs)throw new BuildFailure('software_build_deadline');
   if(!row.box_id){
    if(!await(hooks.canStartWork??ownerMayStartWork)(row.owner_id))throw new BuildFailure('software_subscription_required');
    if(!row.create_started_at)await update({status:'creating',create_started_at:new Date(this.now())});
    if(this.now()-new Date(row.create_started_at).getTime()>=23*60*60_000)throw new BuildFailure('software_create_reconciliation_required');
    const created=await effect(hooks.machines.create,true);
    if(!created.id||created.id.length>128)throw new BuildFailure('software_provider_identity_invalid');
    await update({box_id:created.id,status:'resolving'});
   }
   const machine=await effect(hooks.machines.get);
   if(machine.state==='ready')await observeReady();
   else if(machine.state==='archived'||machine.state==='missing')await observeEnded(machine.state);
   if(row.snapshot_started_at){
    const snapshot=await effect(hooks.machines.getSnapshot);
    if(snapshot.state==='failed')throw new BuildFailure('software_snapshot_failed');
    if(snapshot.state==='ready'){
     if(!row.manifest_id||!row.resolved_manifest_digest)throw new BuildFailure('software_manifest_missing');
     await checkpoint(async tx=>{
      await hooks.onReady(tx,projection(row));
      await tx`UPDATE portable_software_builds SET status='ready',finished_at=now(),error_code=null,updated_at=clock_timestamp() WHERE id=${id}`;
     });
     await cleanup();
    }
    return;
   }
   if(machine.state==='missing')throw new BuildFailure('software_build_machine_missing');
   if(machine.state==='archived'){await effect(hooks.machines.resume,true);return;}
   if(machine.state!=='ready')return;
   if(!row.helper_request_digest){
    const prepared=await effect(hooks.machines.prepareHelper,true);
    if(!/^[a-f0-9]{64}$/.test(prepared.requestDigest))throw new BuildFailure('software_helper_digest_invalid');
    await update({helper_request_digest:prepared.requestDigest,status:'resolving'});
   }
   let observed=await effect(hooks.machines.statusHelper);
   // The helper journals before install, binds this exact digest and never repeats an interrupted install.
   if(observed!==null){
    const existing=helperSchema.safeParse(observed);
    if(!existing.success)throw new BuildFailure('software_helper_status_invalid');
    if(existing.data.requestDigest!==row.helper_request_digest)throw new BuildFailure('software_helper_digest_changed');
    if(existing.data.phase==='failed')throw new BuildFailure(['software_build_install_interrupted','software_build_verification_failed'].includes(existing.data.errorCode??'')?existing.data.errorCode!:'software_helper_failed');
   }
   if(observed===null||!(observed as any).readyForCapture){
    await update({status:'installing'});
    observed=await effect(hooks.machines.runHelper,true);
   }
   const parsed=helperSchema.safeParse(observed);
   if(!parsed.success)throw new BuildFailure('software_helper_status_invalid');
   const helper=parsed.data;
   if(helper.requestDigest!==row.helper_request_digest)throw new BuildFailure('software_helper_digest_changed');
   if(helper.phase==='failed')throw new BuildFailure(['software_build_install_interrupted','software_build_verification_failed'].includes(helper.errorCode??'')?helper.errorCode!:'software_helper_failed');
   if(helper.phase!=='verified'||!helper.readyForCapture)return;
   const manifest=validatePortableSoftwareManifest(await effect(hooks.machines.readManifest));
   if(softwareManifestDigest(manifest)!==helper.manifestDigest)throw new BuildFailure('software_manifest_digest_changed');
   await checkpoint(async tx=>{
    await recordResolvedSoftwareManifestInTransaction(tx,row.owner_id,id,manifest);
    await tx`UPDATE portable_software_builds SET status='capturing',updated_at=clock_timestamp() WHERE id=${id}`;
   });
   // Commit intent before POST. Even a missing GET after a lost POST never permits another POST.
   await update({snapshot_started_at:new Date(this.now())});
   try { await effect(hooks.machines.snapshot,true); }
   catch(error) {
    // This documented rejection proves capture was not accepted. A lost reply remains GET-only.
    if(error instanceof BoxError && error.code==='box_snapshot_limit')throw new BuildFailure('software_snapshot_limit');
    throw error;
   }
  }catch(error){
   if(error instanceof Stopped)return;
   if(!row)return;
   if(error instanceof BuildFailure||error instanceof SoftwareConflict||error instanceof z.ZodError){
    await update({status:'failed',error_code:error instanceof BuildFailure?error.code:'software_manifest_invalid',finished_at:new Date(this.now())});await cleanup();
   }
   // Unknown transport failure is reconciled on the next bounded pass; no raw provider error persists.
  }
 }
}
