import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/memory-service";
import { MemoryStore } from "../src/memory-store";

const directories: string[] = [];
const services: MemoryService[] = [];
function fixture(command?: string[]) {
  const state = mkdtempSync(join(tmpdir(), "memory-service-")); directories.push(state);
  const service = new MemoryService(state, command); services.push(service);
  return { state, service };
}
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("startup does not launch the worker or load legacy memory; malformed, oversized and symlink snapshots fail open", async () => {
  const { state, service } = fixture(["/does-not-exist"]);
  mkdirSync(join(state, "workspace"));
  writeFileSync(join(state, "workspace", "MEMORY.md"), "legacy must stay lazy");
  expect(await service.startupContext()).toBe("");
  expect(existsSync(join(state, "memory"))).toBe(false);
  mkdirSync(join(state, "memory"));
  const snapshot = join(state, "memory", "startup.json");
  for (const content of ["not JSON", "x".repeat(5000)]) {
    writeFileSync(snapshot, content);
    expect(await service.startupContext()).toBe("");
  }
  rmSync(snapshot); symlinkSync(join(state, "workspace", "MEMORY.md"), snapshot);
  expect(await service.startupContext()).toBe("");
});

test("bounded startup snapshot includes only unexpired standing preferences and corrections", async () => {
  const { state, service } = fixture();
  mkdirSync(join(state, "memory"));
  writeFileSync(join(state, "memory", "startup.json"), JSON.stringify({ memories: [
    { scope: "user", kind: "preference", content: "Keep summaries concise" },
    { scope: "global", kind: "preference", content: "Retired advice", status: "retired" },
    { scope: "global", kind: "preference", content: "Pending advice", approval: "pending" },
    { scope: "global", kind: "preference", content: "Changed advice", verification: "changed" },
    { scope: "companion", kind: "correction", content: "Use the corrected spelling" },
    { scope: "project", kind: "preference", content: "Other project" },
    { scope: "user", kind: "preference", content: "Expired", expiresAt: "2000-01-01T00:00:00Z" },
    { scope: "companion", kind: "context", content: "Private mission" },
  ] }));
  const snapshot = await service.startupContext();
  expect(snapshot).toContain("Keep summaries concise");
  expect(snapshot).toContain("legacy:startup-snapshot");
  expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(4096);
  expect(snapshot).toContain("corrected spelling");
  expect(snapshot).not.toContain("Expired");
  for (const hidden of ["Retired advice", "Pending advice", "Changed advice"]) expect(snapshot).not.toContain(hidden);
  expect(snapshot).not.toContain("Other project");
  expect(snapshot).not.toContain("Private mission");
});

test("a stalled worker returns preparing and never blocks reading startup context", async () => {
  const { service } = fixture([process.execPath, "-e", "setInterval(()=>{},1000)"]);
  const pending = service.request({ op: "search", query: "hello" });
  expect(await service.startupContext()).toBe("");
  expect(await pending).toMatchObject({ status: "preparing" });
});

test("timed out requests still count against the bounded worker queue", async () => {
  const { service } = fixture([process.execPath, "-e", "setInterval(()=>{},1000)"]);
  const pending = Array.from({ length: 32 }, () => service.request({ op: "search", query: "hello" }));
  await Promise.all(pending);
  expect(await service.request({ op: "search", query: "hello" })).toMatchObject({ status: "preparing", error: "MEMORY_BUSY" });
});

test("worker startup failures are sanitized and ordinary startup stays usable", async () => {
  const { service } = fixture(["/private/provider-secret/nonexistent"]);
  const result = await service.request({ op: "read", id: "id" });
  expect(result.status).toBe("unavailable");
  expect(JSON.stringify(result)).not.toContain("provider-secret");
  expect(await service.startupContext()).toBe("");
});

test("cancellation yields an unknown mutation outcome and does not replay it", async () => {
  const { state, service } = fixture([process.execPath, "-e", `
    const fs=require('node:fs'); const readline=require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      fs.appendFileSync(process.argv.at(-1)+'/received',line+'\\n');
    });
  `]);
  const controller = new AbortController();
  const pending = service.request({ op: "save", operationId: "durable-op", scope: "user", kind: "preference", content: "concise", provenance: "explicit user request" }, controller.signal);
  await Bun.sleep(80); controller.abort();
  expect(await pending).toMatchObject({ status: "unavailable", error: "MEMORY_OUTCOME_UNKNOWN" });
  await Bun.sleep(50);
  const received = await Bun.file(join(state, "received")).text();
  expect(received.trim().split("\n")).toHaveLength(1);
});

test("memory subprocess receives no provider or daemon credentials", async () => {
  const { service } = fixture([process.execPath, "-e", `
    const readline=require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const {id}=JSON.parse(line);
      console.log(JSON.stringify({id,response:{status:'ok',present:Object.keys(process.env).filter(k=>/TOKEN|API_KEY|SECRET/.test(k))}}));
    });
  `]);
  expect(await service.request({ op: "maintain" })).toMatchObject({ status: "ok", present: [] });
});

test("durable delete retries survive a new execution while temporary deletes stay mission scoped", async () => {
  const { state, service } = fixture();
  const store = new MemoryStore(state);
  try {
    const saved = store.handle({ op: "save", operationId: "durable", scope: "user", kind: "preference", content: "concise", provenance: "fixture" });
    if (!("memory" in saved)) throw new Error("fixture save failed");
    const request = { operationId: "forget-durable", id: saved.memory!.id, expectedVersion: 1 };
    const remove = (mission: string, params: typeof request & { temporary?: boolean }) => service.tools(mission).find(tool => tool.name === "memory_delete")!.execute("fixture-delete", params, undefined, undefined, {} as any);
    const deleted = (await remove("first-run", request)).details as any;
    expect(deleted).toMatchObject({ status: "ok", deleted: true, metadata: { resultCount: 0 } });
    expect(deleted.metadata.elapsedMs).toBeGreaterThanOrEqual(0);
    expect((await remove("later-run", request)).details).toMatchObject({ status: "ok", deleted: true });
    const context = store.handle({ op: "save", operationId: "temporary", scope: "companion", kind: "context", missionId: "first-run", content: "private task", provenance: "fixture" });
    if (!("memory" in context)) throw new Error("fixture save failed");
    const scoped = { operationId: "forget-temporary", id: context.memory!.id, expectedVersion: 1, temporary: true };
    expect((await remove("later-run", scoped)).details).toMatchObject({ status: "conflict" });
    expect((await remove("first-run", { ...scoped, operationId: "forget-owned" })).details).toMatchObject({ status: "ok", deleted: true });
  } finally { store.close(); }
});


test("the private transport preserves a fully escaped maximum-size legacy record", async () => {
  const { service } = fixture([process.execPath, "-e", `
    const readline=require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const {id}=JSON.parse(line);
      console.log(JSON.stringify({id,response:{status:'ok',memory:{content:String.fromCharCode(0).repeat(30000)}}}));
    });
  `]);
  const response = await service.request({ op: "read", id: "legacy-shared-memory" });
  expect(response).toMatchObject({ status: "ok", memory: { content: "\u0000".repeat(30_000) } });
});


test("confirmed legacy replacement crosses daemon and worker input limits without truncation", async () => {
  const { service } = fixture();
  const content = "\u0000".repeat(30_000);
  const request = { op: "legacy_replace", operationId: "escaped-replace", expectedVersion: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", content };
  const response = await service.handleRequest(new Request("http://daemon/memory", { method: "POST",
    body: JSON.stringify({ request, authority: "human" }) }));
  expect(await response!.json()).toMatchObject({ status: "ok", legacy: { content } });
});
