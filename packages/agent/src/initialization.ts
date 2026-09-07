import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type InitializationStatus = "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted";
export type InitializationResult =
  | { kind: "ready"; status: "succeeded" }
  | { kind: "warning"; status: "failed" | "timed_out" | "cancelled"; warning: string }
  | { kind: "blocked"; status: "interrupted"; error: "INIT_SCRIPT_OUTCOME_UNKNOWN" };

export interface InitializationProcess {
  pid: number;
  exited: Promise<number>;
  killGroup(signal: "SIGTERM" | "SIGKILL"): void;
  /** Checks the process group, including descendants after the original shell has exited. */
  isGroupAlive?(): boolean | Promise<boolean>;
}

export type InitializationLauncher = (script: string, cwd: string) => InitializationProcess;
type StoredInitialization = { script_hash: string; status: "running" | InitializationStatus };

const FAILURE_WARNING = "The specialist initialization script failed. The mission is continuing in an environment that may need repair.";
const TIMEOUT_WARNING = "The specialist initialization script reached its time limit and was stopped. The mission is continuing in an environment that may need repair.";
const CANCELLED_WARNING = "The specialist initialization script was cancelled and will not be replayed. The environment may need explicit repair before more work.";

/** A Companion state directory owns one initialization, shared by all of its follow-up runs. */
export class InitializationRunner {
  private readonly db: Database;
  private readonly cwd: string;

  constructor(stateDir: string, private readonly launch: InitializationLauncher = launchInitialization,
    private readonly terminationGraceMs = 5_000) {
    mkdirSync(stateDir, { recursive: true });
    this.cwd = join(stateDir, "workspace");
    mkdirSync(this.cwd, { recursive: true });
    this.db = new Database(join(stateDir, "initialization.sqlite"), { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS initialization (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), script_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','timed_out','cancelled','interrupted')),
        exit_code INTEGER, started_at TEXT NOT NULL, finished_at TEXT
      );`);
    this.db.query("UPDATE initialization SET status='interrupted',finished_at=? WHERE singleton=1 AND status='running'")
      .run(new Date().toISOString());
  }

  async run(script: string, timeoutMs: number, signal?: AbortSignal): Promise<InitializationResult> {
    const scriptHash = createHash("sha256").update(script).digest("hex");
    const prior = this.stored();
    if (prior) return this.existing(prior, scriptHash);
    const inserted = this.db.query("INSERT INTO initialization(singleton,script_hash,status,started_at) VALUES(1,?,'running',?) ON CONFLICT DO NOTHING")
      .run(scriptHash, new Date().toISOString());
    if (!inserted.changes) return this.existing(this.stored()!, scriptHash);

    let child: InitializationProcess;
    try { child = this.launch(script, this.cwd); }
    catch {
      this.finish("failed", null);
      return { kind: "warning", status: "failed", warning: FAILURE_WARNING };
    }

    const timeout = Symbol("timeout"), cancelled = Symbol("cancelled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = () => {};
    const timed = new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), timeoutMs); });
    const aborted = new Promise<typeof cancelled>(resolve => {
      const stop = () => resolve(cancelled);
      signal?.addEventListener("abort", stop, { once: true });
      removeAbort = () => signal?.removeEventListener("abort", stop);
      if (signal?.aborted) stop();
    });
    try {
      const outcome = await Promise.race([child.exited, timed, aborted]);
      if (outcome === timeout || outcome === cancelled) {
        await this.stopAndConfirm(child);
        if (outcome === cancelled) {
          this.finish("cancelled", null);
          return { kind: "blocked", status: "interrupted", error: "INIT_SCRIPT_OUTCOME_UNKNOWN" };
        }
        this.finish("timed_out", null);
        return { kind: "warning", status: "timed_out", warning: TIMEOUT_WARNING };
      }
      // A shell can exit while a background descendant remains in its detached process group.
      // Never overlap that descendant with the model mission.
      if (await this.groupAlive(child)) await this.stopAndConfirm(child);
      if (outcome === 0) {
        this.finish("succeeded", 0);
        return { kind: "ready", status: "succeeded" };
      }
      this.finish("failed", outcome);
      return { kind: "warning", status: "failed", warning: FAILURE_WARNING };
    } catch {
      this.finish("interrupted", null);
      return { kind: "blocked", status: "interrupted", error: "INIT_SCRIPT_OUTCOME_UNKNOWN" };
    } finally {
      if (timer) clearTimeout(timer);
      removeAbort();
    }
  }

  close(): void { this.db.close(false); }

  private stored(): StoredInitialization | null {
    return this.db.query("SELECT script_hash,status FROM initialization WHERE singleton=1").get() as StoredInitialization | null;
  }

  private existing(prior: StoredInitialization, scriptHash: string): InitializationResult {
    if (prior.script_hash !== scriptHash || prior.status === "running" || prior.status === "interrupted") {
      return { kind: "blocked", status: "interrupted", error: "INIT_SCRIPT_OUTCOME_UNKNOWN" };
    }
    if (prior.status === "succeeded") return { kind: "ready", status: "succeeded" };
    if (prior.status === "cancelled") return { kind: "warning", status: "cancelled", warning: CANCELLED_WARNING };
    return prior.status === "timed_out"
      ? { kind: "warning", status: "timed_out", warning: TIMEOUT_WARNING }
      : { kind: "warning", status: "failed", warning: FAILURE_WARNING };
  }

  private finish(status: InitializationStatus, exitCode: number | null): void {
    this.db.query("UPDATE initialization SET status=?,exit_code=?,finished_at=? WHERE singleton=1 AND status='running'")
      .run(status, exitCode, new Date().toISOString());
  }

  private async stopAndConfirm(child: InitializationProcess): Promise<void> {
    if (!await this.groupAlive(child)) return;
    child.killGroup("SIGTERM");
    if (await this.waitForGroupExit(child, this.terminationGraceMs)) return;
    child.killGroup("SIGKILL");
    if (!await this.waitForGroupExit(child, this.terminationGraceMs)) throw new Error("INIT_PROCESS_GROUP_STILL_ACTIVE");
  }

  private async groupAlive(child: InitializationProcess): Promise<boolean> {
    if (child.isGroupAlive) return await child.isGroupAlive();
    // Compatibility for injected runners that only model the root process.
    return true;
  }

  private async waitForGroupExit(child: InitializationProcess, timeoutMs: number): Promise<boolean> {
    if (!child.isGroupAlive) { await child.exited; return true; }
    const deadline = Date.now() + timeoutMs;
    do {
      if (!await child.isGroupAlive()) return true;
      await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    return !await child.isGroupAlive();
  }
}

function launchInitialization(script: string, cwd: string): InitializationProcess {
  const child = Bun.spawn(["/bin/sh", "-lc", script], {
    cwd, env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
  });
  return {
    pid: child.pid, exited: child.exited,
    killGroup(signal) { process.kill(-child.pid, signal); },
    isGroupAlive() {
      try { process.kill(-child.pid, 0); return true; }
      catch (error: any) { if (error?.code === "ESRCH") return false; throw error; }
    },
  };
}
