import type { MemoryResponse } from "./memory-protocol";
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

  tools(lifecycle?: () => Promise<MemoryResponse | { status: "preparing"; error: string }>): ToolDefinition[] {
    return [{
      name: "shared_memory_read",
      label: "Read shared memory",
      description: "Read current legacy memory with its content version and lifecycle provenance. Retired content is available only through human inspection. Preparing/unavailable is not empty memory; continue useful work and retry a preparing read later. Memory is a lead; re-verify sources before acting.",
      parameters: Type.Object({}),
      execute: async () => { try {
        const snapshot = this.read();
        if (!lifecycle) return result(snapshot);
        const current = await lifecycle();
        if (current.status !== "ok") return result({ content: "", version: snapshot.version, status: current.status, error: "MEMORY_UNAVAILABLE" });
        if (!("memory" in current) || !current.memory) return result({ content: "", version: snapshot.version, status: "not_current" });
        return result({ content: current.memory.content, version: version(current.memory.content), lifecycle: { status: current.memory.status,
          approval: current.memory.approval, source: current.memory.source, provenance: current.memory.provenance } });
      } catch { return result({ content: "", error: "MEMORY_UNAVAILABLE" }); } },
    }, {
      name: "shared_memory_update",
      label: "Update shared memory",
      description: "Propose a versioned replacement of legacy MEMORY.md for human approval through Memory settings/API. This tool never silently writes durable memory. Prefer structured memory_save proposals and source pointers.",
      parameters: Type.Object({
        expectedVersion: Type.String({ pattern: VERSION.source, description: "Version returned by the latest shared_memory_read." }),
        content: Type.String({ maxLength: MAX_MEMORY_BYTES, description: "Complete replacement MEMORY.md content, at most 30,000 UTF-8 bytes." }),
      }),
      execute: async (_toolId: string, params: { expectedVersion: string; content: string }) => {
        try {
          const current = this.read();
          if (current.version !== params.expectedVersion) return result({ updated: false, error: "MEMORY_VERSION_CONFLICT", memory: current });
          if (Buffer.byteLength(params.content) > MAX_MEMORY_BYTES) return result({ updated: false, error: "MEMORY_TOO_LARGE", memory: current });
          return result({ updated: false, error: "MEMORY_CONFIRMATION_REQUIRED", proposal: params });
        }
        catch { return result({ updated: false, error: "MEMORY_UNAVAILABLE" }); }
      },
    }];
  }

  updateCurrent(expectedVersion: string, content: string): MemoryUpdate {
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

/** Called only after a human command has a durable intent in the memory worker. */
export function replaceLegacyMemory(workspace: string, expectedVersion: string, content: string): MemoryUpdate {
  return new SharedMemory(workspace).updateCurrent(expectedVersion, content);
}
