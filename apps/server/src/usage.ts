import {db} from './store';
import {recordUsage,flushPendingUsage} from './billing';
import {BOX_OBSERVATION_MAX_GAP_MS} from './box-observation';
/** Confirmed intervals only: a later ready observation never backfills a controller outage. */
export async function billableBoxIntervals(sql:any=db,now=new Date()){
 const rows=await sql`SELECT e.id,e.companion_id,e.owner_id,e.occurred_at,o.ready_event_id AS observation_id,o.last_alive_at,o.archive_after,
  (SELECT min(a.occurred_at) FROM machine_usage_events a WHERE a.companion_id=e.companion_id AND a.owner_id=e.owner_id AND a.event='ready' AND a.occurred_at>e.occurred_at) AS next_ready_at,
  (SELECT min(a.occurred_at) FROM machine_usage_events a WHERE a.companion_id=e.companion_id AND a.owner_id=e.owner_id AND a.event='archived' AND a.closes_ready_event_id IS NULL AND a.occurred_at>=e.occurred_at) AS internal_archive_at,
  (SELECT min(a.occurred_at) FROM machine_usage_events a WHERE a.companion_id=e.companion_id AND a.owner_id=e.owner_id AND a.event='archived' AND a.closes_ready_event_id=e.id) AS observed_archive_at,
  COALESCE((SELECT json_agg(json_build_array(g.starts_at,g.ends_at)) FROM box_observation_gaps g WHERE g.ready_event_id=e.id),'[]') AS gaps
  FROM machine_usage_events e JOIN companions c ON c.id=e.companion_id AND c.owner_id=e.owner_id
  LEFT JOIN box_observations o ON o.ready_event_id=e.id AND o.companion_id=c.id AND o.owner_id=c.owner_id
  WHERE e.event='ready' AND c.provider='box'`;
 return rows.map((row:any)=>{
  const start=new Date(row.occurred_at).getTime(),next=row.next_ready_at?new Date(row.next_ready_at).getTime():Infinity;
  const internal=row.internal_archive_at?new Date(row.internal_archive_at).getTime():Infinity;
  const observed=row.observed_archive_at?new Date(row.observed_archive_at).getTime():Infinity;
  // Only our own durable archive closes an interval at an exact time. A subsequent ready alone
  // says nothing about when the old Box stopped; it uses the historical confirmation bound.
  const exact=internal<=next?internal:Infinity;
  const confirmed=row.last_alive_at?new Date(row.last_alive_at).getTime():start;
  const expiry=row.archive_after?new Date(row.archive_after).getTime():Infinity;
  // Existing closed intervals predate observation and retain their durable archive time.
  // For observed cycles, a late internal archive may merely have found an already stopped Box.
  const internalEnd=row.observation_id&&exact-confirmed>BOX_OBSERVATION_MAX_GAP_MS?Math.min(exact,confirmed,expiry):exact;
  const end=Math.max(start,Math.min(now.getTime(),next,observed,Number.isFinite(exact)?internalEnd:Math.min(confirmed,expiry)));
  const gaps=(row.gaps as [string,string][]).map(([from,to]):[number,number]=>[Math.max(start,new Date(from).getTime()),Math.min(end,new Date(to).getTime())]).filter(([from,to])=>to>from).sort((a,b)=>a[0]-b[0]);
  const segments:[number,number][]=[];let through=start;
  for(const [from,to] of gaps){if(from>through)segments.push([through,from]);through=Math.max(through,to);}
  if(end>through)segments.push([through,end]);
  const milliseconds=segments.reduce((sum,[from,to])=>sum+to-from,0);
  return {...row,segments,seconds:Math.floor(milliseconds/1000),closed:Number.isFinite(Math.min(exact,observed,next)),ended_at:new Date(end)};
 });
}
/** Tenant software-build Boxes only. Operator distribution-build Boxes have no row here. */
export async function billableSoftwareBuildIntervals(sql:any=db){
 const rows=await sql`SELECT id,build_id,owner_id,ready_at,last_observed_at,ended_at,end_reason
  FROM portable_software_usage_intervals ORDER BY ready_at,id`;
 return rows.map((row:any)=>{
  const start=new Date(row.ready_at),end=new Date(row.ended_at??row.last_observed_at);
  return {...row,segments:[[start.getTime(),end.getTime()]] as [number,number][],seconds:Math.max(0,Math.floor((end.getTime()-start.getTime())/1000)),
   closed:!!row.ended_at,ended_at:end};
 });
}

async function recordBoxInterval(interval:any,prefix:string,companionId?:string){
 const seconds=interval.seconds;
 const [{count}]=await db`SELECT count(*)::int AS count FROM usage_ledger WHERE owner_id=${interval.owner_id} AND operation_id LIKE ${prefix+'%'}`;
 // Complete minutes while active; checkpoint the final partial minute only after confirmed closure.
 const buckets=interval.closed?Math.ceil(seconds/60):Math.floor(seconds/60);
 for(let bucket=count;bucket<Math.min(buckets,count+100);bucket++){
  const quantity=Math.min(60,seconds-bucket*60);if(quantity<=0)continue;
  let remaining=(bucket*60+quantity)*1000,occurredAt=interval.ended_at;
  for(const [from,to] of interval.segments){if(remaining<=to-from){occurredAt=new Date(from+remaining);break;}remaining-=to-from;}
  await recordUsage({operationId:`${prefix}${bucket}`,ownerId:interval.owner_id,...(companionId?{companionId}:{}),category:'box_seconds',quantity,unit:'second',occurredAt,
   metadata:companionId?{}:{softwareBuildId:interval.build_id}});
 }
}
/** Stable response-root IDs ensure native steering is counted once. No model request is made here. */
export async function recordCompletedUsage(){
 const runs=await db`SELECT r.id,r.companion_id,c.owner_id,r.usage,r.finished_at FROM runs r JOIN companions c ON c.id=r.companion_id
  WHERE r.status IN ('succeeded','failed','interrupted','cancelled') AND r.usage IS NOT NULL
  AND (r.response_root_id IS NULL OR r.response_root_id=r.id)
  AND NOT EXISTS(SELECT 1 FROM usage_ledger u WHERE u.owner_id=c.owner_id AND u.operation_id='model:'||r.id::text) LIMIT 100`;
 for(const run of runs){
  const usage=run.usage;const quantity=Number(usage.totalTokens);
  if(!Number.isSafeInteger(quantity)||quantity<=0)continue;
  await recordUsage({operationId:'model:'+run.id,ownerId:run.owner_id,companionId:run.companion_id,category:'model_tokens',quantity,unit:'token',occurredAt:run.finished_at,metadata:{estimatedCostUsd:Number(usage.costUsd)||0}});
 }
 const intervals=await billableBoxIntervals();
 for(const interval of intervals)await recordBoxInterval(interval,`box-time:${interval.id}:`,interval.companion_id);
 for(const interval of await billableSoftwareBuildIntervals())await recordBoxInterval(interval,`software-box-time:${interval.id}:`);
 const owners=await db`SELECT DISTINCT owner_id FROM usage_ledger WHERE stripe_delivery_status='pending' LIMIT 20`;
 for(const owner of owners)await flushPendingUsage(owner.owner_id,20);
}
