import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { RunInput, RunRecord, RunStatus } from "./types";

interface StoredRun extends RunRecord {
  request_hash: string;
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  interruptUnfinished(): number {
    const now = new Date().toISOString();
    return this.db.query("UPDATE runs SET status = 'interrupted', error = 'DAEMON_RESTARTED', updated_at = ? WHERE status = 'running'")
      .run(now).changes;
  }

  accept(id: string, input: RunInput): { kind: "accepted" | "existing" | "conflict"; run: RunRecord } {
    const hash = requestHash(input);
    const transaction = this.db.transaction(() => {
      const existing = this.getStored(id);
      if (existing) {
        return { kind: existing.request_hash === hash ? "existing" as const : "conflict" as const, run: publicRun(existing) };
      }
      const now = new Date().toISOString();
      this.db.query(`INSERT INTO runs
        (id, request_hash, content, instructions, status, text, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, ?)`)
        .run(id, hash, input.content, input.instructions, now, now);
      return { kind: "accepted" as const, run: { id, status: "running" as const, text: null, error: null } };
    });
    return transaction.immediate();
  }

  get(id: string): RunRecord | null {
    const run = this.getStored(id);
    return run ? publicRun(run) : null;
  }

  settle(id: string, status: Exclude<RunStatus, "running">, text: string | null, error: string | null): RunRecord | null {
    this.db.query("UPDATE runs SET status = ?, text = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(status, text, error, new Date().toISOString(), id);
    return this.get(id);
  }

  close(): void {
    this.db.close(false);
  }

  private getStored(id: string): StoredRun | null {
    return this.db.query("SELECT id, request_hash, status, text, error FROM runs WHERE id = ?").get(id) as StoredRun | null;
  }
}

function requestHash(input: RunInput): string {
  return createHash("sha256").update(JSON.stringify([input.content, input.instructions])).digest("hex");
}

function publicRun(run: StoredRun): RunRecord {
  return { id: run.id, status: run.status, text: run.text, error: run.error };
}
