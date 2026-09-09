import {z} from 'zod';
import {BoxError,type BoxClient} from '../../../packages/box/client';
import {configureProviderMachineLimits} from './admission';
const count=z.number().int().min(0).max(100_000);
const limits=z.object({canStart:z.boolean(),maxActiveBoxes:count,startLimits:z.object({perMinute:count,perHour:count,perDay:count})});
let checkedAt=0;
let pending:Promise<void>|null=null;
/** Only an explicit rejection of create/resume is retryable. Transport ambiguity keeps its identity. */
export async function deferRejectedBoxStart(sql:any,companionId:string,error:unknown){
 if(!(error instanceof BoxError)||error.code!=='box_start_rate_limited')return false;
 await sql.begin(async(tx:any)=>{
  await tx`SELECT pg_advisory_xact_lock(721440140)`;
  await tx`UPDATE machine_provider_limits SET cooldown_until=GREATEST(COALESCE(cooldown_until,'-infinity'),now()+interval '60 seconds') WHERE singleton=true`;
  await tx`UPDATE machine_admission_requests SET state='queued',waiting_reason='provider_cooldown',admitted_at=null,start_counted=false WHERE companion_id=${companionId} AND state='admitted'`;
  await tx`UPDATE companions SET create_started_at=CASE WHEN box_id IS NULL THEN NULL ELSE create_started_at END,error='Waiting for provider capacity.' WHERE id=${companionId}`;
 });
 return true;
}
/** Provider values are consumed as bounded counters, never logged or returned as raw payloads. */
export async function refreshSpecialistProviderLimits(sql:any,box:BoxClient|null){
 if(!box||Date.now()-checkedAt<30_000)return;
 if(pending)return pending;
 pending=(async()=>{
  try{
   const value=limits.parse(await box.limits());
   await configureProviderMachineLimits({active:value.canStart?value.maxActiveBoxes:0,startsPerMinute:value.startLimits.perMinute,startsPerHour:value.startLimits.perHour,startsPerDay:value.startLimits.perDay},sql);
   checkedAt=Date.now();
  }catch{
   await configureProviderMachineLimits({active:0,startsPerMinute:0,startsPerHour:0,startsPerDay:0},sql);
   checkedAt=Date.now();
  }
 })().finally(()=>{pending=null;});
 return pending;
}

export async function renewSpecialistProviderLifetime(sql:any,box:BoxClient|null,companionId:string|null,guard:()=>Promise<void>){
 if(!box)return;
 const rows=await sql`SELECT c.id,c.box_id,c.provider_ttl_target_until FROM companions c WHERE (${companionId}::uuid IS NULL OR c.id=${companionId})
  AND (c.temporary OR c.specialist_draft_id IS NOT NULL) AND c.retired_at IS NULL AND c.archived_at IS NULL AND c.box_id IS NOT NULL
  AND c.archive_requested_at IS NULL
  AND (c.provider_ttl_checked_at IS NULL OR c.provider_ttl_checked_at<now()-interval '15 minutes')
  AND (c.keep_alive_until>now() OR EXISTS(SELECT 1 FROM runs r WHERE r.companion_id=c.id AND r.dispatched AND r.status='running')) LIMIT 20`;
 for(const row of rows){
  await guard();
  try{
   const observed=await box.get(row.box_id);
   if(observed.archiveAfter&&Date.parse(observed.archiveAfter)>=Date.now()+60*60_000){
    await guard();await sql`UPDATE companions SET provider_ttl_checked_at=now(),provider_ttl_target_until=null WHERE id=${row.id} AND box_id=${row.box_id}`;continue;
   }
   // An unconfirmed PATCH is observation-only, including after executor restart.
   if(row.provider_ttl_target_until)throw Error('ttl_not_confirmed');
   const target=new Date(Date.now()+7200_000);
   await guard();
   const [intent]=await sql`UPDATE companions c SET provider_ttl_checked_at=now(),provider_ttl_target_until=${target}
    WHERE c.id=${row.id} AND c.box_id=${row.box_id} AND c.retired_at IS NULL AND c.archived_at IS NULL AND c.archive_requested_at IS NULL
    AND c.provider_ttl_target_until IS NULL
    AND (c.keep_alive_until>now() OR EXISTS(SELECT 1 FROM runs r WHERE r.companion_id=c.id AND r.dispatched AND r.status='running')) RETURNING c.id`;
   if(!intent)continue;
   await guard();
   const [active]=await sql`SELECT c.id FROM companions c WHERE c.id=${row.id} AND c.box_id=${row.box_id}
    AND c.retired_at IS NULL AND c.archived_at IS NULL AND c.archive_requested_at IS NULL AND c.provider_ttl_target_until=${target}
    AND (c.keep_alive_until>now() OR EXISTS(SELECT 1 FROM runs r WHERE r.companion_id=c.id AND r.dispatched AND r.status='running'))`;
   if(!active)continue;
   await box.extend(row.box_id,7200);
   const confirmed=await box.get(row.box_id);
   if(!confirmed.archiveAfter||Date.parse(confirmed.archiveAfter)<target.getTime()-60_000)throw Error('ttl_not_confirmed');
   await guard();await sql`UPDATE companions SET provider_ttl_checked_at=now(),provider_ttl_target_until=null WHERE id=${row.id} AND box_id=${row.box_id}`;
  }catch{await guard();await sql`UPDATE companions SET provider_ttl_checked_at=now(),error='Machine lifetime extension could not be confirmed; its provider state will be checked without replaying the request.' WHERE id=${row.id} AND box_id=${row.box_id}`;}
 }
}
