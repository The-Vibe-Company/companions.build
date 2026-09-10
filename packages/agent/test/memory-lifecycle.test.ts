import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { MemoryStore } from "../src/memory-store";
import type { MemoryRecord, MemoryResponse } from "../src/memory-protocol";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function state(): string { const value = mkdtempSync(join(tmpdir(), "memory-lifecycle-")); directories.push(value); return value; }
function memory(response: MemoryResponse): MemoryRecord {
  expect(response.status).toBe("ok"); expect("memory" in response).toBe(true);
  return (response as Extract<MemoryResponse, { memory: MemoryRecord }>).memory;
}
function inspect(store: MemoryStore): MemoryRecord[] {
  const response = store.handle({ op: "inspect", limit: 5 }, "human") as Extract<MemoryResponse, { memories: MemoryRecord[] }>;
  return response.memories;
}

test("persists proposals and requires human approval before current retrieval", () => {
  const store = new MemoryStore(state());
  const proposed = memory(store.handle({ op: "save", operationId: "proposal", content: "Always use violet",
    scope: "user", kind: "preference", provenance: "chat", source: { type: "run", ref: "run-1" } }));
  expect(proposed.approval).toBe("pending");
  expect(store.handle({ op: "read", id: proposed.id })).toEqual({ status: "ok", memories: [] });
  expect(store.handle({ op: "inspect" })).toEqual({ status: "forbidden", error: "MEMORY_AUTHORITY_REQUIRED" });
  expect(inspect(store)[0]?.approval).toBe("pending");
  expect(store.handle({ op: "approve", operationId: "bad-approve", id: proposed.id, expectedVersion: 1 }))
    .toEqual({ status: "forbidden", error: "MEMORY_AUTHORITY_REQUIRED" });
  const approved = memory(store.handle({ op: "approve", operationId: "approve", id: proposed.id, expectedVersion: 1 }, "human"));
  expect(approved).toMatchObject({ approval: "approved", status: "active", version: 2 });
  expect((store.handle({ op: "search", query: "violet" }) as any).memories).toHaveLength(1);
  store.close();
});

test("auto-approves bounded ephemeral context and project facts but not uncertain facts", () => {
  const store = new MemoryStore(state());
  expect(memory(store.handle({ op: "save", operationId: "project", content: "Uses Bun", scope: "project",
    projectKey: "companions", kind: "fact", provenance: "run" })).approval).toBe("approved");
  expect(memory(store.handle({ op: "save", operationId: "context", content: "Working note", scope: "companion",
    kind: "context", missionId: "mission-1", provenance: "run" })).approval).toBe("approved");
  expect(memory(store.handle({ op: "save", operationId: "uncertain", content: "Maybe Bun", scope: "project",
    projectKey: "companions", kind: "fact", provenance: "run", uncertain: true })).approval).toBe("pending");
  store.close();
});

test("activates supersession chains atomically only on approval", () => {
  const store = new MemoryStore(state());
  const old = memory(store.handle({ op: "save", operationId: "old", content: "Port is 3000", scope: "companion",
    kind: "fact", provenance: "setup" }, "human"));
  const replacement = memory(store.handle({ op: "save", operationId: "replacement", content: "Port is 4000", scope: "companion",
    kind: "fact", provenance: "run", supersedes: [{ id: old.id, expectedVersion: old.version }] }));
  expect(replacement.approval).toBe("pending");
  expect(memory(store.handle({ op: "read", id: old.id })).status).toBe("active");
  const accepted = memory(store.handle({ op: "approve", operationId: "accept", id: replacement.id,
    expectedVersion: replacement.version }, "human"));
  expect(accepted.supersedes).toEqual([old.id]);
  const rows = inspect(store);
  expect(rows.find(item => item.id === old.id)).toMatchObject({ status: "superseded", version: 2, supersededBy: [replacement.id] });
  expect(store.handle({ op: "read", id: old.id })).toEqual({ status: "ok", memories: [] });
  expect(store.handle({ op: "save", operationId: "reactivate", id: old.id, expectedVersion: 2, content: "again",
    scope: "companion", kind: "fact", provenance: "bad" }, "human")).toMatchObject({ status: "conflict" });
  const updated = memory(store.handle({ op: "save", operationId: "update-replacement", id: accepted.id,
    expectedVersion: accepted.version, content: "Port is 4001", scope: "companion", kind: "fact", provenance: "review" }, "human"));
  expect(updated.supersedes).toEqual([old.id]);
  const newest = memory(store.handle({ op: "save", operationId: "newest", content: "Port is 5000", scope: "companion",
    kind: "fact", provenance: "review", supersedes: [{ id: updated.id, expectedVersion: updated.version }] }, "human"));
  const chain = inspect(store);
  expect(chain.find(item => item.id === old.id)).toMatchObject({ status: "superseded", supersededBy: [replacement.id] });
  expect(chain.find(item => item.id === updated.id)).toMatchObject({ status: "superseded", supersedes: [old.id], supersededBy: [newest.id] });
  expect(chain.find(item => item.id === newest.id)).toMatchObject({ status: "active", supersedes: [updated.id] });
  store.close();
});

test("filters mission and conversation scopes and retires completed mission sources permanently", () => {
  const store = new MemoryStore(state());
  expect(store.handle({ op: "save", operationId: "unbound-pr", content: "Await merge", scope: "mission", kind: "context",
    missionId: "unbound", provenance: "tracked work", mission: { ticket: "THE-1", workspace: "companions", stopCondition: "pr_merged" } }))
    .toMatchObject({ status: "invalid", error: "MEMORY_SCOPE_INVALID" });
  const mission = memory(store.handle({ op: "save", operationId: "mission", content: "PR deployment state", scope: "mission",
    kind: "fact", provenance: "worker", source: { type: "run", ref: "run-m" }, missionId: "m-1",
    mission: { ticket: "THE-1", workspace: "companions", pr: "https://github.com/Acme/Repo/pull/7/", stopCondition: "pr_merged" } }, "human"));
  const checkpoint = memory(store.handle({ op: "checkpoint", operationId: "checkpoint", threadId: "thread-1", projectKey: "companions",
    decided: ["use sqlite"], open: ["review"], next: ["test"], pointers: [{ type: "ticket", ref: "THE-1" }] }));
  expect(store.handle({ op: "read", id: mission.id, missionId: "other" })).toEqual({ status: "ok", memories: [] });
  expect(memory(store.handle({ op: "read", id: mission.id, missionId: "m-1", projectKey: "companions" })).id).toBe(mission.id);
  expect(store.handle({ op: "read", id: checkpoint.id, conversationId: "other" })).toEqual({ status: "ok", memories: [] });
  expect(store.handle({ op: "brief", threadId: "thread-1", projectKey: "other" })).toEqual({ status: "ok" });
  const otherProject = memory(store.handle({ op: "checkpoint", operationId: "checkpoint-other", threadId: "thread-1", projectKey: "other",
    decided: ["other decision"], open: [], next: [], pointers: [] }));
  expect(otherProject.id).not.toBe(checkpoint.id);
  expect(store.handle({ op: "brief", threadId: "thread-1", projectKey: "companions" })).toMatchObject({
    status: "ok", checkpoint: { decided: ["use sqlite"], open: ["review"], next: ["test"] },
  });
  expect(store.handle({ op: "checkpoint", operationId: "checkpoint-next", threadId: "thread-1", projectKey: "companions",
    decided: ["new decision"], open: [], next: [], pointers: [] })).toMatchObject({
    status: "conflict", error: "MEMORY_THREAD_CLOSED", memory: { id: checkpoint.id },
  });
  memory(store.handle({ op: "retire", operationId: "retire-checkpoint", id: checkpoint.id, expectedVersion: checkpoint.version }));
  expect(store.handle({ op: "checkpoint", operationId: "checkpoint-after-retire", threadId: "thread-1", projectKey: "companions",
    decided: ["reactivate"], open: [], next: [], pointers: [] })).toMatchObject({ status: "conflict", error: "MEMORY_THREAD_CLOSED" });
  expect(store.handle({ op: "observe", operationId: "creating-run-finished", source: { type: "run", ref: "run-m" },
    state: "completed" }, "system")).toEqual({ status: "ok", retired: 0 });
  expect(memory(store.handle({ op: "read", id: mission.id, missionId: "m-1", projectKey: "companions" })).id).toBe(mission.id);
  expect(store.handle({ op: "observe", operationId: "wrong-pr", source: { type: "pr", ref: "https://github.com/acme/repo/pull/8" },
    state: "merged" }, "system")).toEqual({ status: "ok", retired: 0 });
  expect(store.handle({ op: "save", operationId: "after-unrelated", content: "Still open", scope: "mission", kind: "fact",
    provenance: "worker", source: { type: "run", ref: "run-m" }, missionId: "m-unrelated",
    mission: { ticket: "THE-9", workspace: "companions", pr: "https://github.com/acme/repo/pull/9", stopCondition: "pr_merged" } }, "human").status).toBe("ok");
  expect(store.handle({ op: "observe", operationId: "merged", source: { type: "pr", ref: "https://github.com/acme/repo/pull/7" },
    state: "merged" }, "system")).toEqual({ status: "ok", retired: 1 });
  expect(store.handle({ op: "read", id: mission.id, missionId: "m-1", projectKey: "companions" })).toEqual({ status: "ok", memories: [] });
  expect(store.handle({ op: "save", operationId: "resurrect", content: "stale", scope: "mission", kind: "fact",
    provenance: "worker", source: { type: "pr", ref: "https://github.com/ACME/REPO/pull/7/" }, missionId: "m-2",
    mission: { ticket: "THE-2", workspace: "companions", pr: "https://github.com/acme/repo/pull/7", stopCondition: "pr_merged" } }, "human"))
    .toEqual({ status: "conflict", error: "MEMORY_SOURCE_COMPLETED" });
  const work = memory(store.handle({ op: "save", operationId: "work", content: "Task state", scope: "mission", kind: "fact",
    provenance: "worker", source: { type: "ticket", ref: "RUN-UUID" }, missionId: "m-work",
    mission: { ticket: "run-uuid", workspace: "companions", stopCondition: "work_completed" } }, "human"));
  expect(store.handle({ op: "observe", operationId: "work-completed", source: { type: "run", ref: "run-uuid" },
    state: "completed" }, "system")).toEqual({ status: "ok", retired: 1 });
  expect(store.handle({ op: "read", id: work.id, missionId: "m-work", projectKey: "companions" })).toEqual({ status: "ok", memories: [] });
  store.close();
});

test("repository sources are pointers and changed files leave current truth", () => {
  const directory = state(); mkdirSync(join(directory, "workspace")); writeFileSync(join(directory, "workspace", "policy.md"), "first");
  const store = new MemoryStore(directory);
  const record = memory(store.handle({ op: "save", operationId: "repo", content: "invented restatement", scope: "companion",
    kind: "fact", provenance: "repository", source: { type: "repository", ref: "workspace/policy.md" } }, "human"));
  expect(record.content).toBe("See workspace/policy.md"); expect(record.source.revision).toHaveLength(64);
  writeFileSync(join(directory, "workspace", "policy.md"), "second");
  store.handle({ op: "maintain" });
  expect(store.handle({ op: "read", id: record.id })).toEqual({ status: "ok", memories: [] });
  expect(inspect(store)[0]).toMatchObject({ id: record.id, verification: "changed" });
  const changed = inspect(store)[0]!;
  store.handle({ op: "maintain" });
  expect(inspect(store)[0]!.version).toBe(changed.version);
  const edited = memory(store.handle({ op: "save", operationId: "edit-pointer", id: changed.id,
    expectedVersion: changed.version, content: "still a pointer", scope: "companion", kind: "fact", provenance: "review" }, "human"));
  expect(edited.verification).toBe("changed");
  expect(store.handle({ op: "read", id: record.id })).toEqual({ status: "ok", memories: [] });
  expect(store.handle({ op: "observe", operationId: "verified", source: { type: "repository", ref: "workspace/policy.md" },
    state: "verified" }, "system")).toMatchObject({ status: "ok" });
  expect(memory(store.handle({ op: "read", id: record.id })).id).toBe(record.id);
  store.close();
});

test("maintenance retires expiry without deleting retained history", () => {
  const store = new MemoryStore(state());
  const record = memory(store.handle({ op: "save", operationId: "expired", content: "old context", scope: "companion",
    kind: "fact", provenance: "test", expiresAt: "2000-01-01T00:00:00Z" }, "human"));
  expect(store.handle({ op: "maintain" })).toMatchObject({ status: "ok", retired: 1 });
  expect(inspect(store)[0]).toMatchObject({ id: record.id, status: "retired", version: 2 });
  store.close();
});

test("bounds active plus pending records and releases retained capacity on delete", () => {
  const store = new MemoryStore(state()); const records: MemoryRecord[] = [];
  for (let index = 0; index < 100; index++) records.push(memory(store.handle({ op: "save", operationId: `p-${index}`,
    content: `proposal ${index}`, scope: "global", kind: "fact", provenance: "test" })));
  expect(store.handle({ op: "save", operationId: "over", content: "over", scope: "global", kind: "fact", provenance: "test" }))
    .toMatchObject({ status: "consolidation_required", error: "MEMORY_BUDGET_EXCEEDED" });
  expect(store.handle({ op: "delete", operationId: "delete", id: records[0]!.id, expectedVersion: 1 })).toEqual({ status: "ok", deleted: true });
  expect(store.handle({ op: "save", operationId: "after-delete", content: "fits", scope: "global", kind: "fact", provenance: "test" }).status).toBe("ok");
  store.close();
});

test("enforces scope byte and total retained caps on create and update", () => {
  const store = new MemoryStore(state());
  for (let index = 0; index < 16; index++) memory(store.handle({ op: "save", operationId: `bytes-${index}`,
    content: "x".repeat(8_000), scope: "global", kind: "fact", provenance: "test" }));
  const small = memory(store.handle({ op: "save", operationId: "small", content: "x", scope: "global", kind: "fact", provenance: "test" }));
  expect(store.handle({ op: "save", operationId: "large-update", id: small.id, expectedVersion: small.version,
    content: "y".repeat(8_000), scope: "global", kind: "fact", provenance: "test" })).toMatchObject({ status: "consolidation_required" });
  for (let index = 0; index < 483; index++) memory(store.handle({ op: "save", operationId: `retained-${index}`,
    content: "r", scope: "project", projectKey: `p-${index}`, kind: "fact", provenance: "test" }));
  expect(store.handle({ op: "save", operationId: "retained-over", content: "r", scope: "project",
    projectKey: "over", kind: "fact", provenance: "test" })).toMatchObject({ status: "consolidation_required" });
  expect(store.handle({ op: "delete", operationId: "release-total", id: small.id, expectedVersion: small.version })).toEqual({ status: "ok", deleted: true });
  expect(store.handle({ op: "save", operationId: "retained-after", content: "r", scope: "project",
    projectKey: "after", kind: "fact", provenance: "test" }).status).toBe("ok");
  store.close();
});

test("reads raw pre-lifecycle rows without rewriting their stored bytes", () => {
  const directory = state(); mkdirSync(join(directory, "memory"));
  const db = new Database(join(directory, "memory", "memory.sqlite"), { create: true });
  db.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, version INTEGER NOT NULL, content TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('user','companion','project')),
    kind TEXT NOT NULL CHECK(kind IN ('fact','preference','correction','procedure','context')),
    provenance TEXT NOT NULL, project_key TEXT, mission_id TEXT, expires_at TEXT,
    reusable INTEGER NOT NULL DEFAULT 0, explicit INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const raw = ["raw-1", 7, "\u0000legacy bytes 😀", "companion", "fact", "old runtime", null, null, null, 0, 1,
    "2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z"] as const;
  db.query(`INSERT INTO memories
    (id,version,content,scope,kind,provenance,project_key,mission_id,expires_at,reusable,explicit,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...raw);
  db.close();
  const store = new MemoryStore(directory);
  expect(memory(store.handle({ op: "read", id: "raw-1" }))).toMatchObject({
    version: 7, content: raw[2], status: "active", approval: "approved", source: { type: "run", ref: "legacy:old runtime" },
  });
  const check = new Database(join(directory, "memory", "memory.sqlite"));
  expect(check.query("SELECT * FROM memories WHERE id='raw-1'").get()).toEqual({
    id: raw[0], version: raw[1], content: raw[2], scope: raw[3], kind: raw[4], provenance: raw[5],
    project_key: null, mission_id: null, expires_at: null, reusable: 0, explicit: 1, created_at: raw[11], updated_at: raw[12],
  });
  expect(check.query("SELECT * FROM memory_lifecycle WHERE id='raw-1'").get()).toBeNull(); check.close();
  expect(memory(store.handle({ op: "retire", operationId: "retire-raw", id: "raw-1", expectedVersion: 7 })).status).toBe("retired");
  const acquired = new Database(join(directory, "memory", "memory.sqlite"));
  expect(acquired.query("SELECT status FROM memory_lifecycle WHERE id='raw-1'").get()).toEqual({ status: "retired" }); acquired.close();
  store.close();
});

test("legacy adoption overlays lifecycle while preserving every file byte", () => {
  const directory = state(); mkdirSync(join(directory, "workspace"));
  const original = Buffer.from("Legacy bytes\n\u0000end"); writeFileSync(join(directory, "workspace", "MEMORY.md"), original);
  const store = new MemoryStore(directory);
  expect(store.handle({ op: "adopt_legacy", operationId: "no" })).toEqual({ status: "forbidden", error: "MEMORY_AUTHORITY_REQUIRED" });
  const adopted = memory(store.handle({ op: "adopt_legacy", operationId: "adopt" }, "human"));
  expect(adopted).toMatchObject({ id: "legacy-shared-memory", status: "active", approval: "approved" });
  expect(readFileSync(join(directory, "workspace", "MEMORY.md"))).toEqual(original);
  memory(store.handle({ op: "retire", operationId: "retire", id: adopted.id, expectedVersion: adopted.version }));
  expect(store.handle({ op: "read", id: adopted.id })).toEqual({ status: "ok", memories: [] });
  expect(readFileSync(join(directory, "workspace", "MEMORY.md"))).toEqual(original);
  store.close();
});

test("grooming resumes at the last processed record when the byte budget is exhausted", () => {
  const directory=state();mkdirSync(join(directory,'workspace'));
  const store=new MemoryStore(directory);
  const records:MemoryRecord[]=[];
  try {
    for(let index=0;index<12;index++) {
      const ref=`doc-${index}.md`;writeFileSync(join(directory,'workspace',ref),'a'.repeat(40_000));
      records.push(memory(store.handle({op:'save',operationId:`groom-${index}`,scope:'project',projectKey:'groom',kind:'fact',content:'pointer',provenance:'repo',source:{type:'repository',ref}})));
    }
    for(let pass=0;pass<14;pass++)store.handle({op:'maintain'});
    for(const record of records) {
      const read=memory(store.handle({op:'read',id:record.id,projectKey:'groom'}));
      expect(read.verification).toBe('verified');
    }
  } finally {store.close();}
});


test("inspection pages bound checkpoint replies without dropping records or legacy bytes", () => {
  const directory = state(); mkdirSync(join(directory, "workspace"));
  const legacy = "\u0000".repeat(30_000);
  writeFileSync(join(directory, "workspace", "MEMORY.md"), legacy);
  const store = new MemoryStore(directory);
  try {
    const expected = new Set<string>(["legacy-shared-memory"]);
    for (let index = 0; index < 5; index++) {
      expected.add(memory(store.handle({ op: "checkpoint", operationId: `large-${index}`, threadId: `large-${index}`,
        decided: Array(8).fill("a".repeat(980)), open: [], next: [], pointers: [] })).id);
    }
    const seen = new Set<string>(); let cursor: string | undefined;
    do {
      const response = store.handle({ op: "inspect", cursor }, "human");
      if (!("memories" in response)) throw new Error("inspection failed");
      expect(response.memories.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify({ id: "request", response }))).toBeLessThan(256 * 1024);
      if (!response.memories.some(record => record.id === "legacy-shared-memory"))
        expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(64 * 1024);
      for (const record of response.memories) {
        expect(seen.has(record.id)).toBe(false); seen.add(record.id);
        if (record.id === "legacy-shared-memory") expect(record.content).toBe(legacy);
      }
      cursor = "nextCursor" in response ? response.nextCursor : undefined;
    } while (cursor);
    expect(seen).toEqual(expected);
  } finally { store.close(); }
});
