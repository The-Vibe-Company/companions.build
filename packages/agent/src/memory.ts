import { createHash } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const MAX_MEMORY_BYTES = 30_000;
const VERSION = /^[a-f0-9]{64}$/;

export type MemorySnapshot = { content: string; version: string };
export type MemoryUpdate =
  | { updated: true; memory: MemorySnapshot }
  | { updated: false; error: "MEMORY_VERSION_CONFLICT" | "MEMORY_TOO_LARGE"; memory: MemorySnapshot };

export class SharedMemory {
  private readonly path: string;
  private updates: Promise<void> = Promise.resolve();

  constructor(private readonly workspace: string) {
    this.path = join(workspace, "MEMORY.md");
  }

  read(): MemorySnapshot {
    let content = "";
    try {
      const info = lstatSync(this.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("MEMORY_UNSAFE");
      content = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { content, version: version(content) };
  }

  update(expectedVersion: string, content: string): Promise<MemoryUpdate> {
    const operation = this.updates.then(() => this.updateCurrent(expectedVersion, content));
    this.updates = operation.then(() => {}, () => {});
    return operation;
  }

  tools(): ToolDefinition[] {
    return [{
      name: "shared_memory_read",
      label: "Read shared memory",
      description: "Read this Companion's shared long-term memory and its version before updating it.",
      parameters: Type.Object({}),
      execute: async () => result(this.read()),
    }, {
      name: "shared_memory_update",
      label: "Update shared memory",
      description: "Atomically replace this Companion's shared long-term memory. Pass the version from shared_memory_read. A conflict returns the latest memory so you can merge useful facts and retry without overwriting another task.",
      parameters: Type.Object({
        expectedVersion: Type.String({ pattern: VERSION.source, description: "Version returned by the latest shared_memory_read." }),
        content: Type.String({ maxLength: MAX_MEMORY_BYTES, description: "Complete replacement MEMORY.md content, at most 30,000 UTF-8 bytes." }),
      }),
      execute: async (_toolId: string, params: { expectedVersion: string; content: string }) => result(await this.update(params.expectedVersion, params.content)),
    }];
  }

  private updateCurrent(expectedVersion: string, content: string): MemoryUpdate {
    const current = this.read();
    if (!VERSION.test(expectedVersion) || expectedVersion !== current.version) {
      return { updated: false, error: "MEMORY_VERSION_CONFLICT", memory: current };
    }
    if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES) {
      return { updated: false, error: "MEMORY_TOO_LARGE", memory: current };
    }
    const temporary = join(this.workspace, `.MEMORY-${crypto.randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
    return { updated: true, memory: { content, version: version(content) } };
  }
}

function version(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}
