import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentDaemon } from "../src/daemon";
import type { RunExecutor, RunInput } from "../src/types";
import { InitializationRunner, type InitializationProcess } from "../src/initialization";

const token = "test-secret";
const open: AgentDaemon[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

class ControlledExecutor implements RunExecutor {
  calls: Array<{ id: string; input: RunInput }> = [];
  resolves = new Map<string, (value: { text: string }) => void>();
  rejects = new Map<string, (reason: Error) => void>();
  cancelled: string[] = [];
  steers: Array<{ rootId: string; id: string; input: RunInput }> = [];
  async steer(rootId: string, id: string, input: RunInput) { this.steers.push({ rootId, id, input }); }
  async suspend(_id: string) { return true; }
  async resume(_id: string) { return true; }
  execute(id: string, input: RunInput): Promise<{ text: string }> {
    this.calls.push({ id, input });
    return new Promise((resolve, reject) => { this.resolves.set(id, resolve); this.rejects.set(id, reject); });
  }
  async cancel(id: string) { this.cancelled.push(id); this.rejects.get(id)?.(new Error("RUN_CANCELLED")); }
  finish(id: string, text: string) { this.resolves.get(id)?.({ text }); }
  fail(id: string, error: Error) { this.rejects.get(id)?.(error); }
}

function daemon(state = mkdtempSync(join(tmpdir(), "companion-agent-")), executor = new ControlledExecutor(), initialization?: InitializationRunner) {
  const value = new AgentDaemon(state, token, executor, undefined, 0, initialization); open.push(value); return { state, executor, daemon: value };
}
function request(path: string, init: RequestInit = {}) {
  return new Request(`http://agent${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
}
const id = "01993c9a-b0c2-7000-8000-000000000001";

describe("agent daemon protocol", () => {
  test("requires bearer authentication on health and run routes", async () => {
    const app = daemon();
    expect((await app.daemon.fetch(new Request("http://agent/health"))).status).toBe(401);
    expect((await app.daemon.fetch(new Request(`http://agent/runs/${id}`))).status).toBe(401);
  });

  test("persists the final response and returns it from read-only polling", async () => {
    const app = daemon();
    const accepted = await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body: JSON.stringify({ content: "hello", instructions: "be terse" }) }));
    expect(accepted.status).toBe(202);
    await Bun.sleep(0);
    app.executor.finish(id, "durable answer");
    await Bun.sleep(0);
    expect(await (await app.daemon.fetch(request(`/runs/${id}`))).json()).toMatchObject({ id, status: "succeeded", text: "durable answer", error: null });
  });

  test("same id and body is idempotent while a changed body conflicts", async () => {
    const app = daemon();
    const body = JSON.stringify({ content: "hello", instructions: "" });
    await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body }));
    expect((await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body }))).status).toBe(200);
    expect((await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body: JSON.stringify({ content: "changed", instructions: "" }) }))).status).toBe(409);
    expect(app.executor.calls).toHaveLength(1);
  });

  test("runs specialist initialization once, persists its warning, and continues the mission", async () => {
    const state = mkdtempSync(join(tmpdir(), "companion-agent-"));
    let launches = 0;
    const initialization = new InitializationRunner(state, () => {
      launches += 1;
      return { pid: 1, exited: Promise.resolve(7), killGroup() {} } satisfies InitializationProcess;
    });
    const app = daemon(state, new ControlledExecutor(), initialization);
    const body = (content: string) => JSON.stringify({ content, instructions: "base", initScript: "prepare", initTimeoutMs: 5_000 });
    expect((await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body: body("first") }))).status).toBe(202);
    await Bun.sleep(0);
    expect(app.executor.calls[0]!.input.instructions).toContain("initialization script failed");
    app.executor.finish(id, "repaired during mission"); await Bun.sleep(0);
    expect(await (await app.daemon.fetch(request(`/runs/${id}`))).json()).toMatchObject({ status: "succeeded", initWarning: expect.stringContaining("initialization script failed") });

    const followup = "01993c9a-b0c2-7000-8000-000000000009";
    await app.daemon.fetch(request(`/runs/${followup}`, { method: "PUT", body: body("follow-up") }));
    await Bun.sleep(0);
    expect(launches).toBe(1);
    expect(app.executor.calls[1]!.input.instructions).toContain("initialization script failed");
  });

  test("does not start the mission when initialization was ambiguous before restart", async () => {
    const state = mkdtempSync(join(tmpdir(), "companion-agent-"));
    const seed = new InitializationRunner(state, () => ({ pid: 1, exited: Promise.resolve(0), killGroup() {} }));
    await seed.run("prepare", 5_000); seed.close();
    const db = new Database(join(state, "initialization.sqlite"));
    db.query("UPDATE initialization SET status='running',finished_at=NULL").run(); db.close();
    const app = daemon(state);
    await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body: JSON.stringify({ content: "mission", instructions: "", initScript: "prepare" }) }));
    await Bun.sleep(0);
    expect(app.executor.calls).toHaveLength(0);
    expect(await (await app.daemon.fetch(request(`/runs/${id}`))).json()).toMatchObject({ status: "interrupted", error: "INIT_SCRIPT_OUTCOME_UNKNOWN" });
  });

  test("does not steer or accept another main turn while initialization is running", async () => {
    const state = mkdtempSync(join(tmpdir(), "companion-agent-"));
    let finish!: (code: number) => void;
    const exited = new Promise<number>(resolve => { finish = resolve; });
    // Pi does not expose an accepting root until execute() starts, after initialization.
    class InitializingExecutor extends ControlledExecutor { acceptingRoot() { return null; } }
    const app = daemon(state, new InitializingExecutor(), new InitializationRunner(state, () => ({ pid: 1, exited, killGroup() {} })));
    await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body: JSON.stringify({ content: "mission", instructions: "", initScript: "prepare" }) }));
    await Bun.sleep(0);
    const next = "01993c9a-b0c2-7000-8000-000000000008";
    expect((await app.daemon.fetch(request(`/runs/${next}`, { method: "PUT", body: JSON.stringify({ content: "follow-up", instructions: "", initScript: "prepare" }) }))).status).toBe(409);
    expect((await app.daemon.fetch(request(`/runs/${next}`))).status).toBe(404);
    expect(app.executor.steers).toHaveLength(0);
    expect((await app.daemon.fetch(request(`/runs/${next}`, { method: "PUT", body: JSON.stringify({ content: "background", instructions: "", lane: "background", initScript: "prepare" }) }))).status).toBe(409);
    expect((await app.daemon.fetch(request(`/runs/${next}`))).status).toBe(404);
    finish(0); await Bun.sleep(0);
    expect(app.executor.calls).toHaveLength(1);
    app.executor.finish(id, "first done"); await Bun.sleep(0);
    expect((await app.daemon.fetch(request(`/runs/${next}`, { method: "PUT", body: JSON.stringify({ content: "follow-up", instructions: "", initScript: "prepare" }) }))).status).toBe(202);
    await Bun.sleep(0);
    expect(app.executor.calls).toHaveLength(2);
  });

  test("a run-bound gateway token is required in gateway mode, rotates across retries, and is never journaled",async()=>{
    const previous=process.env.MODEL_GATEWAY_URL;process.env.MODEL_GATEWAY_URL="https://models.companions.build/api/model-gateway";
    try{
      const app=daemon(),first="first-run-scoped-token",rotated="rotated-run-token";
      const body=(token:string)=>JSON.stringify({content:"hello",instructions:"",modelGateway:{token}});
      expect((await app.daemon.fetch(request(`/runs/${id}`,{method:"PUT",body:JSON.stringify({content:"hello",instructions:""})}))).status).toBe(400);
      expect((await app.daemon.fetch(request(`/runs/${id}`,{method:"PUT",body:body(first)}))).status).toBe(202);
      expect((await app.daemon.fetch(request(`/runs/${id}`,{method:"PUT",body:body(rotated)}))).status).toBe(200);
      expect(app.executor.calls[0]!.input.modelGateway).toEqual({token:first});
      const bytes=await Array.fromAsync(new Bun.Glob("**/*").scan({cwd:app.state,onlyFiles:true})).then(paths=>Promise.all(paths.map(path=>Bun.file(`${app.state}/${path}`).arrayBuffer())));
      expect(bytes.some(value=>Buffer.from(value).includes(first)||Buffer.from(value).includes(rotated))).toBe(false);
    }finally{if(previous===undefined)delete process.env.MODEL_GATEWAY_URL;else process.env.MODEL_GATEWAY_URL=previous;}
  });

  test("background rejects another id as busy without persisting it", async () => {
    const app = daemon();
    await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body: JSON.stringify({ content: "one", instructions: "", lane: "background" }) }));
    const second = "01993c9a-b0c2-7000-8000-000000000002";
    expect((await app.daemon.fetch(request(`/runs/${second}`, { method: "PUT", body: JSON.stringify({ content: "two", instructions: "", lane: "background" }) }))).status).toBe(409);
    expect((await app.daemon.fetch(request(`/runs/${second}`))).status).toBe(404);
  });

  test("chat and background execute independently; main steering keeps one durable response root", async () => {
    const app = daemon();
    const background = crypto.randomUUID();
    const steer = crypto.randomUUID();
    for (const [requestId, lane] of [[id, "main"], [background, "background"], [steer, "main"]]) {
      const accepted = await app.daemon.fetch(request(`/runs/${requestId}`, { method: "PUT", body: JSON.stringify({ content: requestId, instructions: "", lane }) }));
      expect(accepted.status).toBe(202);
    }
    expect(app.executor.calls).toHaveLength(2);
    expect(app.executor.steers).toHaveLength(1);
    expect(app.executor.steers[0].rootId).toBe(id);
    expect(app.daemon.journal.get(steer)?.responseRootId).toBe(id);
    expect((await (await app.daemon.fetch(request("/health"))).json()).activeRuns).toEqual({ main: id, background });
    app.executor.finish(id, "One response for both messages");
    await Bun.sleep(0);
    expect(app.daemon.journal.get(id)).toMatchObject({ status: "succeeded", text: "One response for both messages" });
    expect(app.daemon.journal.get(steer)).toMatchObject({ status: "succeeded", text: null, responseRootId: id });
    expect(app.daemon.journal.get(background)?.status).toBe("running");
    app.executor.finish(background, "Private background result");
    await Bun.sleep(0);
    expect(app.daemon.journal.get(background)).toMatchObject({ lane: "background", text: "Private background result", publishToChat: false });
  });

  test("cancelling a steered message cancels its shared main response without touching background", async () => {
    const app = daemon();
    const steer = crypto.randomUUID(), background = crypto.randomUUID();
    for (const [requestId, lane] of [[id, "main"], [background, "background"], [steer, "main"]]) {
      await app.daemon.fetch(request(`/runs/${requestId}`, { method: "PUT", body: JSON.stringify({ content: requestId, instructions: "", lane }) }));
    }
    await app.daemon.fetch(request(`/runs/${steer}/cancel`, { method: "POST" }));
    expect(app.executor.cancelled).toEqual([id]);
    expect(app.daemon.journal.get(id)?.status).toBe("cancelled");
    expect(app.daemon.journal.get(steer)?.status).toBe("cancelled");
    expect(app.daemon.journal.get(background)?.status).toBe("running");
    app.executor.finish(background, "background unaffected");
    await Bun.sleep(0);
  });

  test("restart interrupts every accepted steer and both lanes without replay", async () => {
    const app = daemon();
    const steer = crypto.randomUUID(), background = crypto.randomUUID();
    for (const [requestId, lane] of [[id, "main"], [background, "background"], [steer, "main"]]) {
      await app.daemon.fetch(request(`/runs/${requestId}`, { method: "PUT", body: JSON.stringify({ content: requestId, instructions: "", lane }) }));
    }
    app.daemon.close(); open.pop();
    const restarted = daemon(app.state);
    for (const requestId of [id, steer, background]) expect(restarted.daemon.journal.get(requestId)?.status).toBe("interrupted");
    expect(restarted.daemon.journal.get(steer)?.responseRootId).toBe(id);
    const duplicate = await restarted.daemon.fetch(request(`/runs/${steer}`, { method: "PUT", body: JSON.stringify({ content: steer, instructions: "", lane: "main" }) }));
    expect(duplicate.status).toBe(200);
    expect(restarted.executor.calls).toHaveLength(0);
  });

  test("a human question parks background work; its answer cannot resume until the next task releases the slot", async () => {
    const app = daemon();
    const waiting = crypto.randomUUID(), next = crypto.randomUUID();
    const put = (id: string) => app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body: JSON.stringify({ content: id, instructions: "", lane: "background" }) }));
    await put(waiting);
    expect((await (await app.daemon.fetch(request(`/runs/${waiting}/suspend`, { method: "POST" }))).json()).status).toBe("needs_input");
    const health = await (await app.daemon.fetch(request("/health"))).json();
    expect(health.activeRuns.background).toBeNull();
    expect(health.parkedRuns).toEqual([waiting]);
    expect((await put(next)).status).toBe(202);
    expect((await app.daemon.fetch(request(`/runs/${waiting}/resume`, { method: "POST" }))).status).toBe(409);
    expect(app.daemon.journal.get(waiting)?.status).toBe("needs_input");
    app.executor.finish(next, "Next work completed independently");
    await Bun.sleep(0);
    expect((await (await app.daemon.fetch(request(`/runs/${waiting}/resume`, { method: "POST" }))).json()).status).toBe("running");
    app.executor.finish(waiting, "Continued with its own answer");
    await Bun.sleep(0);
    expect(app.daemon.journal.get(waiting)).toMatchObject({ status: "succeeded", text: "Continued with its own answer" });
    expect(app.executor.calls).toHaveLength(2);
  });

  test("a daemon restart interrupts a parked tool promise and keeps its ID unavailable for replay", async () => {
    const app = daemon();
    const body = JSON.stringify({ content: "Question", instructions: "", lane: "background" });
    await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body }));
    await app.daemon.fetch(request(`/runs/${id}/suspend`, { method: "POST" }));
    app.daemon.close(); open.pop();
    const restarted = daemon(app.state);
    expect(restarted.daemon.journal.get(id)).toMatchObject({ status: "interrupted", error: "DAEMON_RESTARTED" });
    expect((await (await restarted.daemon.fetch(request(`/runs/${id}/resume`, { method: "POST" }))).json()).status).toBe("interrupted");
    expect((await restarted.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body }))).status).toBe(200);
    expect(restarted.executor.calls).toHaveLength(0);
  });

  test("marks an ambiguous running request interrupted on restart and never executes it", async () => {
    const first = daemon();
    await first.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body: JSON.stringify({ content: "side effect", instructions: "" }) }));
    await Bun.sleep(0);
    expect(first.executor.calls).toHaveLength(1);
    first.daemon.close(); open.pop();
    const secondExecutor = new ControlledExecutor();
    const restarted = new AgentDaemon(first.state, token, secondExecutor); open.push(restarted);
    expect(await (await restarted.fetch(request(`/runs/${id}`))).json()).toMatchObject({ id, status: "interrupted", text: null, error: "DAEMON_RESTARTED" });
    expect(secondExecutor.calls).toHaveLength(0);
    expect((await restarted.fetch(request(`/runs/${id}`, { method: "PUT", body: JSON.stringify({ content: "side effect", instructions: "" }) }))).status).toBe(200);
    expect(secondExecutor.calls).toHaveLength(0);
  });

  test("cancellation is durable and calls the active executor", async () => {
    const app = daemon();
    await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body: JSON.stringify({ content: "slow", instructions: "" }) }));
    await Bun.sleep(0);
    const response = await app.daemon.fetch(request(`/runs/${id}/cancel`, { method: "POST" }));
    expect(await response.json()).toMatchObject({ id, status: "cancelled", text: null, error: null });
    expect(app.executor.cancelled).toEqual([id]);
    await Bun.sleep(0);
    expect(app.daemon.active).toBeNull();
  });

  test("persists a stable error without leaking provider details", async () => {
    const app = daemon();
    await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body: JSON.stringify({ content: "fail", instructions: "" }) }));
    await Bun.sleep(0);
    app.executor.fail(id, new Error("provider rejected sk-secret-value"));
    await Bun.sleep(0);
    const run = await (await app.daemon.fetch(request(`/runs/${id}`))).json();
    expect(run).toMatchObject({ id, status: "failed", text: null, error: "PI_RUN_FAILED" });
    expect(JSON.stringify(run)).not.toContain("sk-secret-value");
  });

  test("enforces content and instruction bounds before journal acceptance", async () => {
    const app = daemon();
    for (const body of [
      { content: "", instructions: "" },
      { content: "x".repeat(55_001), instructions: "" },
      { content: "valid", instructions: "x".repeat(20_001) },
    ]) {
      expect((await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body: JSON.stringify(body) }))).status).toBe(400);
    }
    expect((await app.daemon.fetch(request(`/runs/${id}`))).status).toBe(404);
    expect(app.executor.calls).toHaveLength(0);
  });
});

test('streamed messages and usage survive restart, duplicate requests, and stale progress',async()=>{
 const state=mkdtempSync(join(tmpdir(),'companion-progress-'));
 let calls=0;
 const createdAt=new Date().toISOString();
 const executor:RunExecutor={async execute(_id,_input,progress){calls++;
   progress?.({previewText:'Partial answer',thinkingText:'Checking the requested constraints',usage:{input:10,output:2,cacheRead:0,cacheWrite:0,totalTokens:12,costUsd:0.001},messages:[{sequence:1,text:'Partial answer',createdAt,complete:false}],messageVersion:1});
   progress?.({previewText:'Complete answer',thinkingText:'Checking the requested constraints',usage:{input:10,output:4,cacheRead:0,cacheWrite:0,totalTokens:14,costUsd:0.002},messages:[{sequence:1,text:'Complete answer',createdAt,complete:true}],events:[{sequence:2,kind:'tool',toolName:'search',createdAt,status:'failed'}],messageVersion:2});
   progress?.({previewText:'Stale answer',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,costUsd:0},messages:[{sequence:1,text:'Stale answer',createdAt,complete:false}],messageVersion:1});
   return new Promise(()=>{});},async cancel(){}};
 const first=new AgentDaemon(state,token,executor);
 await first.fetch(request(`/runs/${id}`,{method:'PUT',body:JSON.stringify({content:'hello',instructions:''})}));
 expect(await (await first.fetch(request(`/runs/${id}`))).json()).toMatchObject({status:'running',previewText:'Complete answer',thinkingText:'Checking the requested constraints',usage:{totalTokens:14},messages:[{sequence:1,text:'Complete answer',createdAt,complete:true}],events:[{sequence:2,kind:'tool',toolName:'search',createdAt,status:'failed'}],messageVersion:2});
 expect((await first.fetch(request(`/runs/${id}`,{method:'PUT',body:JSON.stringify({content:'hello',instructions:''})}))).status).toBe(200);
 first.close();const restarted=new AgentDaemon(state,token,executor);open.push(restarted);
 expect(await (await restarted.fetch(request(`/runs/${id}`))).json()).toMatchObject({status:'interrupted',previewText:'Complete answer',thinkingText:'Checking the requested constraints',usage:{totalTokens:14},messages:[{sequence:1,text:'Complete answer',createdAt,complete:true}],events:[{sequence:2,kind:'tool',toolName:'search',createdAt,status:'failed'}],messageVersion:2});
 await restarted.fetch(request(`/runs/${id}`,{method:'PUT',body:JSON.stringify({content:'hello',instructions:''})}));
 expect(calls).toBe(1);
});

test('legacy progress remains unversioned and accepts successive previews',async()=>{
 const state=mkdtempSync(join(tmpdir(),'companion-legacy-progress-'));
 const runId=crypto.randomUUID();
 const executor:RunExecutor={async execute(_id,_input,progress){
   const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,costUsd:0};
   progress?.({previewText:'First preview',usage});
   progress?.({previewText:'Second preview',usage});
   return new Promise(()=>{});
 },async cancel(){}};
 const app=new AgentDaemon(state,token,executor);open.push(app);
 await app.fetch(request(`/runs/${runId}`,{method:'PUT',body:JSON.stringify({content:'hello',instructions:''})}));
 const run=await (await app.fetch(request(`/runs/${runId}`))).json();
 expect(run).toMatchObject({status:'running',previewText:'Second preview'});
 expect(run.messageVersion).toBeUndefined();
 expect(run.messages).toBeUndefined();
});
