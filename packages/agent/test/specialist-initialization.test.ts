import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { InitializationRunner, type InitializationProcess } from "../src/initialization";

const open: InitializationRunner[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

function deferredProcess() {
  let resolve!: (code: number) => void;
  const kills: string[] = [];
  const exited = new Promise<number>(done => { resolve = done; });
  const process: InitializationProcess = { pid: 42, exited, killGroup(signal) { kills.push(signal); } };
  return { process, resolve, kills };
}

function runner(state: string, processes: ReturnType<typeof deferredProcess>[], grace = 1) {
  const value = new InitializationRunner(state, () => processes.shift()!.process, grace);
  open.push(value); return value;
}

describe("specialist initialization", () => {
  test("runs only once for a Companion and remembers a known failure", async () => {
    const state = mkdtempSync(join(tmpdir(), "specialist-init-"));
    const first = deferredProcess(), value = runner(state, [first]);
    const pending = value.run("exit 7", 10_000); first.resolve(7);
    expect(await pending).toMatchObject({ kind: "warning", status: "failed" });
    expect(await value.run("exit 7", 10_000)).toMatchObject({ kind: "warning", status: "failed" });
  });

  test("stops the process group and confirms exit before returning a timeout warning", async () => {
    const state = mkdtempSync(join(tmpdir(), "specialist-init-"));
    const child = deferredProcess();
    child.process.killGroup = signal => { child.kills.push(signal); child.resolve(143); };
    const value = runner(state, [child]);
    expect(await value.run("hang", 1)).toMatchObject({ kind: "warning", status: "timed_out" });
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  test("escalates to the process group kill and waits for confirmed exit", async () => {
    const state = mkdtempSync(join(tmpdir(), "specialist-init-"));
    const child = deferredProcess();
    child.process.killGroup = signal => { child.kills.push(signal); if (signal === "SIGKILL") child.resolve(137); };
    const value = runner(state, [child], 1);
    expect(await value.run("ignore term", 1)).toMatchObject({ kind: "warning", status: "timed_out" });
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("never overlaps a second initialization while the first outcome is pending", async () => {
    const state = mkdtempSync(join(tmpdir(), "specialist-init-"));
    const child = deferredProcess(); let launches = 0;
    const value = new InitializationRunner(state, () => { launches += 1; return child.process; }); open.push(value);
    const first = value.run("effect", 10_000);
    expect(await value.run("effect", 10_000)).toMatchObject({ kind: "blocked", error: "INIT_SCRIPT_OUTCOME_UNKNOWN" });
    expect(launches).toBe(1);
    child.resolve(0); await first;
  });

  test("an unfinished journal is ambiguous after restart and is never launched again", async () => {
    const state = mkdtempSync(join(tmpdir(), "specialist-init-"));
    const child = deferredProcess(), first = runner(state, [child]);
    const pending = first.run("effect", 10_000); child.resolve(0); await pending;
    first.close(); open.splice(open.indexOf(first), 1);
    const db = new Database(join(state, "initialization.sqlite"));
    db.query("UPDATE initialization SET status='running',finished_at=NULL").run(); db.close();
    let launches = 0;
    const restarted = new InitializationRunner(state, () => { launches += 1; return deferredProcess().process; });
    open.push(restarted);
    expect(await restarted.run("effect", 10_000)).toEqual({ kind: "blocked", status: "interrupted", error: "INIT_SCRIPT_OUTCOME_UNKNOWN" });
    expect(launches).toBe(0);
  });

  test("a changed script cannot run inside the same intervention", async () => {
    const state = mkdtempSync(join(tmpdir(), "specialist-init-"));
    const first = deferredProcess(), value = runner(state, [first]);
    const pending = value.run("version one", 10_000); first.resolve(0); await pending;
    expect(await value.run("version two", 10_000)).toMatchObject({ kind: "blocked", error: "INIT_SCRIPT_OUTCOME_UNKNOWN" });
  });
});
