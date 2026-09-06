import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { DesktopActionRequest, DesktopResult } from "./types";

type ActionStatus = "pending" | "started" | "succeeded" | "interrupted";
export type JournalClaim =
  | { state: "claimed" }
  | { state: "succeeded"; result: DesktopResult }
  | { state: "interrupted" }
  | { state: "expired" }
  | { state: "in_progress" }
  | { state: "conflict" };

const payload = (request: DesktopActionRequest) => JSON.stringify(request);
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

export class DesktopJournal {
  private readonly database: Database;

  constructor(path: string, private readonly resultBudgetBytes=64*1024*1024) {
    if(!Number.isSafeInteger(resultBudgetBytes)||resultBudgetBytes<1)throw Error("Invalid desktop result budget");
    this.database = new Database(path, { create: true, strict: true });
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS desktop_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        generation INTEGER NOT NULL CHECK(generation>=0),
        desired_taken INTEGER NOT NULL CHECK(desired_taken IN (0,1))
      );
      INSERT OR IGNORE INTO desktop_state(singleton,generation,desired_taken) VALUES(1,0,0);
      CREATE TABLE IF NOT EXISTS desktop_actions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','started','succeeded','interrupted')),
        result_json TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      UPDATE desktop_actions SET status='interrupted',finished_at=unixepoch('subsec')*1000
        WHERE status='started';
      UPDATE desktop_actions SET request_json='' WHERE request_json<>'';`);
  }

  desiredState(): { generation: number; taken: boolean } {
    const row = this.database.query("SELECT generation,desired_taken AS taken FROM desktop_state WHERE singleton=1").get() as { generation: number; taken: number };
    return { generation: row.generation, taken: row.taken === 1 };
  }

  reconcile(generation: number, taken: boolean): "advanced" | "reconciled" | "stale" | "conflict" {
    return this.database.transaction(() => {
      const current = this.desiredState();
      if (generation < current.generation) return "stale" as const;
      if (generation === current.generation && taken !== current.taken) return "conflict" as const;
      if (generation > current.generation) {
        this.database.query("UPDATE desktop_state SET generation=?,desired_taken=? WHERE singleton=1").run(generation, taken ? 1 : 0);
        return "advanced" as const;
      }
      return "reconciled" as const;
    })();
  }

  previous(request: DesktopActionRequest): Exclude<JournalClaim, { state: "claimed" }> | null {
    const body = payload(request);
    const row = this.database.query("SELECT request_hash,status,result_json FROM desktop_actions WHERE id=?").get(request.id) as {
      request_hash: string; status: ActionStatus; result_json: string | null;
    } | null;
    if (!row) return null;
    if (row.request_hash !== fingerprint(body)) return { state: "conflict" };
    if (row.status === "succeeded") return row.result_json===null?{state:"expired"}:{ state: "succeeded", result: JSON.parse(row.result_json) as DesktopResult };
    if (row.status === "interrupted") return { state: "interrupted" };
    return { state: "in_progress" };
  }

  claim(request: DesktopActionRequest): JournalClaim {
    const body = payload(request);
    const hash = fingerprint(body);
    return this.database.transaction(() => {
      this.database.query(`INSERT OR IGNORE INTO desktop_actions
        (id,run_id,generation,request_hash,request_json,status,created_at)
        VALUES(?,?,?,?,?,'pending',?)`).run(request.id, request.runId, request.generation, hash, "", Date.now());
      const previous = this.previous(request);
      if (previous && previous.state !== "in_progress") return previous;
      const row = this.database.query("SELECT status FROM desktop_actions WHERE id=?").get(request.id) as { status: ActionStatus };
      if (row.status === "started") return { state: "in_progress" } as const;
      const changed = this.database.query("UPDATE desktop_actions SET status='started' WHERE id=? AND status='pending'").run(request.id);
      return changed.changes === 1 ? { state: "claimed" } as const : { state: "in_progress" } as const;
    })();
  }

  succeed(id: string, result: DesktopResult) {
    this.database.query("UPDATE desktop_actions SET status='succeeded',result_json=?,finished_at=? WHERE id=? AND status='started'")
      .run(JSON.stringify(result), Date.now(), id);
    // Keep durable fingerprints forever; evict only large result payloads, never replay an action.
    this.database.query(`UPDATE desktop_actions SET result_json=NULL WHERE id IN (
      SELECT id FROM (SELECT id,sum(length(CAST(result_json AS BLOB))) OVER (ORDER BY finished_at DESC,rowid DESC) AS bytes
        FROM desktop_actions WHERE status='succeeded' AND result_json IS NOT NULL) WHERE bytes>?)`).run(this.resultBudgetBytes);
  }

  interrupt(id: string) {
    this.database.query("UPDATE desktop_actions SET status='interrupted',finished_at=? WHERE id=? AND status='started'").run(Date.now(), id);
  }

  actionStatus(id: string): ActionStatus | null {
    return (this.database.query("SELECT status FROM desktop_actions WHERE id=?").get(id) as { status: ActionStatus } | null)?.status ?? null;
  }

  close() { this.database.close(); }
}
