import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { RunInput, RunRecord, TerminalRunStatus, RunProgress } from "./types";

interface StoredRun extends RunRecord {
  request_hash: string;
  usage_json?:string;
  messages_json?:string;
}

export class RunJournal {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        instructions TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted', 'cancelled')),
        text TEXT,
        error TEXT,
        lane TEXT NOT NULL DEFAULT 'main',
        response_root_id TEXT,
        publish_to_chat INTEGER NOT NULL DEFAULT 0,
        parked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const columns = new Set((this.db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(row => row.name));
    if (!columns.has("thinking_text")) this.db.exec("ALTER TABLE runs ADD COLUMN thinking_text TEXT");
    if (!columns.has("preview_text")) this.db.exec("ALTER TABLE runs ADD COLUMN preview_text TEXT");
    if (!columns.has("usage_json")) this.db.exec("ALTER TABLE runs ADD COLUMN usage_json TEXT");
    if (!columns.has("messages_json")) this.db.exec("ALTER TABLE runs ADD COLUMN messages_json TEXT");
    if (!columns.has("message_version")) this.db.exec("ALTER TABLE runs ADD COLUMN message_version INTEGER");
    if (!columns.has("lane")) this.db.exec("ALTER TABLE runs ADD COLUMN lane TEXT NOT NULL DEFAULT 'main'");
    if (!columns.has("response_root_id")) this.db.exec("ALTER TABLE runs ADD COLUMN response_root_id TEXT");
    if (!columns.has("publish_to_chat")) this.db.exec("ALTER TABLE runs ADD COLUMN publish_to_chat INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("parked")) this.db.exec("ALTER TABLE runs ADD COLUMN parked INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("init_warning")) this.db.exec("ALTER TABLE runs ADD COLUMN init_warning TEXT");
    this.db.exec("UPDATE runs SET response_root_id=id WHERE response_root_id IS NULL");
  }

  interruptUnfinished(): number {
    const now = new Date().toISOString();
    return this.db.query("UPDATE runs SET status = 'interrupted', error = 'DAEMON_RESTARTED', updated_at = ? WHERE status = 'running'")
      .run(now).changes;
  }

  accept(id: string, input: RunInput, rootId = id): { kind: "accepted" | "existing" | "conflict"; run: RunRecord } {
    const hash = requestHash(input);
    const transaction = this.db.transaction(() => {
      const existing = this.getStored(id);
      if (existing) {
        return { kind: existing.request_hash === hash ? "existing" as const : "conflict" as const, run: publicRun(existing) };
      }
      const now = new Date().toISOString();
      this.db.query(`INSERT INTO runs
        (id, request_hash, content, instructions, status, text, error, created_at, updated_at, lane, response_root_id, parked)
        VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, ?, ?, ?, ?)`)
        .run(id, hash, input.content, input.instructions, now, now, input.lane ?? "main", rootId,
          this.get(rootId)?.status === "needs_input" ? 1 : 0);
      return { kind: "accepted" as const, run: this.get(id)! };
    });
    return transaction.immediate();
  }

  get(id: string): RunRecord | null {
    const run = this.getStored(id);
    return run ? publicRun(run) : null;
  }

  settle(id: string, status: TerminalRunStatus, text: string | null, error: string | null): RunRecord | null {
    this.db.query("UPDATE runs SET status = ?, text = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(status, text, error, new Date().toISOString(), id);
    return this.get(id);
  }

  /** All accepted steering IDs settle atomically with one response stored on their root. */
  settleGroup(rootId: string, status: TerminalRunStatus, text: string | null, error: string | null, publishToChat = false): void {
    this.db.query(`UPDATE runs SET status=?, text=CASE WHEN id=? THEN ? ELSE NULL END,
      error=?, publish_to_chat=CASE WHEN id=? AND ? THEN 1 ELSE 0 END, updated_at=?
      WHERE response_root_id=? AND status='running'`)
      .run(status, rootId, text, error, rootId, publishToChat ? 1 : 0, new Date().toISOString(), rootId);
  }

  progress(rootId:string,value:RunProgress):void {
    if(value.messageVersion===undefined){
      this.db.query("UPDATE runs SET preview_text=?,thinking_text=COALESCE(?,thinking_text),usage_json=?,updated_at=? WHERE id=? AND status='running'")
        .run(value.previewText,value.thinkingText??null,JSON.stringify(value.usage),new Date().toISOString(),rootId);
      return;
    }
    this.db.query(`UPDATE runs SET preview_text=?,thinking_text=COALESCE(?,thinking_text),usage_json=?,
      messages_json=?,message_version=?,updated_at=?
      WHERE id=? AND status='running' AND (message_version IS NULL OR message_version < ?)`)
      .run(value.previewText,value.thinkingText??null,JSON.stringify(value.usage),JSON.stringify(value.messages??[]),
        value.messageVersion,new Date().toISOString(),rootId,value.messageVersion);
  }

  initializationWarning(id: string, warning: string): void {
    this.db.query("UPDATE runs SET init_warning=?,updated_at=? WHERE id=? AND status='running'")
      .run(warning, new Date().toISOString(), id);
  }

  parkGroup(rootId: string, parked: boolean): void {
    this.db.query("UPDATE runs SET parked=?,updated_at=? WHERE response_root_id=? AND status='running'")
      .run(parked ? 1 : 0, new Date().toISOString(), rootId);
  }

  close(): void {
    this.db.close(false);
  }

  private getStored(id: string): StoredRun | null {
    return this.db.query(`SELECT id, request_hash, CASE WHEN status='running' AND parked=1 THEN 'needs_input' ELSE status END AS status, text, error, lane,
      response_root_id AS responseRootId, publish_to_chat AS publishToChat,preview_text AS previewText,thinking_text AS thinkingText,
      usage_json,messages_json,message_version AS messageVersion,init_warning AS initWarning FROM runs WHERE id = ?`).get(id) as StoredRun | null;
  }
}

function requestHash(input: RunInput): string {
  // Preserve historical main request hashes across a daemon upgrade.
  const fields = input.lane === "background" ? [input.content, input.instructions, "background"] : [input.content, input.instructions];
  if(input.modelId)fields.push(input.modelId);
  if(input.initScript)fields.push(JSON.stringify({initScript:input.initScript,initTimeoutMs:input.initTimeoutMs??600_000}));
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function publicRun(run: StoredRun): RunRecord {
  return { id: run.id, status: run.status, text: run.text, error: run.error,
    lane: run.lane, responseRootId: run.responseRootId, publishToChat: !!run.publishToChat,
    ...(run.thinkingText!=null?{thinkingText:run.thinkingText}:{}),
    ...(run.previewText!=null?{previewText:run.previewText}:{}),...(run.usage_json?{usage:JSON.parse(run.usage_json)}:{}),
    ...(run.messages_json?{messages:JSON.parse(run.messages_json)}:{}),
    ...(run.messageVersion!=null?{messageVersion:run.messageVersion}:{}),
    ...(run.initWarning?{initWarning:run.initWarning}:{}) };
}
