import {ManagedBaseImageCoordinator} from './managed-base-image';
import {runtimeUpdateMachine} from "./runtime-updates";
import { SoftwareBuildCoordinator, type SoftwareRuntimeHooks } from './software-runtime';
import {specialistConfigurationInstructions} from './specialist-drafts';
import {tracePreparation} from './preparation-trace';
import {BoxObserver} from './box-observation';
import { db, migrateForService } from "./store";
import { config, encrypt, decrypt } from "./config";
import { mintModelGatewayToken } from './model-gateway-token';
import { prepareLocal, agentRequest, ExecutionStopped } from "./machines";
import { SQL, type ReservedSQL } from "bun";
import {z} from "zod";
import { scheduleDueRoutines } from "./automations";
import { progressLifecycle, ownerMayStartWork, SUBSCRIPTION_REQUIRED, type LifecycleHooks, type LifecycleMachines } from "./lifecycle";

// A reserved PostgreSQL session owns the lock; detached checkpoints carry its captured PID.
// A lost connection stops this executor; another process reconciles the durable journal.
export async function acquireExecutor() {
  await migrateForService();
  const sql = await db.reserve();
  const [result] = await sql`SELECT pg_try_advisory_lock(721440139) AS locked`;
  if (!result.locked) { sql.release(); return null; }
  return sql;
}
export interface ExecutorWaitOptions {
  signal?:AbortSignal;
  retryMs?:number;
  acquire?:typeof acquireExecutor;
  onWaiting?():void;
}
/** A rolling replacement stays inert until the previous process releases leadership. */
export async function waitForExecutor(options:ExecutorWaitOptions={}):Promise<ReservedSQL|null>{
 const signal=options.signal,retryMs=options.retryMs??2_000,acquire=options.acquire??acquireExecutor;
 if(!Number.isFinite(retryMs)||retryMs<10)throw new Error('Invalid executor retry delay');
 let announced=false;
 while(!signal?.aborted){
  const sql=await acquire();
  if(sql){
   if(!signal?.aborted)return sql;
   await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();return null;
  }
  if(!announced){announced=true;options.onWaiting?.();}
  const continued=await new Promise<boolean>(resolve=>{
   const timer=setTimeout(()=>finish(true),retryMs);
   const aborted=()=>finish(false);
   function finish(value:boolean){clearTimeout(timer);signal?.removeEventListener('abort',aborted);resolve(value);}
   signal?.addEventListener('abort',aborted,{once:true});
   if(signal?.aborted)finish(false);
  });
  if(!continued)return null;
 }
 return null;
}
function routinePublicationInstructions(mode: string) {
  if (mode === "always") return "Routine publication policy: every successful final answer is automatically posted to the main conversation. Write the final answer for the user; publish_to_chat is optional.";
  if (mode === "silent") return "Routine publication policy: results stay in this task's history. Do not call publish_to_chat; publication requests are suppressed. You can still ask the human a necessary question.";
  return "Routine publication policy: call publish_to_chat only if the result is useful to the user according to the routine's instructions. Otherwise the final answer stays in task history.";
}
async function settle(sql: any, run: any, status: string, text: string | null, error: string | null,
  rootId = run.id, publishToChat = false, leaderPid?:number) {
  publishToChat = status === "succeeded" && !!text && (run.publication_mode === "silent" ? false : run.publication_mode === "always" || publishToChat);
  await sql`WITH settled AS (
    UPDATE runs SET status=${status},error=${error},finished_at=now(),result_text=${text},publish_to_chat=${publishToChat},
      response_root_id=COALESCE((SELECT id FROM runs root WHERE root.id=${rootId} AND root.companion_id=${run.companion_id}),id)
      WHERE id=${run.id} AND status IN ('preparing','running','needs_input')
      AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=COALESCE(${leaderPid??null}::int,pg_backend_pid()) AND objid=721440139 AND granted)
      RETURNING id,companion_id,lane,message_version
  ) INSERT INTO messages (id,companion_id,run_id,role,content)
    SELECT ${crypto.randomUUID()}::uuid,companion_id,id,'assistant',${text ?? ""} FROM settled
      WHERE ${!!text} AND (lane<>'main' OR message_version IS NULL) AND (lane='main' OR (${publishToChat} AND ${status}='succeeded'))
    ON CONFLICT(run_id,role,sequence) DO NOTHING`;
}

const messageSnapshotShape=z.object({
 messageVersion:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 messages:z.array(z.object({sequence:z.number().int().positive().max(2147483647),text:z.string(),createdAt:z.string().datetime(),complete:z.boolean()}))
}).refine(value=>new Set(value.messages.map(message=>message.sequence)).size===value.messages.length);
const usageShape=z.object({input:z.number().finite().nonnegative(),output:z.number().finite().nonnegative(),cacheRead:z.number().finite().nonnegative(),cacheWrite:z.number().finite().nonnegative(),totalTokens:z.number().finite().nonnegative(),costUsd:z.number().finite().nonnegative()});
/** Steering siblings share one response root; its measured usage is stored only once. */
export async function persistObservation(sql:any,run:any,result:any,leaderPid?:number){
 if(!result)return;
 const rootId=result.responseRootId??run.response_root_id??run.id;
 if(rootId!==run.id){
  // This also repairs the projection when the PUT acknowledgment was lost.
  await sql`UPDATE runs r SET response_root_id=root.id,model_provider=root.model_provider,model_id=root.model_id,usage_source=root.usage_source
   FROM runs root WHERE r.id=${run.id} AND root.id=${rootId} AND root.companion_id=r.companion_id AND r.companion_id=${run.companion_id}
   AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=COALESCE(${leaderPid??null}::int,pg_backend_pid()) AND objid=721440139 AND granted)`;
  return;
 }
 // Persist the whole observed snapshot atomically. Stable sequence numbers make polling
 // and recovery idempotent; the revision fences late observations from shrinking text.
 const snapshot=messageSnapshotShape.safeParse(result);
 if(snapshot.success){
  const {messageVersion,messages}=snapshot.data;
  await sql`WITH observed AS (
   UPDATE runs SET message_version=${messageVersion}
   WHERE id=${run.id} AND companion_id=${run.companion_id}
    AND (message_version IS NULL OR message_version<${messageVersion})
    AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=COALESCE(${leaderPid??null}::int,pg_backend_pid()) AND objid=721440139 AND granted)
   RETURNING id,companion_id,lane
  ) INSERT INTO messages(id,companion_id,run_id,role,sequence,content,created_at,complete)
   SELECT gen_random_uuid(),observed.companion_id,observed.id,'assistant',item.sequence,item.text,item."createdAt",item.complete
   FROM observed CROSS JOIN jsonb_to_recordset(${messages}::jsonb)
    AS item(sequence integer,text text,"createdAt" timestamptz,complete boolean)
   WHERE observed.lane='main' AND length(item.text)>0
   ON CONFLICT(run_id,role,sequence) DO UPDATE SET content=EXCLUDED.content,complete=EXCLUDED.complete
    WHERE NOT messages.complete AND (messages.content,messages.complete) IS DISTINCT FROM (EXCLUDED.content,EXCLUDED.complete)`;
 }
 const warning=typeof result.initWarning==='string'?result.initWarning.slice(0,2000):null;
 const thinking=typeof result.thinkingText==='string'?result.thinkingText.slice(0,20_000):null;
 const preview=typeof result.previewText==='string'?result.previewText.slice(0,20_000):null;
 const parsed=usageShape.safeParse(result.usage);const usage=parsed.success?parsed.data:null;
 if(preview===null&&usage===null&&warning===null&&thinking===null)return;
 await sql`UPDATE runs SET thinking_text=COALESCE(${thinking},thinking_text),init_warning=COALESCE(${warning},init_warning),preview_text=COALESCE(${preview},preview_text),usage=COALESCE(${usage},usage)
   WHERE id=${run.id} AND companion_id=${run.companion_id}
   AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=COALESCE(${leaderPid??null}::int,pg_backend_pid()) AND objid=721440139 AND granted)`;
}

export interface RunExecution {
 assertActive():Promise<void>;
 requestAgent:typeof agentRequest;
 checkpoint<T>(body:(tx:any)=>Promise<T>,requireActive?:boolean):Promise<T>;
}
/** Every detached job carries the captured leader, never a pooled connection's identity. */
export function runExecution(run:any,leaderPid:number):RunExecution {
 async function assertLeader(sql:any=db){
  const [lock]=await sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=${leaderPid} AND objid=721440139 AND granted) AS owned`;
  if(!lock.owned)throw new ExecutionStopped('Executor ownership lost');
 }
 async function check(sql:any=db,generation=false){
  const [state]=await sql`SELECT c.id,c.endpoint_secret,c.box_id,EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=${leaderPid} AND objid=721440139 AND granted) AS owned
   FROM companions c WHERE c.id=${run.companion_id} AND c.owner_id=${run.owner_id} AND c.retired_at IS NULL AND c.archive_requested_at IS NULL AND c.runtime_update_status NOT IN ('updating','blocked')`;
  if(!state?.owned||generation&&((run.endpoint_secret&&state.endpoint_secret!==run.endpoint_secret)||(run.box_id&&state.box_id!==run.box_id)))throw new ExecutionStopped('Execution authority changed');
 }
 return {assertActive:()=>check(db,true),
  async requestAgent(...args){await check(db,true);return agentRequest(...args);},
  async checkpoint(body,requireActive=true){return db.begin(async tx=>{const guard=requireActive?check:assertLeader;await guard(tx);const value=await body(tx);await guard(tx);return value;});}
 };
}
export interface ExecutorHooks {
  software?: SoftwareRuntimeHooks;
  canStartWork?(ownerId: string): Promise<boolean>;
  lifecycle?: LifecycleHooks;
  /** Test boundary; production uses the sole machine adapter. */
  lifecycleMachines?: LifecycleMachines;
  /** Collect the final immutable outbox after the daemon has completed the request. */
  beforeSettle?(run: any, endpoint: string, token: string,execution?:RunExecution): Promise<void>;
  /** Stage configuration/files after machine readiness, before durable dispatch intent. */
  prepareRun?(run: any, endpoint: string, token: string,execution?:RunExecution): Promise<void>;
  /** Reconcile durable product-tool requests while an agent waits for its result. */
  observeRun?(run: any, endpoint: string, token: string,execution?:RunExecution): Promise<void>;
  /** Upload integrations can defer dispatch until the accepted file count is ready. */
  canPrepareRun?(run: any): Promise<boolean>;
}

export async function claimQueuedRuns(sql: ReservedSQL) {
  // Main sends keep their durable IDs but join Pi's native active response. Only preparation
  // is serialized per lane; background always keeps one exclusive execution slot.
  await sql`WITH available AS (
    SELECT id FROM companions WHERE retired_at IS NULL AND archive_requested_at IS NULL
     AND runtime_update_status NOT IN ('updating','blocked') FOR UPDATE SKIP LOCKED
   ) UPDATE runs r SET status='preparing',started_at=COALESCE(started_at,now()) WHERE r.id IN (
    SELECT DISTINCT ON (q.companion_id,q.lane) q.id FROM runs q WHERE (q.status='queued' OR (q.status='needs_input' AND q.resume_requested_at IS NOT NULL))
      AND EXISTS (SELECT 1 FROM available c WHERE c.id=q.companion_id)
      AND NOT EXISTS (SELECT 1 FROM machine_admission_requests m WHERE m.companion_id=q.companion_id AND m.state IN ('queued','cancelling'))
      AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.companion_id=q.companion_id AND a.lane=q.lane
        AND (a.status='preparing' OR (q.lane='background' AND a.status='running')))
      AND NOT EXISTS (SELECT 1 FROM runs a WHERE q.lane='main' AND a.companion_id=q.companion_id AND a.lane='main'
        AND a.status IN ('running','needs_input') AND (a.project_id IS DISTINCT FROM q.project_id
          OR a.design_context->'project'->>'revision' IS DISTINCT FROM q.design_context->'project'->>'revision'))
    ORDER BY q.companion_id,q.lane,COALESCE(q.resume_requested_at,q.created_at),q.id)
    AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted)`;
}
export async function tick(sql: ReservedSQL, hooks: ExecutorHooks = {}, lifecycle?:LifecycleCoordinator,coordinator?:RunCoordinator) {
  const [ownership] = await sql`SELECT pg_backend_pid() AS pid,EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted) AS owned`;
  if (!ownership.owned) throw new Error("Executor ownership lost");
  await scheduleDueRoutines(sql);
  // Accepted work retains a visible denial. Previously dispatched requests continue through
  // journal reconciliation, cancellation, output harvest and human-answer resumption.
  for(const owner of await sql`SELECT DISTINCT c.owner_id FROM runs r JOIN companions c ON c.id=r.companion_id WHERE NOT r.dispatched AND r.status IN ('queued','preparing')`){
    if(!await (hooks.canStartWork??ownerMayStartWork)(owner.owner_id)){
      await sql`UPDATE runs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,error=CASE WHEN cancel_requested THEN NULL ELSE ${SUBSCRIPTION_REQUIRED} END,finished_at=now() WHERE NOT dispatched AND status IN ('queued','preparing') AND companion_id IN (SELECT id FROM companions WHERE owner_id=${owner.owner_id})`;
    }
  }
  await claimQueuedRuns(sql);
  // Accepted work routes wake intent through lifecycle before any prompt. A native steer or
  // another lane on an already active daemon reuses that machine without restarting it.
  await sql`UPDATE companions c SET prepare_requested=true WHERE c.retired_at IS NULL AND c.archive_requested_at IS NULL
    AND NOT c.prepare_requested
    AND NOT EXISTS(SELECT 1 FROM machine_admission_requests m WHERE m.companion_id=c.id AND m.state IN ('queued','cancelling'))
    AND EXISTS(SELECT 1 FROM runs r WHERE r.companion_id=c.id AND r.status='preparing' AND NOT r.dispatched AND (c.endpoint_secret IS NULL OR c.status<>'ready' OR c.archived_at IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.companion_id=c.id AND r.dispatched AND r.status IN ('running','preparing','needs_input'))`;
  if(lifecycle)await lifecycle.schedule(sql,hooks);
  else await progressLifecycle(sql, {...hooks.lifecycle,canStartWork:hooks.canStartWork??hooks.lifecycle?.canStartWork??ownerMayStartWork}, hooks.lifecycleMachines);
  const runs = await sql`SELECT r.id,r.companion_id,r.client_message_id,r.content,r.status,r.dispatched,r.cancel_requested,r.error,r.created_at,r.started_at,r.finished_at,r.prepared_at,r.lane,r.source,r.response_root_id,r.result_text,r.publish_to_chat,r.routine_id,r.routine_name,r.publication_mode,r.scheduled_for,r.resume_requested_at,r.attachment_count,r.project_id,r.design_context,c.provider,c.box_id,c.create_key,c.create_started_at,c.preparation_started_at,c.agent_secret,c.endpoint_secret,c.instructions,c.specialist_draft_id,c.init_script,c.config_digest,c.snapshot_name,c.template_id,c.template_revision,c.model_id,c.owner_id
    FROM runs r JOIN companions c ON c.id=r.companion_id WHERE r.status IN ('preparing','running','needs_input') AND c.retired_at IS NULL AND c.archive_requested_at IS NULL ORDER BY r.created_at`;
  const progressSql=coordinator?db:sql;
  const groups=[...Map.groupBy(runs as any[],run=>`${run.companion_id}:${runJobKind(run)}`).entries()];
  async function progressGroup(group:any[]){
   for(const original of group){
    const [current]=await progressSql`SELECT c.endpoint_secret,c.config_digest,c.box_id,c.create_started_at,c.preparation_started_at,c.prepare_requested,c.desktop_taken,c.desktop_paused_at,c.retired_at,c.archive_requested_at,r.status,r.dispatched,r.cancel_requested,r.response_root_id,r.prepared_at
      FROM companions c JOIN runs r ON r.companion_id=c.id WHERE r.id=${original.id} AND r.status IN ('preparing','running','needs_input')`;
    if(!current||current.retired_at||current.archive_requested_at)continue;
    await progressRun({...original,...current});
   }
  }
  if(coordinator)coordinator.schedule(groups,progressGroup);
  else for(let offset=0;offset<groups.length;offset+=8)await Promise.all(groups.slice(offset,offset+8).map(([,group])=>progressGroup(group)));

  async function progressRun(run: any) {
      const sql:any=progressSql,leaderPid=ownership.pid;
      const execution=runExecution(run,leaderPid);
      const request=execution.requestAgent;
      const finish=(status:string,text:string|null,error:string|null,rootId=run.id,publish=false)=>settle(sql,run,status,text,error,rootId,publish,leaderPid);
      await execution.assertActive();
      const age = Date.now() - new Date(run.started_at).getTime();
      const executionAge=()=>Date.now()-new Date(run.prepared_at??run.started_at).getTime();
      const token = decrypt(run.agent_secret);
      if (run.cancel_requested && !run.dispatched) { await finish("cancelled", null, null); return; }
      try {
        let endpoint = run.endpoint_secret ? decrypt(run.endpoint_secret) : null;
        if (run.status === "preparing" && run.dispatched) {
          // A replied-to task reserves the normal FIFO slot before its blocked Pi tool receives
          // the answer. Resume only observes/toggles the existing request, never PUTs a prompt.
          if (!endpoint) { await finish("interrupted", null, "The waiting task lost its execution endpoint. It was not replayed."); return; }
          if (executionAge() > 2 * 3600_000 || run.cancel_requested) {
            await request(endpoint, token, `/runs/${run.id}/cancel`, "POST");
            await finish(run.cancel_requested ? "cancelled" : "interrupted", null, run.cancel_requested ? null : "Task deadline reached. It was not replayed.");
            return;
          }
          const result = await request(endpoint, token, `/runs/${run.id}`);
          await persistObservation(sql,run,result,leaderPid);
          if (!result) { await finish("interrupted", null, "The waiting task could not be confirmed. It was not replayed."); return; }
          if (["succeeded", "failed", "cancelled", "interrupted"].includes(result.status)) {
            await hooks.beforeSettle?.(run, endpoint, token,execution);
            await finish(result.status, typeof result.text === "string" ? result.text : null,
              result.status === "interrupted" ? "The agent restarted while waiting. It was not replayed." : null,
              result.responseRootId ?? run.id, result.publishToChat === true);
            return;
          }
          if (result.status === "needs_input") {
            const health = await tracePreparation(run.companion_id,'admission_health',()=>request(endpoint!, token, "/health"),value=>value?.ready?'ready':'not_ready',run.id);
            if (run.lane === "background" && health?.activeRuns?.background && health.activeRuns.background !== run.id) return;
            const resumed = await request(endpoint, token, `/runs/${run.id}/resume`, "POST");
            if (resumed?.status !== "running") return;
          }
          await sql`UPDATE runs SET status='running',resume_requested_at=null WHERE id=${run.id} AND status='preparing'
            AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=${leaderPid} AND objid=721440139 AND granted)`;
          await hooks.observeRun?.({ ...run, status: "running", resumed: true }, endpoint, token,execution);
          return;
        }
        if (run.status === "preparing") {
          if(!await (hooks.canStartWork??ownerMayStartWork)(run.owner_id)){await finish("failed",null,SUBSCRIPTION_REQUIRED);return;}
          if (hooks.canPrepareRun && !await hooks.canPrepareRun(run)) {
            if (age > 5 * 60_000) await finish("failed", null, "File upload did not finish. Send the message again with its files.");
            return;
          }
          if (run.prepare_requested) {
            // Waiting for the shared managed image is outside this run's preparation
            // budget. Lifecycle starts its persisted clock immediately before the
            // first machine effect and enforces that deadline independently.
            if(run.preparation_started_at&&Date.now()-new Date(run.preparation_started_at).getTime()>5*60_000)await finish("failed",null,"Preparation timed out. Send a new message to retry.");
            return;
          }
          if (!endpoint) {
            await execution.checkpoint(async tx=>tx`UPDATE companions SET prepare_requested=true WHERE id=${run.companion_id}`);
            return;
          }
          if(!run.prepared_at){
            const [marked]=await execution.checkpoint(async tx=>tx`UPDATE runs SET prepared_at=COALESCE(prepared_at,now()) WHERE id=${run.id} AND status='preparing' AND NOT dispatched RETURNING prepared_at`);
            if(!marked)return;run.prepared_at=marked.prepared_at;
          }
          if(Date.now()-new Date(run.prepared_at).getTime()>5*60_000){await finish("failed",null,"Preparation timed out. Send a new message to retry.");return;}
          try {
            const health = await tracePreparation(run.companion_id,'admission_health',()=>request(endpoint!, token, "/health"),value=>value?.ready?'ready':'not_ready',run.id);
            if (!health?.ready) throw new Error("agent_not_ready");
            if(run.design_context&&health.designStudioVersion!==1){await finish('failed',null,'Design requires the updated Companion runtime.');return;}
            const active = health.activeRuns?.[run.lane] ?? (run.lane === "main" ? health.activeRunId : null);
            if (active) {
              const [prior] = await sql`SELECT status,cancel_requested FROM runs WHERE id=${active} AND companion_id=${run.companion_id}`;
              if (!prior || prior.cancel_requested || ["interrupted", "cancelled", "failed"].includes(prior.status)) {
                await request(endpoint, token, `/runs/${active}/cancel`, "POST");
                return;
              }
              if (run.lane === "background") return;
              // Main sends enter Pi's native steer path. Background never owns that session.
            }
          } catch (error) {
            if(error instanceof ExecutionStopped)throw error;
            await execution.assertActive();
            // Lifecycle already confirmed readiness. A failed probe requests repair of
            // this same Box on the next tick; healthy runs never prepare it again.
            await execution.checkpoint(async tx=>tx`UPDATE companions SET endpoint_secret=null,prepare_requested=true WHERE id=${run.companion_id}`);
            return;
          }
          await tracePreparation(run.companion_id,'run_staging',async()=>hooks.prepareRun?.(run, endpoint!, token,execution),undefined,run.id);
          if(!await (hooks.canStartWork??ownerMayStartWork)(run.owner_id)){await finish("failed",null,SUBSCRIPTION_REQUIRED);return;}
          // Cancellation may arrive during machine/file preparation. Recheck before dispatch.
          const [latest] = await sql`SELECT r.cancel_requested,c.desktop_taken,c.desktop_paused_at,c.retired_at FROM runs r JOIN companions c ON c.id=r.companion_id WHERE r.id=${run.id}`;
          if (latest?.retired_at) return;
          if (latest?.cancel_requested) { await finish("cancelled", null, null); return; }
          // Persist intent before the network side effect. Recovery only observes this id.
          const useGateway=!config.testMode&&!!config.modelGatewayUrl;
          const selectedModel=run.model_id??config.modelId;
          const [dispatch] = await sql`UPDATE runs SET status='running',dispatched=true,prepared_at=COALESCE(prepared_at,now()),
            model_provider=${config.testMode?'companion-test':config.modelProvider},model_id=${config.testMode?'scripted':selectedModel},usage_source=${useGateway?'gateway':'agent'}
            WHERE id=${run.id} AND status='preparing' AND NOT cancel_requested
            AND EXISTS(SELECT 1 FROM companions c WHERE c.id=runs.companion_id AND c.retired_at IS NULL AND c.archive_requested_at IS NULL AND NOT c.prepare_requested AND c.endpoint_secret=${run.endpoint_secret})
            AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=${leaderPid} AND objid=721440139 AND granted)
            RETURNING id`;
          if (!dispatch) return;
          await execution.checkpoint(async tx=>tx`UPDATE companions SET status='ready',error=null WHERE id=${run.companion_id}`);
          const accepted = await tracePreparation(run.companion_id,'admission_put',()=>request(endpoint!, token, `/runs/${run.id}`, "PUT", { content: run.content, instructions: [run.specialist_draft_id ? specialistConfigurationInstructions : run.instructions, run.source === "routine" ? routinePublicationInstructions(run.publication_mode) : ""].filter(Boolean).join("\n\n"), lane: run.lane,
            ...(run.design_context?{designContext:run.design_context}:{}),
            ...(run.init_script?{initScript:run.init_script,initTimeoutMs:600_000}:{}),
            ...(run.model_id ? {modelId: run.model_id} : {}),
            ...(useGateway?{modelGateway:{token:mintModelGatewayToken(run.companion_id,run.id,run.agent_secret,undefined,run.endpoint_secret)}}:{}) }),undefined,run.id);
          if (accepted?.responseRootId) {
            await execution.checkpoint(async tx=>tx`UPDATE runs SET response_root_id=(SELECT id FROM runs root WHERE root.id=${accepted.responseRootId} AND root.companion_id=${run.companion_id}) WHERE id=${run.id}`);
            // Pi's native steer joins the root's existing model session. A changed selection
            // applies to the next response root, never retroactively to this shared reply.
            await execution.checkpoint(async tx=>tx`UPDATE runs r SET model_provider=root.model_provider,model_id=root.model_id,usage_source=root.usage_source
              FROM runs root WHERE r.id=${run.id} AND root.id=r.response_root_id AND root.companion_id=r.companion_id AND root.id<>r.id`);
          }
          return;
        }
        if (!endpoint) { await finish("interrupted", null, "Execution endpoint was lost. The task was not replayed."); return; }
        await hooks.observeRun?.(run, endpoint, token,execution);
        if (run.cancel_requested) await request(endpoint, token, `/runs/${run.id}/cancel`, "POST");
        const result = await request(endpoint, token, `/runs/${run.id}`);
          await persistObservation(sql,run,result,leaderPid);
        if (!result) { await finish("interrupted", null, "Execution could not be confirmed. The task was not replayed."); return; }
        if (["succeeded", "failed", "interrupted", "cancelled"].includes(result.status)) {
          await hooks.beforeSettle?.(run, endpoint, token,execution);
          await finish(result.status, typeof result.text === "string" ? result.text : null,
            result.status === "failed" ? "The agent could not complete this task." : result.status === "interrupted" ? "The agent restarted during this task. It was not replayed." : null,
            result.responseRootId ?? run.id, result.publishToChat === true);
        } else if (executionAge() > 2 * 3600_000) {
          await request(endpoint, token, `/runs/${run.id}/cancel`, "POST");
          await finish("interrupted", null, "Task deadline reached. It was not replayed.");
        } else if (result.status === "needs_input") {
          await sql`UPDATE runs SET status='needs_input' WHERE id=${run.id} AND status='running'
            AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=${leaderPid} AND objid=721440139 AND granted)`;
        }
      } catch (error) {
        if (error instanceof SQL.SQLError || error instanceof ExecutionStopped) throw error;
        await execution.assertActive();
        if (run.dispatched && run.provider === "local") {
          // Docker assigns a new host port after restart. Reconnect to the SAME durable
          // daemon journal; never redispatch the request while repairing transport.
          try {
            const endpoint = await prepareLocal({ ...run, id: run.companion_id }, false,execution.assertActive);
            await execution.checkpoint(async tx=>tx`UPDATE companions SET endpoint_secret=${encrypt(endpoint)} WHERE id=${run.companion_id}`);
          } catch (repairError) { if (repairError instanceof SQL.SQLError || repairError instanceof ExecutionStopped) throw repairError; }
        }
        // Network failures stay observable and bounded. Never include provider payloads.
        const stalledAge=run.prepared_at?executionAge():age;
        if (stalledAge > (!run.dispatched ? 5 * 60_000 : 10 * 60_000)) {
          await finish(run.dispatched ? "interrupted" : "failed", null, "The machine did not respond. This task was not replayed.");
          await execution.checkpoint(async tx=>tx`UPDATE companions SET status='error',error='Machine unavailable.',endpoint_secret=null WHERE id=${run.companion_id}`);
        }
      }
  }
}
const runJobKind=(run:any)=>run.lane==='background'?'background':run.status==='preparing'?'main_admission':'main_observation';
/** Network waits never hold the admission loop or a reserved SQL connection. Main admission
 * has its own slots so a slow observation cannot hold a native steer on the same Companion. */
export class RunCoordinator {
 private jobs=new Map<string,{promise:Promise<void>;ids:string[];kind:string}>();
 private lastScheduled=new Map<string,number>();
 private sequence=0;
 private closing=false;
 get activeCount(){return this.jobs.size;}
 schedule(groups:[string,any[]][],progress:(group:any[])=>Promise<void>){
  if(this.closing)return;
  const pending=new Set(groups.map(([key])=>key));
  const activeIds=new Set([...this.jobs.values()].flatMap(job=>job.ids));
  for(const key of this.lastScheduled.keys())if(!pending.has(key)&&!this.jobs.has(key))this.lastScheduled.delete(key);
  for(const [key,candidates] of groups.sort((a,b)=>(this.lastScheduled.get(a[0])??0)-(this.lastScheduled.get(b[0])??0))){
   const kind=runJobKind(candidates[0]);
   if(this.jobs.has(key)||[...this.jobs.values()].filter(job=>job.kind===kind).length>=8)continue;
   const group=candidates.filter(run=>!activeIds.has(run.id));if(!group.length)continue;
   this.lastScheduled.set(key,++this.sequence);
   const ids=group.map(run=>run.id);for(const id of ids)activeIds.add(id);
   const promise=progress(group).catch(error=>{if(!(error instanceof ExecutionStopped))console.error('run_progress_failed');}).finally(()=>{this.jobs.delete(key);});
   this.jobs.set(key,{promise,ids,kind});
  }
 }
 async close(){this.closing=true;await Promise.allSettled([...this.jobs.values()].map(job=>job.promise));}
}
/** Cold machines progress outside the chat loop. Each job owns a separate SQL connection;
 * its checkpoints are fenced by the still-live leader PID, never by a pooled connection.
 * Four jobs leave connections available for product authorization and file persistence. */
export class LifecycleCoordinator {
 private jobs=new Map<string,Promise<void>>();
 private closing=false;
 private cursor:string|null=null;
 private leaderPid:number|null=null;
 constructor(private database=db){}
 get activeCount(){return this.jobs.size;}
 async schedule(leader:ReservedSQL,hooks:ExecutorHooks={}){
  if(this.closing)return;
  const [identity]=await leader`SELECT pg_backend_pid() AS pid,EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted) AS owned`;
  if(!identity.owned||(this.leaderPid!==null&&this.leaderPid!==identity.pid))throw Error('Executor ownership lost');
  this.leaderPid=identity.pid;
  const targetRuntime=runtimeUpdateMachine()?.release.id??null;
  const pending=await leader`SELECT c.id FROM companions c WHERE
   EXISTS(SELECT 1 FROM runtime_updates u WHERE u.companion_id=c.id AND u.finished_at IS NULL)
   OR (${targetRuntime}::text IS NOT NULL AND c.provider='box' AND c.box_id IS NOT NULL AND c.status='ready' AND c.archived_at IS NULL AND c.retired_at IS NULL AND NOT c.temporary AND c.specialist_draft_id IS NULL
    AND (c.runtime_update_target IS DISTINCT FROM ${targetRuntime} OR (c.runtime_update_status IN ('pending','deferred') AND (c.runtime_update_checked_at IS NULL OR c.runtime_update_checked_at<now()-interval '5 minutes'))))
   OR
   (c.retired_at IS NULL AND (c.prepare_requested OR ((c.desktop_boundary_version=1 OR c.desktop_taken) AND c.status='ready' AND c.endpoint_secret IS NOT NULL AND (c.desktop_checked_at IS NULL OR c.desktop_checked_at<now()-interval '30 seconds' OR (c.desktop_observed_generation IS DISTINCT FROM c.desktop_generation AND c.desktop_checked_at<now()-interval '2 seconds'))) OR c.archive_requested_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM machine_admission_requests m WHERE m.companion_id=c.id AND m.state IN ('queued','cancelling'))
    OR ((c.temporary OR c.specialist_draft_id IS NOT NULL) AND c.archived_at IS NULL AND EXISTS(SELECT 1 FROM machine_admission_requests m WHERE m.owner_id=c.owner_id AND m.state='queued' AND m.waiting_reason='active_limit'))
    OR (c.status='ready' AND c.prepare_requested=false AND NOT c.desktop_taken AND COALESCE(c.keep_alive_until,'-infinity')<=now()
      AND COALESCE(c.machine_activity_at,c.ready_at,c.created_at)<=now()-interval '30 minutes')
    OR ((c.temporary OR c.specialist_draft_id IS NOT NULL) AND c.box_id IS NOT NULL AND c.archived_at IS NULL AND (c.provider_ttl_checked_at IS NULL OR c.provider_ttl_checked_at<now()-interval '15 minutes') AND (c.keep_alive_until>now() OR EXISTS(SELECT 1 FROM runs active WHERE active.companion_id=c.id AND active.dispatched AND active.status='running')))
    OR EXISTS(SELECT 1 FROM specialist_operations o JOIN specialist_drafts d ON d.template_id=o.template_id WHERE d.companion_id=c.id AND o.status IN ('queued','freezing','capturing','preparing','running'))
    OR EXISTS(SELECT 1 FROM template_candidates t WHERE t.source_companion_id=c.id AND t.status IN ('queued','capturing','ready'))
    OR EXISTS(SELECT 1 FROM delegations d JOIN runs r ON r.id=d.run_id WHERE d.target_id=c.id AND d.finished_at IS NULL AND r.status IN ('succeeded','failed','interrupted','cancelled'))))
   OR (c.retired_at IS NOT NULL AND c.archive_requested_at IS NOT NULL AND (c.archived_at IS NULL OR c.archived_at<c.archive_requested_at))
   OR EXISTS(SELECT 1 FROM machine_usage_events e WHERE e.companion_id=c.id AND e.reported_at IS NULL)
   ORDER BY CASE WHEN ${this.cursor}::uuid IS NULL OR c.id>${this.cursor}::uuid THEN 0 ELSE 1 END,c.id LIMIT 100`;
  // Rotate before LIMIT, so persistent old intents cannot exclude later computers.
  for(const companion of pending){
   if(this.jobs.size>=4)break;
   if(this.jobs.has(companion.id))continue;
   this.cursor=companion.id;
   const job=this.progress(companion.id,identity.pid,hooks).catch(()=>{console.error('lifecycle_progress_failed');}).finally(()=>{this.jobs.delete(companion.id);});
   this.jobs.set(companion.id,job);
  }
 }
 private async progress(companionId:string,leaderPid:number,hooks:ExecutorHooks){
  const sql=await this.database.reserve();
  try{await progressLifecycle(sql,{...hooks.lifecycle,canStartWork:hooks.canStartWork??hooks.lifecycle?.canStartWork??ownerMayStartWork},hooks.lifecycleMachines,{companionId,leaderPid});}
  finally{sql.release();}
 }
 async close(){this.closing=true;await Promise.allSettled([...this.jobs.values()]);}
}

if (import.meta.main) {
  const shutdown=new AbortController();
  const stop=()=>shutdown.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
  const sql = await waitForExecutor({signal:shutdown.signal,onWaiting:()=>console.log("Executor waiting for leadership")});
  if (!sql) { await db.close(); process.exit(0); }
  console.log("Executor ready");
  const { productHooks } = await import("./runtime-product");
  const baseImage=new ManagedBaseImageCoordinator();
  const lifecycle=new LifecycleCoordinator();
  const observations=new BoxObserver();
  const runs=new RunCoordinator();
  const software=new SoftwareBuildCoordinator();
  try { while(!shutdown.signal.aborted) { await baseImage.schedule(sql); if(productHooks.software)await software.schedule(sql,productHooks.software); await observations.schedule(sql); await tick(sql, productHooks,lifecycle,runs); await Bun.sleep(500); } }
  finally { await Promise.allSettled([baseImage.close(),lifecycle.close(),observations.close(),runs.close(),software.close()]); sql.release(); await db.close(); }
}
