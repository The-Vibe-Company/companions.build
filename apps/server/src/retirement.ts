import {db} from './store';
import {ExecutionStopped,type EffectGuard} from './machines';
import type {LifecycleMachines} from './lifecycle';

/** Remove from the workspace immediately; only the executor may stop its computer. */
export async function retireCompanion(ownerId:string,id:string,sql:any=db){
 return sql.begin((tx:any)=>retireCompanionInTransaction(ownerId,id,tx));
}
export async function retireCompanionInTransaction(ownerId:string,id:string,tx:any){
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId},569))`;
  // Spawn holds the same parent lock, so no owned child can appear after this list.
  const [parent]=await tx`SELECT id FROM companions WHERE id=${id} AND owner_id=${ownerId} FOR UPDATE`;
  if(!parent)return null;
  const children=await tx`SELECT id FROM companions WHERE parent_id=${id} AND owner_id=${ownerId} AND temporary ORDER BY id FOR UPDATE`;
  const ids=[id,...children.map((child:any)=>child.id)] as string[];
  for(const companionId of ids){
   await tx`UPDATE companions SET retired_at=COALESCE(retired_at,now()),
    archive_requested_at=CASE WHEN retired_at IS NULL THEN now() ELSE COALESCE(archive_requested_at,now()) END,prepare_requested=false,error=null
    WHERE id=${companionId} AND owner_id=${ownerId}`;
   await tx`UPDATE routines SET enabled=false,next_fire_at=null,updated_at=now() WHERE companion_id=${companionId}`;
   await tx`UPDATE triggers SET enabled=false,updated_at=now() WHERE companion_id=${companionId}`;
   await tx`UPDATE runs SET cancel_requested=true,status=CASE WHEN dispatched THEN status ELSE 'cancelled' END,
    finished_at=CASE WHEN dispatched THEN finished_at ELSE COALESCE(finished_at,now()) END
    WHERE companion_id=${companionId} AND status IN ('queued','preparing','running','needs_input')`;
   await tx`UPDATE runs r SET cancel_requested=true,status=CASE WHEN r.dispatched THEN r.status ELSE 'cancelled' END,
    finished_at=CASE WHEN r.dispatched THEN r.finished_at ELSE COALESCE(r.finished_at,now()) END
    FROM delegations d JOIN companions target ON target.id=d.target_id AND target.owner_id=${ownerId}
    WHERE d.parent_id=${companionId} AND d.run_id=r.id AND d.finished_at IS NULL AND r.status IN ('queued','preparing','running','needs_input')`;
   await tx`UPDATE template_candidates SET status='failed',error='Companion was removed.' WHERE source_companion_id=${companionId} AND status='queued'`;
   await tx`UPDATE companion_maintenance_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE companion_id=${companionId} AND client_owner_id=${ownerId}`;
  }
  return {deleted:true,companionIds:ids};
}

type Checkpoint=<T>(body:(tx:any)=>Promise<T>)=>Promise<T>;
/** Retired rows remain eligible until archive is observed, even with active/parked runs. */
export async function progressRetirements(sql:any,companionId:string|null,machine:Pick<LifecycleMachines,'archive'|'snapshotStatus'|'cancel'>,
 assertLeader:EffectGuard,checkpoint:Checkpoint,onArchived:(tx:any,companion:any)=>Promise<void>){
 const pending=await sql`SELECT *,archive_requested_at::text AS retirement_token FROM companions WHERE (${companionId}::uuid IS NULL OR id=${companionId})
  AND retired_at IS NOT NULL AND archive_requested_at IS NOT NULL
  AND (archived_at IS NULL OR archived_at<archive_requested_at) ORDER BY archive_requested_at,id LIMIT 50`;
 for(const companion of pending){
  async function guard(){
   await assertLeader();
   const [current]=await sql`SELECT id FROM companions WHERE id=${companion.id} AND owner_id=${companion.owner_id}
    AND retired_at IS NOT NULL AND archive_requested_at::text=${companion.retirement_token}
    AND box_id IS NOT DISTINCT FROM ${companion.box_id} AND agent_secret=${companion.agent_secret}
    AND endpoint_secret IS NOT DISTINCT FROM ${companion.endpoint_secret}`;
   if(!current)throw new ExecutionStopped('Retirement authority changed');
   await assertLeader();
  }
  try{
   await guard();
   // Cancellation remains available after retirement, without allowing any new prompt.
   if(machine.cancel&&companion.endpoint_secret){
    for(const run of await sql`SELECT id FROM runs WHERE companion_id=${companion.id} AND dispatched AND status IN ('preparing','running','needs_input') ORDER BY created_at,id`){
     try{
      await guard();const stopped=await machine.cancel(companion,run.id,guard);await guard();
      if(stopped)await checkpoint(async(tx:any)=>{await tx`UPDATE runs SET status='cancelled',cancel_requested=true,error='Companion was removed.',finished_at=COALESCE(finished_at,now()) WHERE id=${run.id} AND status IN ('preparing','running','needs_input')`;});
     }catch(error){if(error instanceof ExecutionStopped)throw error;/* Archive remains the fallback; no prompt replay. */}
    }
   }
   const captures=await sql`SELECT id,snapshot_name,attempted_at FROM template_candidates WHERE source_companion_id=${companion.id} AND status IN ('capturing','ready')`;
   let waiting=false;let reconciliation=false;
   for(const capture of captures){
    await guard();const state=await machine.snapshotStatus(capture.snapshot_name);await guard();
    if(state!=='ready'&&state!=='failed'){waiting=true;if(capture.attempted_at&&Date.now()-new Date(capture.attempted_at).getTime()>10*60_000)reconciliation=true;continue;}
    await checkpoint(async(tx:any)=>{await tx`UPDATE template_candidates SET status='failed',error='Companion was removed; existing template was preserved.' WHERE id=${capture.id} AND status IN ('capturing','ready')`;});
   }
   if(waiting){await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET error=${reconciliation?'Removal requires reconciliation of an unconfirmed snapshot; the source computer is preserved.':'Removal is waiting for a previously requested snapshot to finish.'} WHERE id=${companion.id}`;});continue;}
   // Unknown create outcomes must be reconciled to the original Box, never replaced.
   if(companion.provider==='box'&&!companion.box_id&&companion.create_started_at){
    await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET error='Removal is waiting for the original machine identity to be reconciled.' WHERE id=${companion.id}`;});continue;
   }
   const neverStarted=!companion.box_id&&!companion.create_started_at;
   if(!neverStarted){await guard();if(!await machine.archive(companion,guard))continue;await guard();}
   await checkpoint(async(tx:any)=>{
    const [done]=await tx`UPDATE companions SET archived_at=now(),status='archived',endpoint_secret=null,prepare_requested=false,desktop_paused_at=null,error=null
      WHERE id=${companion.id} AND owner_id=${companion.owner_id} AND retired_at IS NOT NULL
      AND archive_requested_at::text=${companion.retirement_token} AND box_id IS NOT DISTINCT FROM ${companion.box_id}
      AND (archived_at IS NULL OR archived_at<archive_requested_at) RETURNING id`;
    if(!done)return;
    await tx`UPDATE runs SET status='cancelled',cancel_requested=true,error='Companion was removed.',finished_at=COALESCE(finished_at,now())
      WHERE companion_id=${companion.id} AND status IN ('queued','preparing','running','needs_input')`;
    // Keep delegation/result links readable without enqueueing a review for removed work.
    await tx`UPDATE delegations d SET result=COALESCE(d.result,jsonb_build_object('status',r.status,'text',r.result_text,'error',r.error,'runId',r.id,'companionId',r.companion_id)),finished_at=COALESCE(d.finished_at,now())
      FROM runs r WHERE d.run_id=r.id AND d.target_id=${companion.id}`;
    if(!neverStarted)await onArchived(tx,companion);
   });
  }catch(error){
   if(error instanceof ExecutionStopped)throw error;
   await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET error='Removal is awaiting machine archive confirmation.'
    WHERE id=${companion.id} AND retired_at IS NOT NULL AND (archived_at IS NULL OR archived_at<archive_requested_at)`;});
  }
 }
}
