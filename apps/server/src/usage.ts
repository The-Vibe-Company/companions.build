import {db} from './store';
import {recordUsage,flushPendingUsage} from './billing';
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
 const intervals=await db`SELECT e.id,e.companion_id,e.owner_id,e.occurred_at,
  (SELECT min(a.occurred_at) FROM machine_usage_events a WHERE a.companion_id=e.companion_id AND a.event IN ('archived','ready') AND a.occurred_at>e.occurred_at) AS ended_at
  FROM machine_usage_events e JOIN companions c ON c.id=e.companion_id WHERE e.event='ready' AND c.provider='box'`;
 for(const interval of intervals){
  const start=new Date(interval.occurred_at).getTime();const end=interval.ended_at?new Date(interval.ended_at).getTime():Date.now();
  const seconds=Math.max(0,Math.floor((end-start)/1000));
  const [{count}]=await db`SELECT count(*)::int AS count FROM usage_ledger WHERE owner_id=${interval.owner_id} AND operation_id LIKE ${'box-time:'+interval.id+':%'}`;
  // Complete minutes while running; checkpoint the final partial minute only after archive.
  const buckets=interval.ended_at?Math.ceil(seconds/60):Math.floor(seconds/60);
  for(let bucket=count;bucket<Math.min(buckets,count+100);bucket++){
   const quantity=Math.min(60,seconds-bucket*60);if(quantity<=0)continue;
   await recordUsage({operationId:`box-time:${interval.id}:${bucket}`,ownerId:interval.owner_id,companionId:interval.companion_id,category:'box_seconds',quantity,unit:'second',occurredAt:new Date(start+(bucket*60+quantity)*1000)});
  }
 }
 const owners=await db`SELECT DISTINCT owner_id FROM usage_ledger WHERE stripe_delivery_status='pending' LIMIT 20`;
 for(const owner of owners)await flushPendingUsage(owner.owner_id,20);
}
