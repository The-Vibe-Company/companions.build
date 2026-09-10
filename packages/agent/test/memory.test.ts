import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedMemory } from "../src/memory";

test("shared memory rejects one of two updates from the same version and persists the winner", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "companion-memory-"));
  const memory = new SharedMemory(workspace);
  const initial = memory.read();

  const results = await Promise.all([
    memory.update(initial.version, "Main lane fact"),
    memory.update(initial.version, "Background lane fact"),
  ]);

  expect(results.filter(result => result.updated)).toHaveLength(1);
  const conflict = results.find(result => !result.updated)!;
  expect(conflict.error).toBe("MEMORY_VERSION_CONFLICT");
  expect(conflict.memory).toEqual(results.find(result => result.updated)!.memory);
  expect(new SharedMemory(workspace).read()).toEqual(conflict.memory);
  expect(readFileSync(join(workspace, "MEMORY.md"), "utf8")).toBe(conflict.memory.content);
});

test("shared memory is isolated by Companion workspace", async () => {
  const firstWorkspace = mkdtempSync(join(tmpdir(), "companion-memory-first-"));
  const secondWorkspace = mkdtempSync(join(tmpdir(), "companion-memory-second-"));
  const first = new SharedMemory(firstWorkspace);
  const second = new SharedMemory(secondWorkspace);

  expect((await first.update(first.read().version, "Only the first Companion knows this")).updated).toBe(true);

  expect(second.read().content).toBe("");
  expect(existsSync(join(secondWorkspace, "MEMORY.md"))).toBe(false);
});

test("legacy tool proposes rather than silently accumulating durable memory", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "legacy-policy-"));
  const memory = new SharedMemory(workspace);
  const result = await memory.tools().find(tool => tool.name === "shared_memory_update")!.execute("proposal", {
    expectedVersion: memory.read().version, content: "A durable preference",
  }, undefined, undefined, {} as any);
  expect(result.details).toMatchObject({ updated: false, error: "MEMORY_CONFIRMATION_REQUIRED" });
  expect(memory.read().content).toBe("");
});

test("human legacy replacement receipts recover observed content without replaying ambiguous file effects", async () => {
  const { MemoryStore } = await import('../src/memory-store');
  const { Database } = await import('bun:sqlite');
  const { createHash } = await import('node:crypto');
  const { mkdirSync, rmSync } = await import('node:fs');
  const state=mkdtempSync(join(tmpdir(),'legacy-receipt-'));mkdirSync(join(state,'workspace'));
  const store=new MemoryStore(state),memory=new SharedMemory(join(state,'workspace'));
  const request={op:'legacy_replace' as const,operationId:'human-replace',expectedVersion:memory.read().version,content:'approved preference'};
  try {
    expect(store.handle(request)).toMatchObject({status:'forbidden'});
    expect(store.handle(request,'human')).toMatchObject({status:'ok',legacy:{content:'approved preference'}});
    expect(store.handle(request,'human')).toMatchObject({status:'ok',legacy:{content:'approved preference'}});
    expect(store.handle({...request,content:'different'},'human')).toMatchObject({status:'conflict'});
    const interrupted={...request,operationId:'interrupted',expectedVersion:memory.read().version,content:'new target'};
    const hash=createHash('sha256').update(JSON.stringify({...interrupted,authority:'human'})).digest('hex');
    const db=new Database(join(state,'memory','memory.sqlite'));
    try {db.query('INSERT INTO memory_meta(key,value) VALUES(?,?)').run('legacy-intent:interrupted',hash);}finally{db.close();}
    expect(store.handle(interrupted,'human')).toMatchObject({status:'conflict',error:'MEMORY_LEGACY_OUTCOME_UNKNOWN'});
    expect(memory.read().content).toBe('approved preference');
    const observed={...interrupted,operationId:'observed'};
    const observedHash=createHash('sha256').update(JSON.stringify({...observed,authority:'human'})).digest('hex');
    const journal=new Database(join(state,'memory','memory.sqlite'));
    try {journal.query('INSERT INTO memory_meta(key,value) VALUES(?,?)').run('legacy-intent:observed',observedHash);}finally{journal.close();}
    await memory.update(memory.read().version,'new target');
    expect(store.handle(observed,'human')).toMatchObject({status:'ok',legacy:{content:'new target'}});
  } finally {store.close();rmSync(state,{recursive:true,force:true});}
});

test("runtime legacy retrieval hides retired content and exposes lifecycle provenance", async () => {
  const {MemoryStore}=await import('../src/memory-store');
  const {mkdirSync,rmSync}=await import('node:fs');
  const state=mkdtempSync(join(tmpdir(),'legacy-filter-'));mkdirSync(join(state,'workspace'));
  const shared=new SharedMemory(join(state,'workspace'));await shared.update(shared.read().version,'Finished mission');
  const store=new MemoryStore(state);
  try {
    const tools=shared.tools(async()=>store.handle({op:'read',id:'legacy-shared-memory'}));
    const read=()=>tools[0]!.execute('read',{},undefined,undefined,{} as any);
    expect((await read()).details).toMatchObject({content:'Finished mission',lifecycle:{status:'active',provenance:'legacy MEMORY.md'}});
    const adopted=store.handle({op:'adopt_legacy',operationId:'adopt'},'human') as any;
    expect(store.handle({op:'retire',operationId:'retire',id:adopted.memory.id,expectedVersion:adopted.memory.version},'human').status).toBe('ok');
    expect((await read()).details).toMatchObject({content:'',status:'not_current'});
    expect(shared.read().content).toBe('Finished mission');
  } finally {store.close();rmSync(state,{recursive:true,force:true});}
});

test("adopted legacy replacements advance lifecycle version once and bind retirement to file content", async () => {
  const {MemoryStore}=await import('../src/memory-store');
  const {Database}=await import('bun:sqlite');
  const {createHash}=await import('node:crypto');
  const {mkdirSync,rmSync}=await import('node:fs');
  const state=mkdtempSync(join(tmpdir(),'legacy-lifecycle-version-'));mkdirSync(join(state,'workspace'));
  const shared=new SharedMemory(join(state,'workspace'));
  await shared.update(shared.read().version,'initial bytes');
  const store=new MemoryStore(state);
  try {
    const adopted=(store.handle({op:'adopt_legacy',operationId:'adopt-version'},'human') as any).memory;
    expect(adopted.version).toBe(1);
    const request={op:'legacy_replace' as const,operationId:'replace-version',expectedVersion:shared.read().version,content:'approved bytes'};
    expect(store.handle(request,'human')).toMatchObject({status:'ok',legacy:{content:'approved bytes'}});
    expect((store.handle({op:'read',id:'legacy-shared-memory'}) as any).memory.version).toBe(2);
    expect(store.handle(request,'human')).toMatchObject({status:'ok',legacy:{content:'approved bytes'}});
    expect((store.handle({op:'read',id:'legacy-shared-memory'}) as any).memory.version).toBe(2);
    expect(store.handle({op:'retire',operationId:'stale-retire',id:'legacy-shared-memory',expectedVersion:1},'human'))
      .toMatchObject({status:'conflict',error:'MEMORY_VERSION_CONFLICT',memory:{version:2}});

    await shared.update(shared.read().version,'out-of-band bytes');
    expect(store.handle({op:'retire',operationId:'changed-retire',id:'legacy-shared-memory',expectedVersion:2},'human'))
      .toMatchObject({status:'conflict',error:'MEMORY_VERSION_CONFLICT'});

    const recovered={op:'legacy_replace' as const,operationId:'crash-recovery',expectedVersion:shared.read().version,content:'recovered bytes'};
    const hash=createHash('sha256').update(JSON.stringify({...recovered,authority:'human'})).digest('hex');
    const db=new Database(join(state,'memory','memory.sqlite'));
    try {db.query('INSERT INTO memory_meta(key,value) VALUES(?,?)').run('legacy-intent:crash-recovery',hash);} finally {db.close();}
    await shared.update(shared.read().version,'recovered bytes');
    expect(store.handle(recovered,'human')).toMatchObject({status:'ok',legacy:{content:'recovered bytes'}});
    expect((store.handle({op:'read',id:'legacy-shared-memory'}) as any).memory.version).toBe(3);
    expect(store.handle(recovered,'human')).toMatchObject({status:'ok'});
    expect((store.handle({op:'read',id:'legacy-shared-memory'}) as any).memory.version).toBe(3);
  } finally {store.close();rmSync(state,{recursive:true,force:true});}
});
