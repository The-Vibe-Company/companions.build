import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory-store";
import type { MemoryRecord, MemoryResponse } from "../src/memory-protocol";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function state() {
  const directory = mkdtempSync(join(tmpdir(), "companion-memory-store-"));
  directories.push(directory);
  return directory;
}

function saved(response: MemoryResponse): MemoryRecord {
  expect(response.status).toBe("ok");
  expect("memory" in response).toBe(true);
  return (response as Extract<MemoryResponse, { memory: MemoryRecord }>).memory;
}

test("persists records and mutation receipts across restart with atomic CAS", () => {
  const directory = state();
  let store = new MemoryStore(directory);
  const request = { op: "save" as const, operationId: "create-1", content: "Uses PostgreSQL",
    scope: "companion" as const, kind: "fact" as const, provenance: "chat" };
  const first = saved(store.handle(request));
  expect(first.version).toBe(1);
  expect(store.handle(request)).toEqual({ status: "ok", memory: first });
  expect(store.handle({ ...request, content: "changed" })).toEqual({ status: "conflict", error: "MEMORY_OPERATION_CONFLICT" });
  store.close();

  store = new MemoryStore(directory);
  expect(store.handle(request)).toEqual({ status: "ok", memory: first });
  const update = saved(store.handle({ ...request, operationId: "update-1", id: first.id,
    expectedVersion: 1, content: "Uses PostgreSQL and Bun" }));
  expect(update.version).toBe(2);
  expect(store.handle({ ...request, operationId: "stale", id: first.id, expectedVersion: 1 }))
    .toEqual({ status: "conflict", error: "MEMORY_VERSION_CONFLICT", memory: update });
  expect(store.handle({ op: "delete", operationId: "delete-1", id: first.id, expectedVersion: 2 }))
    .toEqual({ status: "ok", deleted: true });
  store.close();
  store = new MemoryStore(directory);
  expect(store.handle({ op: "delete", operationId: "delete-1", id: first.id, expectedVersion: 2 }))
    .toEqual({ status: "ok", deleted: true });
  expect(store.handle({ op: "read", id: first.id })).toEqual({ status: "ok", memories: [] });
  store.close();
});

test("validates scope, context, reuse, expiry and UTF-8 byte limits", () => {
  const store = new MemoryStore(state());
  const base = { op: "save" as const, operationId: "valid", content: "a", provenance: "chat",
    scope: "companion" as const, kind: "fact" as const };
  expect(store.handle({ ...base, operationId: "project", scope: "project" })).toEqual({ status: "invalid", error: "MEMORY_SCOPE_INVALID" });
  expect(store.handle({ ...base, operationId: "context", kind: "context" })).toEqual({ status: "invalid", error: "MEMORY_CONTEXT_INVALID" });
  expect(store.handle({ ...base, operationId: "private-reuse", reusable: true })).toEqual({ status: "invalid", error: "MEMORY_REUSABLE_INVALID" });
  expect(store.handle({ ...base, operationId: "large", content: "😀".repeat(2_001) })).toEqual({ status: "invalid", error: "MEMORY_REQUEST_INVALID" });
  const context = saved(store.handle({ ...base, operationId: "mission", kind: "context", missionId: "m1" }));
  expect(Date.parse(context.expiresAt!) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1_000);
  const expired = saved(store.handle({ ...base, operationId: "expired", expiresAt: "2000-01-01T00:00:00.000Z" }));
  expect(store.handle({ op: "read", id: expired.id })).toEqual({ status: "ok", memories: [] });
  store.close();
});

test("isolates mission context and projects without revealing inaccessible records", () => {
  const store = new MemoryStore(state());
  const common = { op: "save" as const, content: "deployment token detail", provenance: "mission" };
  const context = saved(store.handle({ ...common, operationId: "ctx", scope: "companion", kind: "context", missionId: "mission-a" }));
  saved(store.handle({ ...common, operationId: "pa", scope: "project", kind: "fact", projectKey: "A" }));
  saved(store.handle({ ...common, operationId: "pb", scope: "project", kind: "fact", projectKey: "B" }));
  expect((store.handle({ op: "search", query: "deployment", missionId: "mission-b", projectKey: "A" }) as any).memories).toHaveLength(1);
  expect((store.handle({ op: "search", query: "deployment", missionId: "mission-a", projectKey: "A" }) as any).memories).toHaveLength(2);
  expect(store.handle({ op: "read", id: context.id, missionId: "mission-b" })).toEqual({ status: "ok", memories: [] });
  expect(store.handle({ ...common, operationId: "steal", id: context.id, expectedVersion: 1,
    scope: "companion", kind: "fact" })).toEqual({ status: "conflict", error: "MEMORY_VERSION_CONFLICT" });
  expect(store.handle({ op: "delete", operationId: "steal-delete", id: context.id, expectedVersion: 1,
    missionId: "mission-b" })).toEqual({ status: "conflict", error: "MEMORY_VERSION_CONFLICT" });
  store.close();
});

test("search handles Unicode and punctuation, caps snippets/results, and falls back after index damage", () => {
  const directory = state();
  const store = new MemoryStore(directory);
  for (let index = 0; index < 12; index++) saved(store.handle({ op: "save", operationId: `item-${index}`,
    content: `${"x".repeat(1_100)} café C++ numéro ${index}`, scope: "companion", kind: "fact", provenance: "test" }));
  const result = store.handle({ op: "search", query: "café C++", limit: 99 }) as Extract<MemoryResponse, { memories: MemoryRecord[] }>;
  expect(result.memories).toHaveLength(10);
  expect(result.memories.every(memory => memory.content.length <= 1_000)).toBe(true);
  const db = new Database(join(directory, "memory", "memory.sqlite"));
  db.exec("DROP TABLE memory_fts");
  db.close();
  const fallback = store.handle({ op: "search", query: "numéro 4" }) as Extract<MemoryResponse, { memories: MemoryRecord[] }>;
  expect(fallback.memories).toHaveLength(1);
  expect(fallback.memories[0]!.content).toContain("numéro 4");
  store.close();
});

test("legacy MEMORY.md is searched lazily and never overwritten", () => {
  const directory = state();
  mkdirSync(join(directory, "workspace"));
  writeFileSync(join(directory, "workspace", "MEMORY.md"), "Legacy preference: use violet punctuation.");
  const store = new MemoryStore(directory);
  const result = store.handle({ op: "search", query: "violet!" }) as Extract<MemoryResponse, { memories: MemoryRecord[] }>;
  expect(result.memories[0]?.id).toBe("legacy-shared-memory");
  store.handle({ op: "maintain" });
  expect(readFileSync(join(directory, "workspace", "MEMORY.md"), "utf8")).toBe("Legacy preference: use violet punctuation.");
  const db = new Database(join(directory, "memory", "memory.sqlite"));
  expect(db.query("SELECT count(*) AS count FROM memory_legacy_fts WHERE memory_legacy_fts MATCH 'violet'").get()).toEqual({ count: 1 });
  writeFileSync(join(directory, "workspace", "replacement.md"), "Legacy correction: use amber punctuation.");
  renameSync(join(directory, "workspace", "replacement.md"), join(directory, "workspace", "MEMORY.md"));
  expect(store.handle({ op: "search", query: "violet" })).toEqual({ status: "ok", memories: [] });
  expect((store.handle({ op: "search", query: "amber" }) as any).memories[0]?.id).toBe("legacy-shared-memory");
  db.exec("DROP TABLE memory_legacy_fts; CREATE TABLE memory_legacy_fts(broken TEXT)");
  expect((store.handle({ op: "search", query: "amber" }) as any).memories[0]?.id).toBe("legacy-shared-memory");
  store.handle({ op: "maintain" });
  expect(db.query("SELECT count(*) AS count FROM memory_legacy_fts WHERE memory_legacy_fts MATCH 'amber'").get()).toEqual({ count: 1 });
  expect(readFileSync(join(directory, "workspace", "MEMORY.md"), "utf8")).toBe("Legacy correction: use amber punctuation.");
  db.close();
  store.close();
});

test("maintains bounded startup and reusable template snapshots and imports templates once", () => {
  const directory = state();
  const store = new MemoryStore(directory);
  saved(store.handle({ op: "save", operationId: "pref", content: "Use concise replies", scope: "user",
    kind: "preference", provenance: "explicit" }));
  saved(store.handle({ op: "save", operationId: "procedure", content: "Run focused checks", scope: "project",
    projectKey: "THE", kind: "procedure", provenance: "explicit", reusable: true }));
  saved(store.handle({ op: "save", operationId: "private", content: "Private fact", scope: "user",
    kind: "fact", provenance: "explicit" }));
  store.handle({ op: "maintain" });
  const startup = JSON.parse(readFileSync(join(directory, "memory", "startup.json"), "utf8"));
  expect(startup.memories.map((memory: any) => memory.content)).toEqual(["Use concise replies"]);
  expect(lstatSync(join(directory, "memory", "startup.json")).size).toBeLessThanOrEqual(4_096);
  const template = JSON.parse(readFileSync(join(directory, "workspace", "template-memory.json"), "utf8"));
  expect(template).toEqual({ version: 1, memories: [{ content: "Run focused checks", scope: "project",
    kind: "procedure", provenance: "explicit", projectKey: "THE", reusable: true }] });
  store.close();

  const importedState = state();
  mkdirSync(join(importedState, "workspace"));
  writeFileSync(join(importedState, "workspace", "template-memory.json"), JSON.stringify({ version: 1, memories: [
    template.memories[0], { content: "secret", scope: "user", kind: "fact", provenance: "bad", reusable: true },
  ] }));
  let imported = new MemoryStore(importedState);
  let result = imported.handle({ op: "search", query: "focused", projectKey: "THE" }) as Extract<MemoryResponse, { memories: MemoryRecord[] }>;
  expect(result.memories).toHaveLength(1);
  const importedId = result.memories[0]!.id;
  imported.close();
  imported = new MemoryStore(importedState);
  result = imported.handle({ op: "search", query: "focused", projectKey: "THE" }) as Extract<MemoryResponse, { memories: MemoryRecord[] }>;
  expect(result.memories.map(memory => memory.id)).toEqual([importedId]);
  expect((imported.handle({ op: "search", query: "secret" }) as any).memories).toEqual([]);
  imported.close();
});

test("rejects symlinked product paths without replacing them", () => {
  const directory = state();
  const outside = state();
  symlinkSync(outside, join(directory, "memory"));
  const store = new MemoryStore(directory);
  expect(store.handle({ op: "maintain" })).toEqual({ status: "unavailable", error: "MEMORY_UNAVAILABLE" });
  expect(lstatSync(join(directory, "memory")).isSymbolicLink()).toBe(true);
  store.close();
});

test("commits writes when derived index and snapshots are unavailable", () => {
  const directory = state();
  let store = new MemoryStore(directory);
  const db = new Database(join(directory, "memory", "memory.sqlite"));
  db.exec("DROP TABLE memory_fts");
  db.close();
  const outside = join(state(), "outside.json");
  writeFileSync(outside, "unchanged");
  symlinkSync(outside, join(directory, "memory", "startup.json"));
  const memory = saved(store.handle({ op: "save", operationId: "durable-despite-derivatives",
    content: "Persist even if derived outputs fail", scope: "user", kind: "preference", provenance: "test" }));
  expect(readFileSync(outside, "utf8")).toBe("unchanged");
  store.close();
  store = new MemoryStore(directory);
  expect(store.handle({ op: "read", id: memory.id })).toEqual({ status: "ok", memory });
  store.close();
});

test("rebuilds a damaged index in bounded maintenance batches", () => {
  const directory = state();
  let store = new MemoryStore(directory);
  for (let index = 0; index < 101; index++) saved(store.handle({ op: "save", operationId: `batch-${index}`,
    content: `batchable ${index}`, scope: "companion", kind: "fact", provenance: "test" }));
  store.close();
  const db = new Database(join(directory, "memory", "memory.sqlite"));
  db.exec("DROP TABLE memory_fts");
  db.close();
  store = new MemoryStore(directory);
  expect(store.handle({ op: "maintain" })).toEqual({ status: "ok", more: true });
  expect((store.handle({ op: "search", query: "batchable 100" }) as any).memories).toHaveLength(1);
  expect(store.handle({ op: "maintain" })).toEqual({ status: "ok" });
  store.close();
});

test("other projects cannot crowd a visible match out of indexed or fallback search", () => {
  const directory = state();
  const store = new MemoryStore(directory);
  try {
    const wanted = saved(store.handle({ op: "save", operationId: "wanted", scope: "project", projectKey: "wanted",
      kind: "fact", content: "deployment", provenance: "fixture" }));
    for (let index = 0; index < 501; index++) saved(store.handle({ op: "save", operationId: `other-${index}`, scope: "project", projectKey: "other",
      kind: "fact", content: "deployment", provenance: "fixture" }));
    const query = { op: "search" as const, query: "deployment", projectKey: "wanted" };
    expect((store.handle(query) as any).memories.map((record: MemoryRecord) => record.id)).toEqual([wanted.id]);
    const db = new Database(join(directory, "memory", "memory.sqlite"));
    try { db.exec("DROP TABLE memory_fts"); } finally { db.close(); }
    expect((store.handle(query) as any).memories.map((record: MemoryRecord) => record.id)).toEqual([wanted.id]);
    expect(store.handle({ ...query, projectKey: "other" })).toMatchObject({ status: "ok", partial: true });
  } finally { store.close(); }
});

test("a stale template export cannot resurrect a committed deletion after restart", () => {
  for (const legacyMarkerMissing of [false, true]) {
    const directory = state();
    let store = new MemoryStore(directory);
    const record = saved(store.handle({ op: "save", operationId: "reusable", scope: "companion", kind: "procedure",
      content: "Retired deployment procedure", reusable: true, provenance: "approved setup" }));
    const staleExport = readFileSync(join(directory, "workspace", "template-memory.json"), "utf8");
    store.close();
    if (legacyMarkerMissing) {
      const db = new Database(join(directory, "memory", "memory.sqlite"));
      try { db.exec("DELETE FROM memory_meta WHERE key='template_imported'"); } finally { db.close(); }
    }
    store = new MemoryStore(directory);
    const deletion = { op: "delete" as const, operationId: "retire", id: record.id, expectedVersion: record.version };
    expect(store.handle(deletion)).toEqual({ status: "ok", deleted: true });
    store.close();
    // Equivalent durable state to a crash after DELETE+receipt commit and before export refresh.
    writeFileSync(join(directory, "workspace", "template-memory.json"), staleExport);
    store = new MemoryStore(directory);
    expect(store.handle({ op: "search", query: "Retired deployment" })).toEqual({ status: "ok", memories: [] });
    expect(store.handle(deletion)).toEqual({ status: "ok", deleted: true });
    store.close();
  }
});
