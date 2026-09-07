import {createHash} from 'node:crypto';
import {db} from './store';

export const DEFAULT_MACHINE_LIMITS={active:2,startsPerHour:10,queue:20} as const;
export const MACHINE_IDLE_MS=30*60_000;
const globalAdmissionLock=721440140;

export type MachineAdmissionKind='configuration'|'test'|'intervention'|'improvement'|'capture'|'resume';
export type MachineAdmissionState='queued'|'admitted'|'cancelling'|'cancelled'|'completed'|'refused';
export interface MachineAdmissionInput {requestId:string;companionId:string;kind:MachineAdmissionKind}
export interface MachineAdmissionResult {id:string;companionId:string;kind:MachineAdmissionKind;state:MachineAdmissionState;waitingReason:string|null;requestedAt:Date;admittedAt:Date|null}
export class AdmissionConflict extends Error {}

function fingerprint(input:MachineAdmissionInput){return createHash('sha256').update(JSON.stringify({companionId:input.companionId,kind:input.kind})).digest('hex');}
function result(row:any):MachineAdmissionResult{return {id:row.id,companionId:row.companion_id,kind:row.kind,state:row.state,waitingReason:row.waiting_reason??null,requestedAt:new Date(row.requested_at),admittedAt:row.admitted_at?new Date(row.admitted_at):null};}

async function ensureLimits(tx:any,ownerId:string){
 await tx`INSERT INTO machine_account_limits(owner_id) VALUES(${ownerId}) ON CONFLICT(owner_id) DO NOTHING`;
 return (await tx`SELECT LEAST(offer_active_limit,COALESCE(personal_active_limit,offer_active_limit))::int AS active,
  starts_per_hour_limit::int AS "startsPerHour",queue_limit::int AS queue FROM machine_account_limits WHERE owner_id=${ownerId}`)[0];
}

export async function effectiveAccountLimits(ownerId:string,sql:any=db){return sql.begin((tx:any)=>ensureLimits(tx,ownerId));}

export async function setPersonalActiveLimit(ownerId:string,active:number|null,sql:any=db){
 if(active!==null&&(!Number.isInteger(active)||active<0))throw new AdmissionConflict('Invalid personal active limit.');
 return sql.begin(async(tx:any)=>{await ensureLimits(tx,ownerId);const [{offer_active_limit:offer}]=await tx`SELECT offer_active_limit FROM machine_account_limits WHERE owner_id=${ownerId}`;
  if(active!==null&&active>Number(offer))throw new AdmissionConflict('Personal limit cannot exceed the offer limit.');
  const [row]=await tx`UPDATE machine_account_limits SET personal_active_limit=${active},updated_at=now() WHERE owner_id=${ownerId} RETURNING owner_id`;
  return row?ensureLimits(tx,ownerId):null;});
}

export async function configureOfferMachineLimits(ownerId:string,input:{active:number;startsPerHour:number;queue:number},sql:any=db){
 if(!Number.isInteger(input.active)||input.active<0||!Number.isInteger(input.startsPerHour)||input.startsPerHour<0||!Number.isInteger(input.queue)||input.queue<0)throw new AdmissionConflict('Invalid offer limits.');
 await sql`INSERT INTO machine_account_limits(owner_id,offer_active_limit,starts_per_hour_limit,queue_limit)
  VALUES(${ownerId},${input.active},${input.startsPerHour},${input.queue}) ON CONFLICT(owner_id) DO UPDATE SET
  offer_active_limit=EXCLUDED.offer_active_limit,starts_per_hour_limit=EXCLUDED.starts_per_hour_limit,queue_limit=EXCLUDED.queue_limit,updated_at=now()`;
 return effectiveAccountLimits(ownerId,sql);
}

export async function configureProviderMachineLimits(input:{active:number;startsPerMinute:number;startsPerHour:number;startsPerDay:number},sql:any=db){
 const values=[input.active,input.startsPerMinute,input.startsPerHour,input.startsPerDay];
 if(values.some(value=>!Number.isInteger(value)||value<0))throw new AdmissionConflict('Invalid provider limits.');
 const [row]=await sql`UPDATE machine_provider_limits SET active_limit=${input.active},starts_per_minute_limit=${input.startsPerMinute},
  starts_per_hour_limit=${input.startsPerHour},starts_per_day_limit=${input.startsPerDay},updated_at=now() WHERE singleton=true RETURNING singleton`;
 if(!row)throw new AdmissionConflict('Provider limits unavailable.');
 return input;
}

async function occupancy(tx:any,ownerId?:string,specialistsOnly=false){
 const [row]=await tx`SELECT count(DISTINCT c.id)::int AS count FROM companions c
  WHERE (${ownerId??null}::text IS NULL OR c.owner_id=${ownerId??null}) AND c.retired_at IS NULL
  AND (NOT ${specialistsOnly} OR c.temporary OR c.specialist_draft_id IS NOT NULL) AND (
   EXISTS(SELECT 1 FROM machine_admission_requests a WHERE a.companion_id=c.id AND a.state IN ('admitted','cancelling') AND a.released_at IS NULL)
   OR (c.archived_at IS NULL AND (c.endpoint_secret IS NOT NULL OR c.box_id IS NOT NULL OR c.create_started_at IS NOT NULL))
  )`;
 return Number(row.count);
}

async function decide(tx:any,row:any,limits:any){
 const [active]=await tx`SELECT status,box_id,endpoint_secret,create_started_at,archived_at,temporary,specialist_draft_id FROM companions WHERE id=${row.companion_id} FOR UPDATE`;
 if(!active)return null;
 const specialist=active.temporary||active.specialist_draft_id;
 const alreadyActive=!active.archived_at&&!!(active.box_id||active.endpoint_secret||active.create_started_at);
 const ownerActive=specialist?await occupancy(tx,row.owner_id,true):0;
 const [providerLimits]=await tx`SELECT active_limit,starts_per_minute_limit,starts_per_hour_limit,starts_per_day_limit FROM machine_provider_limits WHERE singleton=true`;
 const globalActive=await occupancy(tx);
 const [starts]=specialist?await tx`SELECT count(*)::int AS count FROM machine_admission_requests a JOIN companions c ON c.id=a.companion_id
  WHERE a.owner_id=${row.owner_id} AND (c.temporary OR c.specialist_draft_id IS NOT NULL) AND a.start_counted AND a.admitted_at>=now()-interval '1 hour'`:[{count:0}];
 const [providerStarts]=await tx`SELECT
  count(*) FILTER(WHERE admitted_at>=now()-interval '1 minute')::int AS minute,
  count(*) FILTER(WHERE admitted_at>=now()-interval '1 hour')::int AS hour,
  count(*) FILTER(WHERE admitted_at>=now()-interval '1 day')::int AS day
  FROM machine_admission_requests WHERE start_counted`;
 let reason:string|null=null;
 if(!alreadyActive&&specialist&&ownerActive>=limits.active)reason='active_limit';
 else if(!alreadyActive&&globalActive>=Number(providerLimits.active_limit))reason='provider_active_limit';
 else if(!alreadyActive&&Number(providerStarts.minute)>=Number(providerLimits.starts_per_minute_limit))reason='provider_start_minute_limit';
 else if(!alreadyActive&&Number(providerStarts.hour)>=Number(providerLimits.starts_per_hour_limit))reason='provider_start_hour_limit';
 else if(!alreadyActive&&Number(providerStarts.day)>=Number(providerLimits.starts_per_day_limit))reason='provider_start_day_limit';
 else if(!alreadyActive&&specialist&&Number(starts.count)>=limits.startsPerHour)reason='hourly_start_limit';
 if(reason){
  const [waiting]=await tx`UPDATE machine_admission_requests SET waiting_reason=${reason} WHERE id=${row.id} AND state='queued' RETURNING *`;
  return waiting;
 }
 const [admitted]=await tx`UPDATE machine_admission_requests SET state='admitted',waiting_reason=null,admitted_at=now(),start_counted=${!alreadyActive}
  WHERE id=${row.id} AND state='queued' RETURNING *`;
 if(!admitted)return null;
 await tx`UPDATE companions SET prepare_requested=prepare_requested OR ${row.kind!=='capture'},archive_requested_at=null,error=null WHERE id=${row.companion_id} AND retired_at IS NULL`;
 return admitted;
}

/** Transaction form lets companion creation and capacity reservation commit atomically. */
export async function requestMachineAdmissionInTransaction(tx:any,ownerId:string,input:MachineAdmissionInput):Promise<MachineAdmissionResult>{
 await tx`SELECT pg_advisory_xact_lock(${globalAdmissionLock})`;
 await tx`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId},570))`;
 const digest=fingerprint(input);
 const [prior]=await tx`SELECT * FROM machine_admission_requests WHERE id=${input.requestId} AND owner_id=${ownerId}`;
 if(prior){if(prior.fingerprint!==digest)throw new AdmissionConflict('Admission request identifier changed.');return result(prior);}
 const [companion]=await tx`SELECT id,temporary,specialist_draft_id FROM companions WHERE id=${input.companionId} AND owner_id=${ownerId} AND retired_at IS NULL FOR UPDATE`;
 if(!companion)throw new AdmissionConflict('Machine unavailable.');
 const [open]=await tx`SELECT * FROM machine_admission_requests WHERE companion_id=${input.companionId} AND state IN ('queued','admitted','cancelling')`;
 if(open)throw new AdmissionConflict('This machine already has an active admission request.');
 const limits=await ensureLimits(tx,ownerId);
 const specialist=companion.temporary||companion.specialist_draft_id;
 const [queuedCount]=specialist?await tx`SELECT count(*)::int AS count FROM machine_admission_requests a JOIN companions c ON c.id=a.companion_id
  WHERE a.owner_id=${ownerId} AND a.state='queued' AND (c.temporary OR c.specialist_draft_id IS NOT NULL)`:[{count:0}];
 if(specialist&&Number(queuedCount.count)>=limits.queue){
  const [refused]=await tx`INSERT INTO machine_admission_requests(id,owner_id,companion_id,kind,fingerprint,state,waiting_reason)
   VALUES(${input.requestId},${ownerId},${input.companionId},${input.kind},${digest},'refused','queue_full') RETURNING *`;
  return result(refused);
 }
 const [queued]=await tx`INSERT INTO machine_admission_requests(id,owner_id,companion_id,kind,fingerprint,state)
  VALUES(${input.requestId},${ownerId},${input.companionId},${input.kind},${digest},'queued') RETURNING *`;
 if(specialist){
  const [older]=await tx`SELECT a.id FROM machine_admission_requests a JOIN companions c ON c.id=a.companion_id
   WHERE a.owner_id=${ownerId} AND a.state='queued' AND (c.temporary OR c.specialist_draft_id IS NOT NULL) AND a.id<>${queued.id}
   ORDER BY a.requested_at,a.id LIMIT 1`;
  if(older){const [waiting]=await tx`UPDATE machine_admission_requests SET waiting_reason='fifo' WHERE id=${queued.id} RETURNING *`;return result(waiting);}
 }
 return result(await decide(tx,queued,limits)??queued);
}

export async function requestMachineAdmission(ownerId:string,input:MachineAdmissionInput,sql:any=db){
 return sql.begin((tx:any)=>requestMachineAdmissionInTransaction(tx,ownerId,input));
}

export async function cancelMachineAdmission(ownerId:string,requestId:string,sql:any=db):Promise<MachineAdmissionResult>{
 return sql.begin(async(tx:any)=>{
  await tx`SELECT pg_advisory_xact_lock(${globalAdmissionLock})`;await tx`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId},570))`;
  const [row]=await tx`SELECT a.*,c.box_id,c.endpoint_secret,c.preparation_started_at FROM machine_admission_requests a
   JOIN companions c ON c.id=a.companion_id AND c.owner_id=a.owner_id WHERE a.id=${requestId} AND a.owner_id=${ownerId} FOR UPDATE OF a,c`;
  if(!row)throw new AdmissionConflict('Admission request unavailable.');
  if(['cancelled','completed','refused'].includes(row.state))return result(row);
  if(row.state==='queued'||(!row.box_id&&!row.endpoint_secret&&!row.preparation_started_at)){
   const [cancelled]=await tx`UPDATE machine_admission_requests SET state='cancelled',cancelled_at=now(),released_at=now(),waiting_reason=null WHERE id=${requestId} RETURNING *`;
   await tx`UPDATE companions SET prepare_requested=false WHERE id=${row.companion_id}`;return result(cancelled);
  }
  const [cancelling]=await tx`UPDATE machine_admission_requests SET state='cancelling',cancelled_at=now(),waiting_reason='archive_pending' WHERE id=${requestId} RETURNING *`;
  await tx`UPDATE companions SET archive_requested_at=COALESCE(archive_requested_at,now()),prepare_requested=false WHERE id=${row.companion_id}`;
  return result(cancelling);
 });
}

/** Release a reservation after a non-standard executor (for example image capture) has durably finished. */
export async function completeMachineAdmission(ownerId:string,requestId:string,sql:any=db):Promise<MachineAdmissionResult>{
 return sql.begin(async(tx:any)=>{
  await tx`SELECT pg_advisory_xact_lock(${globalAdmissionLock})`;await tx`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId},570))`;
  const [row]=await tx`SELECT * FROM machine_admission_requests WHERE id=${requestId} AND owner_id=${ownerId} FOR UPDATE`;
  if(!row)throw new AdmissionConflict('Admission request unavailable.');
  if(row.state==='completed')return result(row);
  if(row.state!=='admitted')throw new AdmissionConflict('Only admitted work can be completed.');
  const [completed]=await tx`UPDATE machine_admission_requests SET state='completed',released_at=now(),waiting_reason=null WHERE id=${requestId} RETURNING *`;
  return result(completed);
 });
}

export interface AdmissionEligibility {eligible:boolean;reason?:string}
async function persistedEligibility(sql:any,request:any):Promise<AdmissionEligibility>{
 if(request.kind!=='intervention')return {eligible:true};
 const [row]=await sql`SELECT c.id,c.parent_id,c.template_id,p.parent_id AS permitted_parent
  FROM companions c LEFT JOIN template_permissions p ON p.parent_id=c.parent_id AND p.template_id=c.template_id
  LEFT JOIN companions parent ON parent.id=c.parent_id AND parent.owner_id=c.owner_id AND parent.retired_at IS NULL
  WHERE c.id=${request.companion_id} AND c.owner_id=${request.owner_id} AND c.retired_at IS NULL AND parent.id IS NOT NULL`;
 if(!row)return {eligible:false,reason:'permission_required'};
 return row.permitted_parent?{eligible:true}:{eligible:false,reason:'permission_required'};
}
export async function progressMachineAdmissions(sql:any=db,options:{eligible?(request:any):Promise<AdmissionEligibility>}={}){
 const pending=await sql`SELECT * FROM machine_admission_requests WHERE state='queued' ORDER BY requested_at,id LIMIT 100`;
 for(const candidate of pending){
  const eligibility=await (options.eligible?.(candidate)??persistedEligibility(sql,candidate));
  if(!eligibility.eligible){await sql`UPDATE machine_admission_requests SET waiting_reason=${eligibility.reason??'ineligible'} WHERE id=${candidate.id} AND state='queued'`;continue;}
  await sql.begin(async(tx:any)=>{
   await tx`SELECT pg_advisory_xact_lock(${globalAdmissionLock})`;await tx`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.owner_id},570))`;
   const [current]=await tx`SELECT * FROM machine_admission_requests WHERE id=${candidate.id} FOR UPDATE`;
   if(!current||current.state!=='queued')return;
   const [companion]=await tx`SELECT retired_at FROM companions WHERE id=${current.companion_id} AND owner_id=${current.owner_id} FOR UPDATE`;
   if(!companion||companion.retired_at){await tx`UPDATE machine_admission_requests SET state='cancelled',cancelled_at=now(),released_at=now(),waiting_reason='machine_unavailable' WHERE id=${current.id}`;return;}
   await decide(tx,current,await ensureLimits(tx,current.owner_id));
  });
 }
}

/** Legacy rows without an admission journal remain recoverable; journaled starts must be admitted. */
export async function machineAdmissionAllowsEffect(companionId:string,sql:any=db){
 const [row]=await sql`SELECT state FROM machine_admission_requests WHERE companion_id=${companionId} AND state IN ('queued','admitted','cancelling') ORDER BY requested_at DESC LIMIT 1`;
 return !row||row.state==='admitted';
}

export async function recordMachineActivity(ownerId:string,companionId:string,at=new Date(),sql:any=db){
 const [row]=await sql`UPDATE companions SET machine_activity_at=GREATEST(COALESCE(machine_activity_at,'-infinity'),${at})
  WHERE id=${companionId} AND owner_id=${ownerId} AND retired_at IS NULL RETURNING id,machine_activity_at AS "activityAt"`;
 return row??null;
}
export async function renewMachineLease(ownerId:string,companionId:string,at=new Date(),sql:any=db){
 const until=new Date(at.getTime()+MACHINE_IDLE_MS);
 const [row]=await sql`UPDATE companions SET machine_activity_at=GREATEST(COALESCE(machine_activity_at,'-infinity'),${at}),keep_alive_until=GREATEST(COALESCE(keep_alive_until,'-infinity'),${until})
  WHERE id=${companionId} AND owner_id=${ownerId} AND retired_at IS NULL AND archive_requested_at IS NULL RETURNING id,keep_alive_until AS "keepAliveUntil"`;
 return row??null;
}

export interface IdleMachineProvider {archive(companion:any,beforeEffect?:()=>Promise<void>):Promise<boolean>}
/** Archives confirmed-idle machines while preserving their provider disk. */
export async function progressIdleMachines(sql:any,provider:IdleMachineProvider,options:{now?:Date;idleMs?:number;companionId?:string|null;canArchive?(companion:any):Promise<boolean>;assertEffect?():Promise<void>}={}){
 const now=options.now??new Date(),cutoff=new Date(now.getTime()-(options.idleMs??MACHINE_IDLE_MS));
 const candidates=await sql`SELECT c.* FROM companions c WHERE (${options.companionId??null}::uuid IS NULL OR c.id=${options.companionId??null})
  AND (c.temporary OR c.specialist_draft_id IS NOT NULL)
  AND c.retired_at IS NULL AND c.archived_at IS NULL AND (c.status='ready' OR c.archive_requested_at IS NOT NULL)
  AND c.prepare_requested=false AND NOT c.desktop_taken AND c.desktop_paused_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.companion_id=c.id AND r.dispatched AND r.status IN ('preparing','running'))
  AND NOT EXISTS(SELECT 1 FROM template_candidates t WHERE t.source_companion_id=c.id AND t.status IN ('queued','capturing','ready'))
  AND (c.archive_requested_at IS NOT NULL OR (
   COALESCE(c.keep_alive_until,'-infinity')<=${now} AND GREATEST(COALESCE(c.machine_activity_at,c.ready_at,c.created_at),
    COALESCE((SELECT max(COALESCE(r.finished_at,r.started_at,r.created_at)) FROM runs r WHERE r.companion_id=c.id),'-infinity'))<=${cutoff}
  )) ORDER BY COALESCE(c.archive_requested_at,c.machine_activity_at,c.ready_at,c.created_at),c.id LIMIT 50`;
 for(const companion of candidates){
  if(options.canArchive&&!await options.canArchive(companion))continue;
  const requested=await sql.begin(async(tx:any)=>{
   const [row]=await tx`SELECT id FROM companions c WHERE c.id=${companion.id} AND c.retired_at IS NULL AND c.archived_at IS NULL
    AND c.prepare_requested=false AND NOT c.desktop_taken AND c.desktop_paused_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.companion_id=c.id AND r.dispatched AND r.status IN ('preparing','running')) FOR UPDATE`;
   if(!row)return false;await tx`UPDATE companions SET archive_requested_at=COALESCE(archive_requested_at,${now}) WHERE id=${companion.id}`;return true;
  });
  if(!requested)continue;
  // Existing temporary-child finalization owns its result retention, usage event and retirement.
  if(companion.temporary)continue;
  const guard=async()=>{
   await options.assertEffect?.();
   if(options.canArchive&&!await options.canArchive(companion))throw new AdmissionConflict('Idle archive authority changed.');
   const [current]=await sql`SELECT id FROM companions c WHERE c.id=${companion.id} AND c.retired_at IS NULL AND c.archive_requested_at IS NOT NULL
    AND c.prepare_requested=false AND NOT c.desktop_taken AND c.desktop_paused_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.companion_id=c.id AND r.dispatched AND r.status IN ('preparing','running'))`;
   if(!current)throw new AdmissionConflict('Idle archive authority changed.');
  };
  try{
   await guard();if(!await provider.archive(companion,guard))continue;
   await sql.begin(async(tx:any)=>{
    await tx`UPDATE companions SET status='archived',archived_at=${now},archive_requested_at=null,endpoint_secret=null,preparation_started_at=null,error=null WHERE id=${companion.id} AND archive_requested_at IS NOT NULL`;
    await tx`UPDATE machine_admission_requests SET state=CASE WHEN state='cancelling' THEN 'cancelled' ELSE 'completed' END,released_at=COALESCE(released_at,${now}),waiting_reason=null
     WHERE companion_id=${companion.id} AND state IN ('admitted','cancelling')`;
   });
  }catch(error){
   if(error instanceof AdmissionConflict)continue;
   await sql`UPDATE companions SET error='Machine archive is awaiting provider confirmation.' WHERE id=${companion.id}`;
  }
 }
}
