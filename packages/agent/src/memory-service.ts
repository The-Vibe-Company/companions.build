import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemoryRequest, MemoryResponse } from "./memory-protocol";

type Reply = MemoryResponse | { status: "preparing" | "unavailable"; error: string };
type Pending = { finish: (reply: Reply) => void };
const unavailable = (): Reply => ({ status: "unavailable", error: "MEMORY_UNAVAILABLE" });

/** One lazy process per executor. The daemon never opens SQLite or indexes memory. */
export class MemoryService {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private outstanding = new Set<string>();
  private closed = false;
  private retryAfter = 0;
  private maintenance?: ReturnType<typeof setTimeout>;

  constructor(private readonly stateDir: string, private readonly command?: string[]) {}

  async startupContext(): Promise<string> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.readSnapshot().catch(() => ""),
        new Promise<string>(resolve => { timeout = setTimeout(() => resolve(""), 10); }),
      ]);
    } finally { clearTimeout(timeout); }
  }

  private async readSnapshot(): Promise<string> {
    const directory = join(this.stateDir, "memory");
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return "";
    const file = await open(join(directory, "startup.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096) return "";
      const bytes = Buffer.alloc(4097);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 4096) return "";
      const snapshot = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      if (!Array.isArray(snapshot.memories)) return "";
      const memories = snapshot.memories.filter((record: any) =>
        ["user", "companion"].includes(record.scope) && ["preference", "correction"].includes(record.kind)
        && typeof record.content === "string" && (!record.expiresAt || Date.parse(record.expiresAt) > Date.now()));
      return memories.length ? JSON.stringify({ memories }) : "";
    } finally { await file.close(); }
  }

  afterResponse() {
    if (this.closed || this.maintenance) return;
    this.maintenance = setTimeout(() => {
      this.maintenance = undefined;
      void this.request({ op: "maintain" });
    }, 100);
    this.maintenance.unref();
  }

  request(request: MemoryRequest, signal?: AbortSignal): Promise<Reply> {
    if (this.closed || signal?.aborted || Date.now() < this.retryAfter) return Promise.resolve(unavailable());
    if (this.outstanding.size >= 32) return Promise.resolve({ status: "preparing", error: "MEMORY_BUSY" });
    const child = this.start();
    if (!child) return Promise.resolve(unavailable());
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const mutation = request.op === "save" || request.op === "delete";
      const finish = (reply: Reply) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(reply);
      };
      // Never replay a timed out/aborted mutation: its durable receipt resolves an explicit retry.
      const abort = () => finish({ status: "unavailable", error: mutation ? "MEMORY_OUTCOME_UNKNOWN" : "MEMORY_CANCELLED" });
      const timer = setTimeout(() => finish(mutation
        ? { status: "unavailable", error: "MEMORY_OUTCOME_UNKNOWN" }
        : { status: "preparing", error: "MEMORY_PREPARING" }), mutation ? 2000 : 250);
      this.pending.set(id, { finish });
      this.outstanding.add(id);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(JSON.stringify({ id, request }) + "\n", error => {
        if (error) { this.outstanding.delete(id); finish(unavailable()); }
      });
    });
  }

  private start() {
    if (this.child) return this.child;
    try {
      const command = this.command ?? (process.execPath.endsWith("/bun")
        ? [process.execPath, new URL("./index.ts", import.meta.url).pathname]
        : [process.execPath]);
      const env: Record<string, string> = {};
      if (process.env.AGENT_TEST_MODE === "1") {
        env.AGENT_TEST_MODE = "1";
        if (process.env.MEMORY_TEST_DELAY_MS) env.MEMORY_TEST_DELAY_MS = process.env.MEMORY_TEST_DELAY_MS;
      }
      const child = spawn(command[0]!, [...command.slice(1), "--memory-worker", this.stateDir], { env, stdio: "pipe" });
      this.child = child;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => {
        try {
          if (line.length > 80_000) throw new Error();
          const { id, response } = JSON.parse(line);
          this.outstanding.delete(id);
          this.pending.get(id)?.finish(response);
        } catch { /* Do not surface process output or memory contents in diagnostics. */ }
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      const ended = () => {
        if (this.child !== child) return;
        this.child = undefined;
        this.retryAfter = Date.now() + 1000;
        lines.close();
        this.outstanding.clear();
        for (const entry of [...this.pending.values()]) entry.finish({ status: "unavailable", error: "MEMORY_OUTCOME_UNKNOWN" });
      };
      child.on("error", ended);
      child.on("exit", ended);
      return child;
    } catch { this.retryAfter = Date.now() + 1000; return undefined; }
  }

  close() {
    this.closed = true;
    this.outstanding.clear();
    clearTimeout(this.maintenance);
    for (const entry of [...this.pending.values()]) entry.finish(unavailable());
    this.child?.stdin.end();
    this.child?.kill();
  }

  tools(missionId: string): ToolDefinition[] {
    const text = (maxLength = 200) => Type.String({ minLength: 1, maxLength });
    const identifier = () => Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$" });
    const scope = Type.Union([Type.Literal("user"), Type.Literal("companion"), Type.Literal("project")]);
    const kind = Type.Union(["fact", "preference", "correction", "procedure", "context"].map(value => Type.Literal(value)));
    const definitions = [
      { name: "memory_read", description: "Read a durable memory by ID and obtain its version before updating or deleting it.", parameters: Type.Object({ id: identifier() }), op: "read" },
      { name: "memory_search", description: "Lazily search this Companion's facts, preferences, corrections and procedures. Add projectKey for project context. Temporary context is restricted to this mission. Preparing/unavailable is not an empty result; continue useful work. partial=true means bounded fallback results may be incomplete; retry later if needed.", parameters: Type.Object({ query: text(500), projectKey: Type.Optional(text()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), op: "search" },
      { name: "memory_save", description: "Persist a useful fact or explicit preference/correction. Use a stable operationId for retries; omit id/version to create, pass both to update. On conflict read, merge and retry with a new operationId. Use context for temporary mission details (default expiry 24h). Set reusable only for project setup/procedures explicitly intended for published templates. Never save credentials. Do not claim success unless status is ok. Unknown outcomes must be checked or retried with the SAME operationId and payload.", parameters: Type.Object({ operationId: identifier(), id: Type.Optional(identifier()), expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })), content: text(8000), scope, kind, provenance: text(1000), projectKey: Type.Optional(text()), expiresAt: Type.Optional(text()), reusable: Type.Optional(Type.Boolean()) }), op: "save" },
      { name: "memory_delete", description: "Forget a memory using its observed version and a stable operationId. Set temporary=true only for kind=context records in this mission. On an unknown outcome retry only with the same operationId and payload.", parameters: Type.Object({ operationId: identifier(), id: identifier(), expectedVersion: Type.Integer({ minimum: 1 }), temporary: Type.Optional(Type.Boolean()) }), op: "delete" },
    ];
    return definitions.map(definition => ({
      name: definition.name, label: definition.name.replaceAll("_", " "), description: definition.description, parameters: definition.parameters,
      execute: async (_id: string, params: any, signal?: AbortSignal) => {
        const { temporary, ...input } = params;
        const scoped = definition.op === "read" || definition.op === "search" ||
          (definition.op === "save" && params.kind === "context") || (definition.op === "delete" && temporary === true);
        const request = { ...input, op: definition.op, ...(scoped ? { missionId } : {}) } as MemoryRequest;
        const started = performance.now();
        const value = await this.request(request, signal);
        const metadata = { elapsedMs: Math.round((performance.now() - started) * 100) / 100,
          resultCount: "memories" in value ? value.memories.length : "memory" in value && value.memory ? 1 : 0 };
        return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { ...value, metadata } };
      },
    }));
  }
}
