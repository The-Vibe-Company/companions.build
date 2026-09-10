import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MEMORY_TRANSPORT_MAX_BYTES, readMemoryJson } from "./memory-protocol";
import type { MemoryRequest, MemoryResponse, MemoryAuthority } from "./memory-protocol";

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
        ["user", "companion", "global"].includes(record.scope) && ["preference", "correction"].includes(record.kind)
        && (!record.status || record.status === "active") && (!record.approval || record.approval === "approved")
        && !["changed", "missing"].includes(record.verification)
        && typeof record.content === "string" && (!record.expiresAt || Date.parse(record.expiresAt) > Date.now()));
      const accepted: unknown[] = [];
      for (const record of memories) {
        const value = { ...record, provenance: record.provenance ?? "Legacy startup snapshot; read by ID for original provenance",
          source: record.source ?? { type: "run", ref: "legacy:startup-snapshot" } };
        if (Buffer.byteLength(JSON.stringify({ memories: [...accepted, value] })) <= 4096) accepted.push(value);
      }
      return accepted.length ? JSON.stringify({ memories: accepted }) : "";
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

  request(request: MemoryRequest, signal?: AbortSignal, authority: MemoryAuthority = "agent"): Promise<Reply> {
    if (this.closed || signal?.aborted || Date.now() < this.retryAfter) return Promise.resolve(unavailable());
    if (this.outstanding.size >= 32) return Promise.resolve({ status: "preparing", error: "MEMORY_BUSY" });
    const child = this.start();
    if (!child) return Promise.resolve(unavailable());
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const mutation = !["read", "search", "inspect", "brief", "maintain"].includes(request.op);
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
      child.stdin.write(JSON.stringify({ id, request, authority }) + "\n", error => {
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
          // A 30 KiB legacy file can expand sixfold when JSON-escaped. List pages are smaller.
          if (Buffer.byteLength(line) > MEMORY_TRANSPORT_MAX_BYTES) throw new Error();
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

  /** This route is behind AgentDaemon's server credential, never exposed as an agent tool. */
  async handleRequest(request: Request): Promise<Response | null> {
    if (new URL(request.url).pathname !== "/memory") return null;
    if (request.method !== "POST") return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
    try {
      const input = await readMemoryJson(request);
      if (!input.request || !["human", "system"].includes(input.authority)) throw Error();
      return Response.json(await this.request(input.request, request.signal, input.authority), { headers: { "cache-control": "no-store" } });
    } catch { return Response.json({ status: "invalid", error: "MEMORY_REQUEST_INVALID" }, { status: 400 }); }
  }

  tools(missionId: string): ToolDefinition[] {
    const text = (maxLength = 200) => Type.String({ minLength: 1, maxLength });
    const identifier = () => Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$" });
    const source = Type.Object({ type: Type.Union(["run", "ticket", "pr", "repository"].map(value => Type.Literal(value))), ref: text(1000), revision: Type.Optional(text()) });
    const scope = Type.Union(["user", "companion", "global", "project", "mission", "conversation"].map(value => Type.Literal(value)));
    const kind = Type.Union(["fact", "preference", "correction", "procedure", "context"].map(value => Type.Literal(value)));
    const visibility = { projectKey: Type.Optional(text()), conversationId: Type.Optional(identifier()) };
    const transition = { operationId: identifier(), id: identifier(), expectedVersion: Type.Integer({ minimum: 1 }) };
    const definitions = [
      { name: "memory_read", description: "Read current visible memory with its provenance and version. Supply projectKey/conversationId for scoped records. Memory is a lead: verify at the source before irreversible actions or reporting external completion.", parameters: Type.Object({ id: identifier(), ...visibility }), op: "read" },
      { name: "memory_search", description: "Search active, approved, unexpired visible records. Preparing/unavailable is not an empty result; continue useful work. partial=true means bounded results may be incomplete. Always verify the declared source before relying on a memory for an irreversible action.", parameters: Type.Object({ query: text(500), ...visibility, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), op: "search" },
      { name: "memory_save", description: "Save ephemeral context or a reversible project fact; durable preferences, decisions, corrections and uncertain facts become proposals requiring human confirmation in Memory settings. Repository knowledge must be a source path pointer. Mission scope requires ticket, Workspace and stop condition. pr_merged requires its PR; use work_completed while the PR is unknown. Use supersedes with observed versions to consolidate; consolidation_required means retire/merge before saving more. Never claim a proposal is approved or an unknown save succeeded. Retry unknown outcomes only with the SAME operationId and payload.", parameters: Type.Object({ operationId: identifier(), id: Type.Optional(identifier()), expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })), content: text(8000), scope, kind, provenance: text(1000), source: Type.Optional(source), ...visibility, reviewAfter: Type.Optional(text()), expiresAt: Type.Optional(text()), reusable: Type.Optional(Type.Boolean()), uncertain: Type.Optional(Type.Boolean()),
        mission: Type.Optional(Type.Union([
          Type.Object({ ticket: text(1000), workspace: text(1000), pr: text(1000), stopCondition: Type.Literal("pr_merged") }),
          Type.Object({ ticket: text(1000), workspace: text(1000), pr: Type.Optional(text(1000)), stopCondition: Type.Literal("work_completed") }),
        ])),
        supersedes: Type.Optional(Type.Array(Type.Object({ id: identifier(), expectedVersion: Type.Integer({ minimum: 1 }) }), { maxItems: 10 })) }), op: "save" },
      { name: "memory_retire", description: "Retire an obsolete memory using its observed version. Keeps provenance and history; use the same operationId for retries.", parameters: Type.Object(transition), op: "retire" },
      { name: "memory_delete", description: "Forget a memory with its observed version. Prefer retire to retain provenance. Set temporary=true only for context in this mission. Unknown outcomes require the same operationId and payload.", parameters: Type.Object({ ...transition, temporary: Type.Optional(Type.Boolean()) }), op: "delete" },
      { name: "memory_checkpoint", description: "Close a bounded product thread with structured decided/open/next items and source pointers. This creates ephemeral memory, not durable approved decisions, and never alters Pi sessions, branches, compaction or transcripts. Reuse the operationId on retry. Begin follow-up work with memory_brief.", parameters: Type.Object({ operationId: identifier(), threadId: identifier(), projectKey: Type.Optional(text()), decided: Type.Array(text(1000), { maxItems: 10 }), open: Type.Array(text(1000), { maxItems: 10 }), next: Type.Array(text(1000), { maxItems: 10 }), pointers: Type.Array(source, { maxItems: 10 }) }), op: "checkpoint" },
      { name: "memory_brief", description: "Start a product thread from its latest active structured checkpoint and source pointers. Does not load, rewrite or fork Pi history. Verify pointers before acting.", parameters: Type.Object({ threadId: identifier(), projectKey: Type.Optional(text()) }), op: "brief" },
    ];
    return definitions.map(definition => ({
      name: definition.name, label: definition.name.replaceAll("_", " "), description: definition.description, parameters: definition.parameters,
      execute: async (_id: string, params: any, signal?: AbortSignal) => {
        const { temporary, ...input } = params;
        const scoped = definition.op === "read" || definition.op === "search" ||
          (definition.op === "save" && (params.kind === "context" || params.scope === "mission")) || (definition.op === "delete" && temporary === true);
        const request = { ...input, op: definition.op, ...(scoped ? { missionId } : {}),
          ...(definition.op === "save" && !params.source ? {source:{type:"run",ref:missionId}} : {}) } as MemoryRequest;
        const started = performance.now();
        const value = await this.request(request, signal);
        const metadata = { elapsedMs: Math.round((performance.now() - started) * 100) / 100,
          resultCount: "memories" in value ? value.memories.length : "memory" in value && value.memory ? 1 : 0 };
        return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { ...value, metadata } };
      },
    }));
  }
}
