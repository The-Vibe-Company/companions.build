import {z} from 'zod';
import type {BoxClient} from '../../../packages/box/client';
import {configureProviderMachineLimits} from './admission';
const count=z.number().int().min(0).max(100_000);
const limits=z.object({canStart:z.boolean(),maxActiveBoxes:count,startLimits:z.object({perMinute:count,perHour:count,perDay:count})});
let checkedAt=0;
let pending:Promise<void>|null=null;
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
 const rows=await sql`SELECT c.id,c.box_id FROM companions c WHERE (${companionId}::uuid IS NULL OR c.id=${companionId})
  AND (c.temporary OR c.specialist_draft_id IS NOT NULL) AND c.retired_at IS NULL AND c.archived_at IS NULL AND c.box_id IS NOT NULL
  AND (c.provider_ttl_checked_at IS NULL OR c.provider_ttl_checked_at<now()-interval '15 minutes')
  AND (c.keep_alive_until>now() OR EXISTS(SELECT 1 FROM runs r WHERE r.companion_id=c.id AND r.dispatched AND r.status='running')) LIMIT 20`;
 for(const row of rows){
  await guard();
  try{
   await box.extend(row.box_id,7200);
   const observed=await box.get(row.box_id);
   if(!observed.archiveAfter||Date.parse(observed.archiveAfter)<Date.now()+60*60_000)throw Error('ttl_not_confirmed');
   await guard();await sql`UPDATE companions SET provider_ttl_checked_at=now() WHERE id=${row.id} AND box_id=${row.box_id}`;
  }catch{await guard();await sql`UPDATE companions SET error='Machine lifetime extension could not be confirmed.' WHERE id=${row.id} AND box_id=${row.box_id}`;}
 }
}
