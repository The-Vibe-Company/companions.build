import { db, migrate } from "./store";
import { encrypt, decrypt } from "./config";
import { prepareLocal, agentRequest } from "./machines";
import { SQL, type ReservedSQL } from "bun";
import {z} from "zod";
import { migrateAutomations, scheduleDueRoutines } from "./automations";
import { migrateLifecycle, progressLifecycle, ownerMayStartWork, SUBSCRIPTION_REQUIRED, type LifecycleHooks, type LifecycleMachines } from "./lifecycle";

// A reserved PostgreSQL session owns the lock and ALL execution checkpoints.
// A lost connection stops this executor; another process reconciles the durable journal.
export async function acquireExecutor() {
  await migrateAutomations();
  await db.begin(async tx => { await tx`SELECT pg_advisory_xact_lock(721440138)`; await migrateLifecycle(tx); });
  const sql = await db.reserve();
  const [result] = await sql`SELECT pg_try_advisory_lock(721440139) AS locked`;
  if (!result.locked) { sql.release(); return null; }
  return sql;
}
async function settle(sql: ReservedSQL, run: any, status: string, text: string | null, error: string | null,
  rootId = run.id, publishToChat = false) {
  await sql`WITH settled AS (
    UPDATE runs SET status=${status},error=${error},finished_at=now(),result_text=${text},publish_to_chat=${publishToChat},
      response_root_id=COALESCE((SELECT id FROM runs root WHERE root.id=${rootId} AND root.companion_id=${run.companion_id}),id)
      WHERE id=${run.id} AND status IN ('preparing','running','needs_input')
      AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted)
      RETURNING id,companion_id,lane
  ) INSERT INTO messages (id,companion_id,run_id,role,content)
    SELECT ${crypto.randomUUID()}::uuid,companion_id,id,'assistant',${text ?? ""} FROM settled
      WHERE ${!!text} AND (lane='main' OR (${publishToChat} AND ${status}='succeeded'))
    ON CONFLICT(run_id,role) DO NOTHING`;
}

const usageShape=z.object({input:z.number().finite().nonnegative(),output:z.number().finite().nonnegative(),cacheRead:z.number().finite().nonnegative(),cacheWrite:z.number().finite().nonnegative(),totalTokens:z.number().finite().nonnegative(),costUsd:z.number().finite().nonnegative()});
/** Steering siblings share one response root; its measured usage is stored only once. */
export async function persistObservation(sql:any,run:any,result:any){
 if(!result||(result.responseRootId??run.response_root_id??run.id)!==run.id)return;
 const preview=typeof result.previewText==='string'?result.previewText.slice(0,20_000):null;
 const parsed=usageShape.safeParse(result.usage);const usage=parsed.success?parsed.data:null;
 if(preview===null&&usage===null)return;
 await sql`UPDATE runs SET preview_text=COALESCE(${preview},preview_text),usage=COALESCE(${usage},usage)
   WHERE id=${run.id} AND companion_id=${run.companion_id}
   AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted)`;
}

export interface ExecutorHooks {
  canStartWork?(ownerId: string): Promise<boolean>;
  lifecycle?: LifecycleHooks;
  /** Test boundary; production uses the sole machine adapter. */
  lifecycleMachines?: LifecycleMachines;
  /** Collect the final immutable outbox after the daemon has completed the request. */
  beforeSettle?(run: any, endpoint: string, token: string): Promise<void>;
  /** Stage configuration/files after machine readiness, before durable dispatch intent. */
  prepareRun?(run: any, endpoint: string, token: string): Promise<void>;
  /** Reconcile durable product-tool requests while an agent waits for its result. */
  observeRun?(run: any, endpoint: string, token: string): Promise<void>;
  /** Upload integrations can defer dispatch until the accepted file count is ready. */
  canPrepareRun?(run: any): Promise<boolean>;
}

export async function claimQueuedRuns(sql: ReservedSQL) {
  // Main sends keep their durable IDs but join Pi's native active response. Only preparation
  // is serialized per lane; background always keeps one exclusive execution slot.
  await sql`UPDATE runs r SET status='preparing',started_at=COALESCE(started_at,now()) WHERE r.id IN (
    SELECT DISTINCT ON (q.companion_id,q.lane) q.id FROM runs q WHERE (q.status='queued' OR (q.status='needs_input' AND q.resume_requested_at IS NOT NULL))
      AND EXISTS (SELECT 1 FROM companions c WHERE c.id=q.companion_id AND c.retired_at IS NULL AND c.archive_requested_at IS NULL AND NOT c.desktop_taken AND c.desktop_paused_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.companion_id=q.companion_id AND a.lane=q.lane
        AND (a.status='preparing' OR (q.lane='background' AND a.status='running')))
    ORDER BY q.companion_id,q.lane,COALESCE(q.resume_requested_at,q.created_at),q.id)
    AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted)`;
}
export async function tick(sql: ReservedSQL, hooks: ExecutorHooks = {}) {
  const [ownership] = await sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted) AS owned`;
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
    AND NOT c.desktop_taken AND c.desktop_paused_at IS NULL AND NOT c.prepare_requested
    AND EXISTS(SELECT 1 FROM runs r WHERE r.companion_id=c.id AND r.status='preparing' AND NOT r.dispatched AND (c.endpoint_secret IS NULL OR c.status<>'ready' OR c.archived_at IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.companion_id=c.id AND r.dispatched AND r.status IN ('running','preparing','needs_input'))`;
  await progressLifecycle(sql, {...hooks.lifecycle,canStartWork:hooks.canStartWork??hooks.lifecycle?.canStartWork??ownerMayStartWork}, hooks.lifecycleMachines);
  const runs = await sql`SELECT r.id,r.companion_id,r.client_message_id,r.content,r.status,r.dispatched,r.cancel_requested,r.error,r.created_at,r.started_at,r.finished_at,r.prepared_at,r.lane,r.source,r.response_root_id,r.result_text,r.publish_to_chat,r.routine_id,r.scheduled_for,r.resume_requested_at,r.attachment_count,c.provider,c.box_id,c.create_key,c.create_started_at,c.agent_secret,c.endpoint_secret,c.instructions,c.config_digest,c.snapshot_name,c.template_id,c.template_revision,c.model_id,c.owner_id
    FROM runs r JOIN companions c ON c.id=r.companion_id WHERE r.status IN ('preparing','running','needs_input') AND c.retired_at IS NULL AND NOT c.desktop_taken AND c.desktop_paused_at IS NULL AND c.archive_requested_at IS NULL ORDER BY r.created_at`;
  // One machine preparation at a time per Companion; independent Companions progress in parallel.
  // Each network call only accepts/observes work, so a long Pi task does not occupy this loop.
  const grouped = Map.groupBy(runs as any[], run => run.companion_id);
  const groups = [...grouped.values()];
  for (let offset = 0; offset < groups.length; offset += 8) {
    await Promise.all(groups.slice(offset, offset + 8).map(async group => {
      for (const original of group) {
        // A preceding lane may have prepared this same machine. Reuse its latest endpoint.
        const [current] = await sql`SELECT endpoint_secret,config_digest,box_id,create_started_at,prepare_requested,desktop_taken,desktop_paused_at,retired_at,archive_requested_at FROM companions WHERE id=${original.companion_id}`;
        if (!current || current.desktop_taken || current.desktop_paused_at || current.retired_at || current.archive_requested_at) continue;
        const run = { ...original, ...current };
        await progressRun(run);
      }
    }));
  }

  async function progressRun(run: any) {
      const age = Date.now() - new Date(run.started_at).getTime();
      const token = decrypt(run.agent_secret);
      if (run.cancel_requested && !run.dispatched) { await settle(sql, run, "cancelled", null, null); return; }
      try {
        let endpoint = run.endpoint_secret ? decrypt(run.endpoint_secret) : null;
        if (run.status === "preparing" && run.dispatched) {
          // A replied-to task reserves the normal FIFO slot before its blocked Pi tool receives
          // the answer. Resume only observes/toggles the existing request, never PUTs a prompt.
          if (!endpoint) { await settle(sql, run, "interrupted", null, "The waiting task lost its execution endpoint. It was not replayed."); return; }
          if (age > 2 * 3600_000 || run.cancel_requested) {
            await agentRequest(endpoint, token, `/runs/${run.id}/cancel`, "POST");
            await settle(sql, run, run.cancel_requested ? "cancelled" : "interrupted", null, run.cancel_requested ? null : "Task deadline reached. It was not replayed.");
            return;
          }
          const result = await agentRequest(endpoint, token, `/runs/${run.id}`);
          await persistObservation(sql,run,result);
          if (!result) { await settle(sql, run, "interrupted", null, "The waiting task could not be confirmed. It was not replayed."); return; }
          if (["succeeded", "failed", "cancelled", "interrupted"].includes(result.status)) {
            await hooks.beforeSettle?.(run, endpoint, token);
            await settle(sql, run, result.status, typeof result.text === "string" ? result.text : null,
              result.status === "interrupted" ? "The agent restarted while waiting. It was not replayed." : null,
              result.responseRootId ?? run.id, result.publishToChat === true);
            return;
          }
          if (result.status === "needs_input") {
            const health = await agentRequest(endpoint, token, "/health");
            if (run.lane === "background" && health?.activeRuns?.background && health.activeRuns.background !== run.id) return;
            const resumed = await agentRequest(endpoint, token, `/runs/${run.id}/resume`, "POST");
            if (resumed?.status !== "running") return;
          }
          await sql`UPDATE runs SET status='running',resume_requested_at=null WHERE id=${run.id} AND status='preparing'
            AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted)`;
          await hooks.observeRun?.({ ...run, status: "running", resumed: true }, endpoint, token);
          return;
        }
        if (run.status === "preparing") {
          if(!await (hooks.canStartWork??ownerMayStartWork)(run.owner_id)){await settle(sql,run,"failed",null,SUBSCRIPTION_REQUIRED);return;}
          if (hooks.canPrepareRun && !await hooks.canPrepareRun(run)) {
            if (age > 5 * 60_000) await settle(sql, run, "failed", null, "File upload did not finish. Send the message again with its files.");
            return;
          }
          if (age > 5 * 60_000) { await settle(sql, run, "failed", null, "Preparation timed out. Send a new message to retry."); return; }
          if (run.prepare_requested) return;
          if (!endpoint) {
            await sql`UPDATE companions SET prepare_requested=true WHERE id=${run.companion_id} AND NOT desktop_taken AND desktop_paused_at IS NULL`;
            return;
          }
          try {
            const health = await agentRequest(endpoint, token, "/health");
            if (!health?.ready) throw new Error("agent_not_ready");
            const active = health.activeRuns?.[run.lane] ?? (run.lane === "main" ? health.activeRunId : null);
            if (active) {
              const [prior] = await sql`SELECT status,cancel_requested FROM runs WHERE id=${active} AND companion_id=${run.companion_id}`;
              if (!prior || prior.cancel_requested || ["interrupted", "cancelled", "failed"].includes(prior.status)) {
                await agentRequest(endpoint, token, `/runs/${active}/cancel`, "POST");
                return;
              }
              if (run.lane === "background") return;
              // Main sends enter Pi's native steer path. Background never owns that session.
            }
          } catch (error) {
            // Lifecycle already confirmed readiness. A failed probe requests repair of
            // this same Box on the next tick; healthy runs never prepare it again.
            await sql`UPDATE companions SET endpoint_secret=null,prepare_requested=true WHERE id=${run.companion_id} AND NOT desktop_taken AND desktop_paused_at IS NULL`;
            return;
          }
          await hooks.prepareRun?.(run, endpoint, token);
          if(!await (hooks.canStartWork??ownerMayStartWork)(run.owner_id)){await settle(sql,run,"failed",null,SUBSCRIPTION_REQUIRED);return;}
          // Cancellation may arrive during machine/file preparation. Recheck before dispatch.
          const [latest] = await sql`SELECT r.cancel_requested,c.desktop_taken,c.desktop_paused_at,c.retired_at FROM runs r JOIN companions c ON c.id=r.companion_id WHERE r.id=${run.id}`;
          if (latest?.desktop_taken || latest?.desktop_paused_at || latest?.retired_at) return;
          if (latest?.cancel_requested) { await settle(sql, run, "cancelled", null, null); return; }
          // Persist intent before the network side effect. Recovery only observes this id.
          const [dispatch] = await sql`UPDATE runs SET status='running',dispatched=true,prepared_at=now() WHERE id=${run.id} AND status='preparing' AND NOT cancel_requested
            AND EXISTS(SELECT 1 FROM companions c WHERE c.id=runs.companion_id AND NOT c.desktop_taken AND c.desktop_paused_at IS NULL AND c.retired_at IS NULL)
            AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted)
            RETURNING id`;
          if (!dispatch) return;
          await sql`UPDATE companions SET status='ready',error=null WHERE id=${run.companion_id}`;
          const accepted = await agentRequest(endpoint, token, `/runs/${run.id}`, "PUT", { content: run.content, instructions: run.instructions, lane: run.lane, ...(run.model_id ? {modelId: run.model_id} : {}) });
          if (accepted?.responseRootId) {
            await sql`UPDATE runs SET response_root_id=(SELECT id FROM runs root WHERE root.id=${accepted.responseRootId} AND root.companion_id=${run.companion_id}) WHERE id=${run.id}`;
          }
          return;
        }
        if (!endpoint) { await settle(sql, run, "interrupted", null, "Execution endpoint was lost. The task was not replayed."); return; }
        await hooks.observeRun?.(run, endpoint, token);
        if (run.cancel_requested) await agentRequest(endpoint, token, `/runs/${run.id}/cancel`, "POST");
        const result = await agentRequest(endpoint, token, `/runs/${run.id}`);
          await persistObservation(sql,run,result);
        if (!result) { await settle(sql, run, "interrupted", null, "Execution could not be confirmed. The task was not replayed."); return; }
        if (["succeeded", "failed", "interrupted", "cancelled"].includes(result.status)) {
          await hooks.beforeSettle?.(run, endpoint, token);
          await settle(sql, run, result.status, typeof result.text === "string" ? result.text : null,
            result.status === "failed" ? "The agent could not complete this task." : result.status === "interrupted" ? "The agent restarted during this task. It was not replayed." : null,
            result.responseRootId ?? run.id, result.publishToChat === true);
        } else if (age > 2 * 3600_000) {
          await agentRequest(endpoint, token, `/runs/${run.id}/cancel`, "POST");
          await settle(sql, run, "interrupted", null, "Task deadline reached. It was not replayed.");
        } else if (result.status === "needs_input") {
          await sql`UPDATE runs SET status='needs_input' WHERE id=${run.id} AND status='running'
            AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted)`;
        }
      } catch (error) {
        if (error instanceof SQL.SQLError) throw error;
        if (run.dispatched && run.provider === "local") {
          // Docker assigns a new host port after restart. Reconnect to the SAME durable
          // daemon journal; never redispatch the request while repairing transport.
          try {
            const endpoint = await prepareLocal({ ...run, id: run.companion_id }, false);
            await sql`UPDATE companions SET endpoint_secret=${encrypt(endpoint)} WHERE id=${run.companion_id}`;
          } catch (repairError) { if (repairError instanceof SQL.SQLError) throw repairError; }
        }
        // Network failures stay observable and bounded. Never include provider payloads.
        if (age > (!run.dispatched ? 5 * 60_000 : 10 * 60_000)) {
          await settle(sql, run, run.dispatched ? "interrupted" : "failed", null, "The machine did not respond. This task was not replayed.");
          await sql`UPDATE companions SET status='error',error='Machine unavailable.',endpoint_secret=null WHERE id=${run.companion_id}`;
        }
      }
  }
}
if (import.meta.main) {
  await migrate();
  const sql = await acquireExecutor();
  if (!sql) { console.error("Another executor already owns this workspace."); process.exit(1); }
  console.log("Executor ready");
  const { productHooks } = await import("./runtime-product");
  try { for (;;) { await tick(sql, productHooks); await Bun.sleep(500); } }
  finally { sql.release(); await db.close(); }
}
