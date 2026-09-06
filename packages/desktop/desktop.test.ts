import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DesktopBroker, serveDesktopBroker } from "./broker";
import { CommandDesktopDriver } from "./driver";
import { DesktopJournal } from "./journal";
import { desktopTools } from "./tools";
import type { DesktopAction, DesktopActionRequest, DesktopDriver, DesktopResult } from "./types";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function journalPath() { const directory = mkdtempSync(join(tmpdir(), "desktop-broker-")); directories.push(directory); return join(directory, "journal.sqlite"); }
const action = (overrides: Partial<DesktopActionRequest> = {}): DesktopActionRequest => ({ id: crypto.randomUUID(), runId: crypto.randomUUID(), generation: 1, action: { kind: "click", x: 10, y: 20, button: "left" }, ...overrides });
const request = (path: string, method = "GET", body?: unknown) => new Request(`http://desktop${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
class FakeDriver implements DesktopDriver {
  calls: DesktopAction[] = [];
  quiescence = 0;
  result: DesktopResult = { kind: "ok" };
  execute(action: DesktopAction) { this.calls.push(action); return Promise.resolve(this.result); }
  async quiesce() { this.quiescence++; }
}

test("boot fails closed until the durable admin generation is explicitly reconciled", async () => {
  const path = journalPath(); const driver = new FakeDriver(); let broker = new DesktopBroker(path, driver);
  expect(await (await broker.handleAgent(request("/state"))).json()).toMatchObject({ generation: 0, taken: true, confirmed: false });
  expect((await broker.handleAgent(request("/actions", "POST", action({ generation: 0 })))).status).toBe(423);
  expect((await broker.handleAdmin(request("/state", "PUT", { generation: 0, taken: false }))).status).toBe(200);
  const payload = action({ generation: 0 });
  expect((await broker.handleAgent(request("/actions", "POST", payload))).status).toBe(200);
  await broker.close();

  broker = new DesktopBroker(path, driver);
  expect(await (await broker.handleAgent(request("/state"))).json()).toMatchObject({ generation: 0, taken: true, confirmed: false });
  expect((await broker.handleAgent(request("/actions", "POST", payload))).status).toBe(200);
  expect(driver.calls).toHaveLength(1);
  expect((await broker.handleAgent(request("/actions", "POST", action()))).status).toBe(423);
  expect((await broker.handleAdmin(request("/state", "PUT", { generation: 0, taken: false }))).status).toBe(200);
  expect((await broker.handleAdmin(request("/state", "PUT", { generation: 1, taken: true }))).status).toBe(200);
  expect((await broker.handleAdmin(request("/state", "PUT", { generation: 0, taken: false }))).status).toBe(409);
  await broker.close();
});

test("agent and admin authority are separated onto permissioned Unix sockets", async () => {
  const path = journalPath(); const directory = dirname(path);
  const agentSocket = join(directory, "agent.sock"); const adminSocket = join(directory, "admin.sock");
  const service = serveDesktopBroker({ agentSocket, adminSocket, journalPath: path, driver: new FakeDriver() });
  const fetchSocket = (socket: string, path: string, init?: RequestInit) => fetch(`http://desktop${path}`, { ...init, unix: socket } as RequestInit & { unix: string });
  try {
    expect((statSync(agentSocket).mode & 0o777).toString(8)).toBe("660");
    expect((statSync(adminSocket).mode & 0o777).toString(8)).toBe("600");
    expect((await fetchSocket(agentSocket, "/state", { method: "PUT", body: "{}" })).status).toBe(404);
    expect((await fetchSocket(adminSocket, "/state")).status).toBe(404);
    expect((await fetchSocket(adminSocket, "/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ generation: 1, taken: false }) })).status).toBe(200);
    expect((await fetchSocket(agentSocket, "/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action()) })).status).toBe(200);
  } finally { await service.stop(); }
});

test("durable action IDs replay results, reject changed payloads and never replay a started action after restart", async () => {
  const path = journalPath(); const driver = new FakeDriver(); const broker = new DesktopBroker(path, driver);
  await broker.handleAdmin(request("/state", "PUT", { generation: 1, taken: false }));
  const payload = action();
  expect((await broker.handleAgent(request("/actions", "POST", payload))).status).toBe(200);
  expect((await broker.handleAgent(request("/actions", "POST", payload))).status).toBe(200);
  expect(driver.calls).toHaveLength(1);
  expect((await broker.handleAgent(request("/actions", "POST", { ...payload, action: { kind: "click", x: 11, y: 20, button: "left" } }))).status).toBe(409);
  await broker.close();

  const journal = new DesktopJournal(path); const uncertain = action();
  expect(journal.claim(uncertain).state).toBe("claimed"); journal.close();
  const restarted = new DesktopBroker(path, driver);
  await restarted.handleAdmin(request("/state", "PUT", { generation: 1, taken: false }));
  const response = await restarted.handleAgent(request("/actions", "POST", uncertain));
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "ambiguous_action" });
  expect(driver.calls).toHaveLength(1);
  await restarted.close();
});

test("takeover closes admission immediately, interrupts the active GUI action, and confirms only after quiescence", async () => {
  const path = journalPath(); let started!: () => void; let cleaned = false;
  const began = new Promise<void>(resolve => { started = resolve; });
  const driver: DesktopDriver = { async execute(_action, signal) {
    started();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { cleaned = true; resolve(); }, { once: true }));
    throw new DOMException("interrupted", "AbortError");
  }, async quiesce() { cleaned = true; } };
  const broker = new DesktopBroker(path, driver);
  await broker.handleAdmin(request("/state", "PUT", { generation: 1, taken: false }));
  const active = broker.handleAgent(request("/actions", "POST", action())); await began;
  const takeover = broker.handleAdmin(request("/state", "PUT", { generation: 2, taken: true }));
  while (!(await (await broker.handleAgent(request("/state"))).json() as any).taken) await Bun.sleep(0);
  expect((await broker.handleAgent(request("/actions", "POST", action({ generation: 2 })))).status).toBe(423);
  expect(await (await takeover).json()).toMatchObject({ generation: 2, taken: true, confirmed: true });
  expect(cleaned).toBe(true); expect((await active).status).toBe(409);
  await broker.close();
});

test("a newer released generation fences the old action before reopening GUI admission", async () => {
  const path = journalPath(); let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let quiescence = 0;
  const driver: DesktopDriver = { async execute(_action, signal) {
    started();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new DOMException("interrupted", "AbortError");
  }, async quiesce() { quiescence++; } };
  const broker = new DesktopBroker(path, driver);
  await broker.handleAdmin(request("/state", "PUT", { generation: 1, taken: false }));
  const active = broker.handleAgent(request("/actions", "POST", action())); await began;
  const advanced = await broker.handleAdmin(request("/state", "PUT", { generation: 2, taken: false }));
  expect(advanced.status).toBe(200);
  expect(await advanced.json()).toMatchObject({ generation: 2, taken: false, confirmed: true });
  expect((await active).status).toBe(409);
  expect(quiescence).toBeGreaterThan(0);
  await broker.close();
});

test("failed quiescence keeps the desktop closed until the same durable state is reconciled", async () => {
  const path = journalPath(); let fail = true;
  const driver: DesktopDriver = { async execute() { return { kind: "ok" }; }, async quiesce() { if (fail) throw new Error("not quiet"); } };
  const broker = new DesktopBroker(path, driver);
  const failed = await broker.handleAdmin(request("/state", "PUT", { generation: 1, taken: false }));
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ error: "desktop_not_quiescent", generation: 1, taken: true, confirmed: false });
  expect((await broker.handleAgent(request("/actions", "POST", action()))).status).toBe(423);
  fail = false;
  expect((await broker.handleAdmin(request("/state", "PUT", { generation: 1, taken: false }))).status).toBe(200);
  expect((await broker.handleAgent(request("/actions", "POST", action()))).status).toBe(200);
  await broker.close();
});

test("command driver uses fixed argv, chunks typing, cleans input state and validates PNG capture", async () => {
  const calls: string[][] = [];
  const png = new Uint8Array(24); png.set([137,80,78,71,13,10,26,10]); png.set([73,72,68,82],12); new DataView(png.buffer).setUint32(16,640); new DataView(png.buffer).setUint32(20,480);
  const driver = new CommandDesktopDriver({ runCommand: async argv => { calls.push([...argv]); return argv[0].includes("capture") ? png : new Uint8Array(); } });
  const signal = new AbortController().signal;
  const capture = await driver.execute({ kind: "screenshot" }, signal);
  expect(capture).toMatchObject({ kind: "screenshot", width: 640, height: 480, mimeType: "image/png" });
  await driver.execute({ kind: "click", x: 40, y: 50, button: "right" }, signal);
  await driver.execute({ kind: "type", text: "x".repeat(260), intervalMs: 5 }, signal);
  await driver.execute({ kind: "key", keys: ["Control_L", "l"] }, signal);
  await driver.execute({ kind: "scroll", deltaX: -2, deltaY: 3 }, signal);
  expect(calls.filter(call => call[1] === "type")).toHaveLength(3);
  expect(calls.some(call => call.join(" ").includes("mousemove --sync 40 50 click 3"))).toBe(true);
  expect(calls.some(call => call.join(" ").includes("key --clearmodifiers Control_L+l"))).toBe(true);
  expect(calls.some(call => call.join(" ").includes("click --repeat 3 --delay 20 5"))).toBe(true);
  expect(calls.some(call => call.join(" ").includes("click --repeat 2 --delay 20 6"))).toBe(true);
  expect(calls.at(-1)).toEqual(["/usr/local/bin/companions-desktop-quiesce"]);
  expect(calls.every(call => ["/usr/bin/xdotool", "/usr/local/bin/companions-desktop-capture", "/usr/local/bin/companions-desktop-quiesce"].includes(call[0]))).toBe(true);
});

test("a stuck process group is killed within the command deadline", async () => {
  const directory = dirname(journalPath());
  const executable = join(directory, "stuck-capture");
  writeFileSync(executable, "#!/bin/sh\ntrap '' TERM\nsleep 10\n"); chmodSync(executable, 0o700);
  const driver = new CommandDesktopDriver({ capturePath: executable, commandTimeoutMs: 25, killGraceMs: 25 });
  const started = performance.now();
  await expect(driver.execute({ kind: "screenshot" }, new AbortController().signal)).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(1_000);
});

test("Pi desktop tools return desktop_paused promptly and use a stable action ID per tool call", async () => {
  const bodies: any[] = [];
  let paused = true;
  const transport = async (path: string, init?: RequestInit) => {
    if (path === "/state") return Response.json({ generation: 4, taken: paused, confirmed: !paused, bootId: "00000000-0000-4000-a000-000000000001" });
    bodies.push(JSON.parse(String(init?.body))); return Response.json({ result: { kind: "ok" } });
  };
  const runId = crypto.randomUUID(); const click = desktopTools({ socketPath: "unused", runId, request: transport })[1];
  const blocked = await click.execute("pi-tool-call", { x: 1, y: 2 }, new AbortController().signal, undefined as never, undefined as never);
  expect((blocked.content[0] as any).text).toContain("desktop_paused"); expect(bodies).toHaveLength(0);
  paused = false;
  await click.execute("pi-tool-call", { x: 1, y: 2 }, new AbortController().signal, undefined as never, undefined as never);
  await click.execute("pi-tool-call", { x: 1, y: 2 }, new AbortController().signal, undefined as never, undefined as never);
  expect(bodies[0].id).toBe(bodies[1].id); expect(bodies[0]).toMatchObject({ runId, generation: 4, action: { kind: "click", x: 1, y: 2, button: "left" } });
});

test("Pi desktop tools reject malformed broker replies and bound an unavailable socket", async () => {
  const runId = crypto.randomUUID();
  const malformed = desktopTools({ socketPath: "unused", runId, request: async () => Response.json({ unexpected: true }) })[0];
  const malformedResult = await malformed.execute("malformed", {}, new AbortController().signal, undefined as never, undefined as never);
  expect((malformedResult.content[0] as any).text).toContain("desktop_unavailable");

  const hanging = desktopTools({ socketPath: "unused", runId, requestTimeoutMs: 20, request: (_path, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }) })[0];
  const started = performance.now();
  const timeoutResult = await hanging.execute("timeout", {}, new AbortController().signal, undefined as never, undefined as never);
  expect(performance.now() - started).toBeLessThan(500);
  expect((timeoutResult.content[0] as any).text).toContain("desktop_unavailable");
});


test("evicting desktop result bytes retains idempotency after restart and never reclaims an old action", () => {
  const path=journalPath();let journal=new DesktopJournal(path,200);
  const old=action();expect(journal.claim(old)).toEqual({state:"claimed"});
  journal.succeed(old.id,{kind:"screenshot",mimeType:"image/png",data:"a".repeat(80),width:1,height:1});
  const fresh=action();expect(journal.claim(fresh)).toEqual({state:"claimed"});
  journal.succeed(fresh.id,{kind:"screenshot",mimeType:"image/png",data:"b".repeat(80),width:1,height:1});
  expect(journal.previous(old)).toEqual({state:"expired"});expect(journal.previous(fresh)?.state).toBe("succeeded");
  journal.close();journal=new DesktopJournal(path,200);
  expect(journal.claim(old)).toEqual({state:"expired"});
  expect(journal.claim({...old,action:{kind:"click",x:90,y:20,button:"left"}})).toEqual({state:"conflict"});
  journal.close();
});
