import {runtimeVersion} from "./runtime-version";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { RunJournal } from "./journal";
import type { RunExecutor, RunInput, RunLane } from "./types";
import { parseModelGatewayCredential } from "./model-gateway";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AgentDaemon {
  readonly journal: RunJournal;
  private readonly activeRuns: Record<RunLane, string | null> = { main: null, background: null };
  private readonly discussionRuns = new Map<string, string>();
  private readonly cancelling = new Set<string>();
  private readonly parkedRuns = new Set<string>();
  private resumingBackground = false;
  private maintenance = false;
  private mutations = 0;

  constructor(stateDir: string, private readonly token: string, private readonly executor: RunExecutor,
    private readonly handleRequest?: (request: Request) => Promise<Response | null>,private readonly desktopBoundaryVersion=0) {
    this.journal = new RunJournal(join(stateDir, "runs.sqlite"));
    this.journal.interruptUnfinished();
  }

  get active(): string | null { return this.activeRuns.main ?? this.discussionRuns.values().next().value ?? null; }

  async fetch(request: Request): Promise<Response> {
    if (!authorized(request.headers.get("authorization"), this.token)) return json({ error: "UNAUTHORIZED" }, 401);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/skill-commands") {
      try {
        return this.executor.listSkillCommands
          ? json(await this.executor.listSkillCommands())
          : json({ error: "SKILLS_UNAVAILABLE" }, 503);
      } catch { return json({ error: "SKILLS_UNAVAILABLE" }, 503); }
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ready: true, version: "0.2.0", runtimeVersion, maintenanceSupported:true, maintenance:this.maintenance, maintenanceReady:this.mutations===0, desktopBoundaryVersion:this.desktopBoundaryVersion, conversationVersion:1, activeRunId: this.active, activeRuns: {...this.activeRuns,main:this.active}, activeDiscussions: Object.fromEntries(this.discussionRuns), parkedRuns: [...this.parkedRuns] });
    }
    if(request.method==='POST'&&url.pathname==='/maintenance'){
      if(this.mutations||this.activeRuns.main||this.activeRuns.background||this.discussionRuns.size||this.parkedRuns.size||this.resumingBackground||this.cancelling.size)return json({error:'AGENT_BUSY'},409);
      this.maintenance=true;
      return json({maintenance:true});
    }
    if(request.method==='DELETE'&&url.pathname==='/maintenance'){
      this.maintenance=false;return json({maintenance:false});
    }
    if(this.maintenance&&request.method!=='GET'&&!url.pathname.startsWith('/runs/'))return json({error:'AGENT_MAINTENANCE'},503);
    const mutating=request.method!=='GET';
    if(mutating)this.mutations++;
    let handled:Response|null|undefined;
    try{handled=await this.handleRequest?.(request);}finally{if(mutating)this.mutations--;}
    if (handled) return handled;
    const match = url.pathname.match(/^\/runs\/([^/]+)(\/cancel|\/suspend|\/resume)?$/);
    if (!match || !UUID.test(match[1])) return json({ error: "NOT_FOUND" }, 404);
    const id = match[1].toLowerCase();
    if (request.method === "PUT" && !match[2]) return this.put(id, request);
    if (request.method === "GET" && !match[2]) {
      const run = this.journal.get(id);
      return run ? json(run) : json({ error: "NOT_FOUND" }, 404);
    }
    if (request.method === "POST" && match[2] === "/cancel") return this.cancel(id);
    if (request.method === "POST" && match[2] === "/suspend") return this.park(id, true);
    if (request.method === "POST" && match[2] === "/resume") return this.park(id, false);
    return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  }

  close(): void { this.journal.close(); }

  private async put(id: string, request: Request): Promise<Response> {
    let input: RunInput;
    try {
      const value = await request.json();
      if (!value || typeof value !== "object" || typeof value.content !== "string" || typeof value.instructions !== "string") {
        return json({ error: "INVALID_REQUEST" }, 400);
      }
      if (value.content.length < 1 || value.content.length > 55_000 || value.instructions.length > (value.conversationId === undefined ? 20_000 : 40_000)) {
        return json({ error: "INVALID_REQUEST" }, 400);
      }
      if(value.conversationId!==undefined && (typeof value.conversationId!=="string" || !UUID.test(value.conversationId) || value.lane==="background"))return json({error:"INVALID_REQUEST"},400);
      if (value.lane !== undefined && value.lane !== "main" && value.lane !== "background") return json({ error: "INVALID_REQUEST" }, 400);
      if(value.modelId!==undefined&&(typeof value.modelId!=="string"||!value.modelId.length||value.modelId.length>200))return json({error:"INVALID_REQUEST"},400);
      const modelGateway=parseModelGatewayCredential(value.modelGateway),gatewayRequired=!!process.env.MODEL_GATEWAY_URL?.trim();
      if((gatewayRequired&&!modelGateway)||(!gatewayRequired&&value.modelGateway!==undefined))return json({error:"INVALID_REQUEST"},400);
      input = { ...(value.conversationId?{conversationId:value.conversationId.toLowerCase()}:{}), ...(value.modelId?{modelId:value.modelId}:{}),...(modelGateway?{modelGateway}:{}),
        content: value.content, instructions: value.instructions, lane: value.lane ?? "main" };
    } catch { return json({ error: "INVALID_REQUEST" }, 400); }

    const existing = this.journal.get(id);
    if (existing) {
      const accepted = this.journal.accept(id, input);
      return accepted.kind === "conflict" ? json({ error: "IDEMPOTENCY_CONFLICT" }, 409) : json(accepted.run);
    }
    if(this.maintenance)return json({error:"AGENT_MAINTENANCE"},503);
    const lane = input.lane ?? "main";
    if (lane === "background" && this.resumingBackground) return json({ error: "BUSY" }, 409);
    const activeRoot = lane === "main" && this.executor.acceptingRoot
      ? this.executor.acceptingRoot(lane,input.conversationId) : input.conversationId ? this.discussionRuns.get(input.conversationId) : this.activeRuns[lane];
    if (activeRoot && (lane === "background" || !this.executor.steer || this.cancelling.has(activeRoot))) {
      return json({ error: "BUSY", activeRunId: activeRoot }, 409);
    }
    const accepted = this.journal.accept(id, input, activeRoot ?? id);
    if (accepted.kind !== "accepted") {
      return accepted.kind === "conflict" ? json({ error: "IDEMPOTENCY_CONFLICT" }, 409) : json(accepted.run);
    }
    if (activeRoot) {
      // The journal is committed before Pi sees a steering message. Failure is observable;
      // the same ID can only be read back, never submitted again after uncertainty.
      void this.executor.steer!(activeRoot, id, input).catch(() => {
        this.journal.settle(id, "interrupted", null, "PI_STEER_FAILED");
      });
    } else {
      if(input.conversationId)this.discussionRuns.set(input.conversationId,id);else this.activeRuns[lane] = id;
      void this.run(id, input);
    }
    return json(accepted.run, 202);
  }

  private async cancel(id: string): Promise<Response> {
    const run = this.journal.get(id);
    if (!run) return json({ error: "NOT_FOUND" }, 404);
    if (run.status !== "running" && run.status !== "needs_input") return json(run);
    const rootId = run.responseRootId;
    this.cancelling.add(rootId);
    try {
      await this.executor.cancel(rootId);
      this.journal.settleGroup(rootId, "cancelled", null, null);
      return json(this.journal.get(id) ?? run);
    } catch {
      this.journal.settleGroup(rootId, "interrupted", null, "PI_ABORT_FAILED");
      return json(this.journal.get(id) ?? run, 500);
    } finally {
      this.cancelling.delete(rootId);
    }
  }

  private async park(id: string, parked: boolean): Promise<Response> {
    const run = this.journal.get(id);
    if (!run) return json({ error: "NOT_FOUND" }, 404);
    if (!["running", "needs_input"].includes(run.status)) return json(run);
    if ((run.status === "needs_input") === parked) return json(run);
    const rootId = run.responseRootId;
    if (this.cancelling.has(rootId)) return json({ error: "CANCELLING" }, 409);
    if (!parked && run.lane === "background" && (this.resumingBackground || (this.activeRuns.background && this.activeRuns.background !== rootId))) {
      return json({ error: "BUSY", activeRunId: this.activeRuns.background }, 409);
    }
    if (!parked && run.lane === "background") this.resumingBackground = true;
    let changed: boolean | undefined;
    try { changed = parked ? await this.executor.suspend?.(rootId) : await this.executor.resume?.(rootId); }
    catch { return json({ error: "RUN_NOT_AVAILABLE" }, 409); }
    finally { if (!parked && run.lane === "background") this.resumingBackground = false; }
    if (!changed) return json({ error: "RUN_NOT_AVAILABLE" }, 409);
    const current = this.journal.get(id);
    if (current && !["running", "needs_input"].includes(current.status)) return json(current);
    this.journal.parkGroup(rootId, parked);
    if (parked) {
      this.parkedRuns.add(rootId);
      if (run.lane === "background" && this.activeRuns.background === rootId) this.activeRuns.background = null;
    } else {
      this.parkedRuns.delete(rootId);
      if(run.conversationId)this.discussionRuns.set(run.conversationId,rootId);else this.activeRuns[run.lane] = rootId;
    }
    return json(this.journal.get(id));
  }

  private async run(id: string, input: RunInput): Promise<void> {
    const lane = input.lane ?? "main";
    if (this.journal.get(id)?.status !== "running") {
      if (input.conversationId) { if(this.discussionRuns.get(input.conversationId)===id)this.discussionRuns.delete(input.conversationId); } else if (this.activeRuns[lane] === id) this.activeRuns[lane] = null;
      return;
    }
    try {
      const result = await this.executor.execute(id, input, progress=>this.journal.progress(id,progress));
      this.journal.settleGroup(id, this.cancelling.has(id) ? "cancelled" : "succeeded", result.text, null, result.publishToChat);
    } catch {
      this.journal.settleGroup(id, this.cancelling.has(id) ? "cancelled" : "failed", null, this.cancelling.has(id) ? null : "PI_RUN_FAILED");
    } finally {
      if (input.conversationId) { if(this.discussionRuns.get(input.conversationId)===id)this.discussionRuns.delete(input.conversationId); } else if (this.activeRuns[lane] === id) this.activeRuns[lane] = null;
      this.parkedRuns.delete(id);
    }
  }
}

function authorized(header: string | null, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
