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
