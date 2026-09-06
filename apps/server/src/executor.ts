import { db, migrate } from "./store";
import { encrypt, decrypt } from "./config";
import { prepareLocal, prepareBox, agentRequest, environmentDigest } from "./machines";
import { SQL, type ReservedSQL } from "bun";

// A reserved PostgreSQL session owns the lock and ALL execution checkpoints.
// A lost connection stops this executor; another process reconciles the durable journal.
export async function acquireExecutor() {
  const sql = await db.reserve();
  const [result] = await sql`SELECT pg_try_advisory_lock(721440139) AS locked`;
  if (!result.locked) { sql.release(); return null; }
  return sql;
}
async function settle(sql: ReservedSQL, run: any, status: string, text: string | null, error: string | null) {
  await sql`WITH settled AS (
    UPDATE runs SET status=${status},error=${error},finished_at=now() WHERE id=${run.id} AND status IN ('preparing','running')
      AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted)
      RETURNING id,companion_id
  ) INSERT INTO messages (id,companion_id,run_id,role,content)
    SELECT ${crypto.randomUUID()}::uuid,companion_id,id,'assistant',${text ?? ""} FROM settled WHERE ${!!text}
    ON CONFLICT(run_id,role) DO NOTHING`;
}
export async function tick(sql: ReservedSQL) {
  const [ownership] = await sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted) AS owned`;
  if (!ownership.owned) throw new Error("Executor ownership lost");
  await sql`UPDATE runs r SET status='preparing',started_at=now() WHERE r.id IN (
    SELECT DISTINCT ON (q.companion_id) q.id FROM runs q WHERE q.status='queued'
      AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.companion_id=q.companion_id AND a.status IN ('preparing','running'))
    ORDER BY q.companion_id,q.created_at,q.id)`;
  const runs = await sql`SELECT r.*,c.provider,c.box_id,c.create_key,c.create_started_at,c.agent_secret,c.endpoint_secret,c.instructions,c.config_digest
    FROM runs r JOIN companions c ON c.id=r.companion_id WHERE r.status IN ('preparing','running') ORDER BY r.created_at`;
  // Bound parallelism while allowing unrelated Companions to progress independently.
  for (let offset = 0; offset < runs.length; offset += 8) {
    await Promise.all(runs.slice(offset, offset + 8).map(async (run: any) => {
      const age = Date.now() - new Date(run.started_at).getTime();
      const token = decrypt(run.agent_secret);
      if (run.cancel_requested && !run.dispatched) { await settle(sql, run, "cancelled", null, null); return; }
      try {
        let endpoint = run.endpoint_secret ? decrypt(run.endpoint_secret) : null;
        if (run.status === "preparing") {
          const digest = environmentDigest(run.agent_secret, run.provider);
          if (run.config_digest !== digest) endpoint = null;
          if (age > 5 * 60_000) { await settle(sql, run, "failed", null, "Preparation timed out. Send a new message to retry."); await sql`UPDATE companions SET status='error',error='Preparation timed out.' WHERE id=${run.companion_id}`; return; }
          await sql`UPDATE companions SET status='preparing',error=null,create_started_at=COALESCE(create_started_at,now()) WHERE id=${run.companion_id}`;
          const companion = { ...run, id: run.companion_id };
          // Observe Box lifecycle before testing a cached endpoint: an archived machine
          // cannot answer health and must not cost a full network timeout before resume.
          if (!endpoint || run.provider === "box") {
            endpoint = run.provider === "local" ? await prepareLocal(companion) : await prepareBox(companion,
              async id => { await sql`UPDATE companions SET box_id=${id} WHERE id=${run.companion_id}`; },
              async () => { await sql`UPDATE companions SET config_digest=${digest} WHERE id=${run.companion_id}`; });
            if (!endpoint) return;
            await sql`UPDATE companions SET endpoint_secret=${encrypt(endpoint)},config_digest=${digest} WHERE id=${run.companion_id}`;
          }
          try {
            const health = await agentRequest(endpoint, token, "/health");
            if (!health?.ready) throw new Error("agent_not_ready");
            if (health.activeRunId) {
              const [prior] = await sql`SELECT status FROM runs WHERE id=${health.activeRunId} AND companion_id=${run.companion_id}`;
              if (!prior || ["interrupted", "cancelled", "failed"].includes(prior.status)) await agentRequest(endpoint, token, `/runs/${health.activeRunId}/cancel`, "POST");
              return;
            }
          } catch (error) {
            // Provider readiness precedes the user service after resume. Give its
            // existing endpoint a bounded startup grace instead of reconfiguring
            // the machine on the first transient connection failure.
            if (run.provider === "box" && age < 45_000 && !(error instanceof Error && error.message === "agent_auth_expired")) return;
            // Re-resolve/restart the existing machine on the next pass, never replace it.
            await sql`UPDATE companions SET endpoint_secret=null WHERE id=${run.companion_id}`;
            return;
          }
          // Persist intent before the network side effect. Recovery only observes this id.
          const [dispatch] = await sql`UPDATE runs SET status='running',dispatched=true,prepared_at=now() WHERE id=${run.id}
            AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted)
            RETURNING id`;
          if (!dispatch) throw new Error("Executor ownership lost before dispatch");
          await sql`UPDATE companions SET status='ready',error=null WHERE id=${run.companion_id}`;
          await agentRequest(endpoint, token, `/runs/${run.id}`, "PUT", { content: run.content, instructions: run.instructions });
          return;
        }
        if (!endpoint) { await settle(sql, run, "interrupted", null, "Execution endpoint was lost. The task was not replayed."); return; }
        if (run.cancel_requested) await agentRequest(endpoint, token, `/runs/${run.id}/cancel`, "POST");
        const result = await agentRequest(endpoint, token, `/runs/${run.id}`);
        if (!result) { await settle(sql, run, "interrupted", null, "Execution could not be confirmed. The task was not replayed."); return; }
        if (["succeeded", "failed", "interrupted", "cancelled"].includes(result.status)) {
          await settle(sql, run, result.status, typeof result.text === "string" ? result.text : null,
            result.status === "failed" ? "The agent could not complete this task." : result.status === "interrupted" ? "The agent restarted during this task. It was not replayed." : null);
        } else if (age > 2 * 3600_000) {
          await agentRequest(endpoint, token, `/runs/${run.id}/cancel`, "POST");
          await settle(sql, run, "interrupted", null, "Task deadline reached. It was not replayed.");
        }
      } catch (error) {
        if (error instanceof SQL.SQLError) throw error;
        if (run.status === "running" && run.provider === "local") {
          // Docker assigns a new host port after restart. Reconnect to the SAME durable
          // daemon journal; never redispatch the request while repairing transport.
          try {
            const endpoint = await prepareLocal({ ...run, id: run.companion_id }, false);
            await sql`UPDATE companions SET endpoint_secret=${encrypt(endpoint)} WHERE id=${run.companion_id}`;
          } catch (repairError) { if (repairError instanceof SQL.SQLError) throw repairError; }
        }
        // Network failures stay observable and bounded. Never include provider payloads.
        if (age > (run.status === "preparing" ? 5 * 60_000 : 10 * 60_000)) {
          await settle(sql, run, run.dispatched ? "interrupted" : "failed", null, "The machine did not respond. This task was not replayed.");
          await sql`UPDATE companions SET status='error',error='Machine unavailable.',endpoint_secret=null WHERE id=${run.companion_id}`;
        }
      }
    }));
  }
}
if (import.meta.main) {
  await migrate();
  const sql = await acquireExecutor();
  if (!sql) { console.error("Another executor already owns this workspace."); process.exit(1); }
  console.log("Executor ready");
  try { for (;;) { await tick(sql); await Bun.sleep(500); } }
  finally { sql.release(); await db.close(); }
}
