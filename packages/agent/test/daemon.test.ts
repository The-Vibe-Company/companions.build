import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentDaemon } from "../src/daemon";
import type { RunExecutor, RunInput } from "../src/types";

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
  execute(id: string, input: RunInput): Promise<{ text: string }> {
    this.calls.push({ id, input });
    return new Promise((resolve, reject) => { this.resolves.set(id, resolve); this.rejects.set(id, reject); });
  }
  async cancel(id: string) { this.cancelled.push(id); this.rejects.get(id)?.(new Error("RUN_CANCELLED")); }
  finish(id: string, text: string) { this.resolves.get(id)?.({ text }); }
  fail(id: string, error: Error) { this.rejects.get(id)?.(error); }
}

function daemon(state = mkdtempSync(join(tmpdir(), "companion-agent-")), executor = new ControlledExecutor()) {
  const value = new AgentDaemon(state, token, executor); open.push(value); return { state, executor, daemon: value };
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
      { content: "x".repeat(50_001), instructions: "" },
      { content: "valid", instructions: "x".repeat(20_001) },
    ]) {
      expect((await app.daemon.fetch(request(`/runs/${id}`, { method: "PUT", body: JSON.stringify(body) }))).status).toBe(400);
    }
    expect((await app.daemon.fetch(request(`/runs/${id}`))).status).toBe(404);
    expect(app.executor.calls).toHaveLength(0);
  });
});
