import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { scriptedModel, scriptedHumanTool } from "./scripted-model";
import { takeProviderApiKey } from "./environment";
import type { RunExecutor, RunInput, RunLane, RunProgress } from "./types";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type ActiveExecution = {
  id: string; lane: RunLane; controller: AbortController; session: Session | null;
  ready: Promise<Session>; submissions: Set<Promise<void>>; accepting: boolean;
  preflight: Promise<void>; preflightDone(): void;
  parked: boolean;
  publishText?: string;
  progress:RunProgress;
  onProgress?:(progress:RunProgress)=>void;
};

export interface PiSessionTools {
  tools: import("@earendil-works/pi-coding-agent").ToolDefinition[];
  close?(): Promise<void>;
}
export type PiToolsFactory = (context: { runId: string; lane: RunLane; cwd: string }) => Promise<PiSessionTools>;
const INITIALIZATION_TIMEOUT_MS = 30_000;

export class PiExecutor implements RunExecutor {
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly sessionsDir: string;
  private readonly modelRuntime: ModelRuntime;
  private readonly provider: string;
  private readonly modelId: string;
  private readonly active = new Map<string, ActiveExecution>();
  toolsFactory?: PiToolsFactory;
  private readonly cancelled = new Set<string>();

  private constructor(stateDir: string, modelRuntime: ModelRuntime, provider: string, modelId: string) {
    this.cwd = join(stateDir, "workspace");
    this.agentDir = join(stateDir, "pi");
    this.sessionsDir = join(stateDir, "sessions");
    this.modelRuntime = modelRuntime;
    this.provider = provider;
    this.modelId = modelId;
    for (const path of [this.cwd, this.agentDir, this.sessionsDir]) mkdirSync(path, { recursive: true });
  }

  static async create(stateDir: string): Promise<PiExecutor> {
    mkdirSync(stateDir, { recursive: true });
    const testMode = process.env.AGENT_TEST_MODE === "1";
    const provider = testMode ? "companion-test" : requiredEnvironment("MODEL_PROVIDER");
    const modelId = testMode ? "scripted" : requiredEnvironment("MODEL_ID");
    const providerApiKey = takeProviderApiKey(provider);
    if (!testMode && !providerApiKey) throw new Error("MISSING_MODEL_API_KEY");
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(stateDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false,
    });
    if (testMode) {
      modelRuntime.registerProvider(provider, {
        api: "openai-completions", apiKey: "test-only", baseUrl: "http://127.0.0.1:1", streamSimple: scriptedModel,
        models: [{ id: modelId, name: "Companion scripted fixture", reasoning: false, input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      });
    }
    if (providerApiKey) await modelRuntime.setRuntimeApiKey(provider, providerApiKey);
    if (!modelRuntime.getModel(provider, modelId)) throw new Error("MODEL_NOT_FOUND");
    return new PiExecutor(stateDir, modelRuntime, provider, modelId);
  }

  async execute(id: string, input: RunInput, onProgress?:(progress:RunProgress)=>void): Promise<{ text: string; publishToChat: boolean }> {
    const lane = input.lane ?? "main";
    if ([...this.active.values()].some(run => run.lane === lane && run.accepting && (lane === "main" || !run.parked))) throw new Error("EXECUTOR_BUSY");
    let preflightDone!: () => void;
    const preflight = new Promise<void>(resolve => { preflightDone = resolve; });
    const execution: ActiveExecution = {
      id, lane, controller: new AbortController(), session: null, submissions: new Set(),
      accepting: true, ready: undefined!,
      preflight, preflightDone, parked: false, onProgress,
      progress:{previewText:"",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,costUsd:0}},
    };
    this.active.set(id, execution);
    if (this.cancelled.has(id)) execution.controller.abort();
    let externalTools: PiSessionTools | undefined;
    try {
      execution.ready = guardedInitialization((async () => {
        externalTools = await this.toolsFactory?.({ runId: id, lane, cwd: this.cwd });
        return this.initialize(input, execution, externalTools);
      })(), execution.controller.signal, INITIALIZATION_TIMEOUT_MS);
      // Record the native prompt immediately, before initialization can yield to a steer.
      await this.submit(execution, input.content, true);
      const session = await execution.ready;
      for (;;) {
        await Promise.all([...execution.submissions]);
        await session.waitForIdle();
        // A steering message arriving during either await belongs to this same response root.
        if (execution.submissions.size === 0 && session.isIdle) break;
      }
      execution.accepting = false;
      execution.preflightDone();
      if (execution.controller.signal.aborted) throw new Error("RUN_CANCELLED");
      const last = session.messages.findLast(message => message.role === "assistant");
      if (last?.role === "assistant" && last.stopReason === "error") throw new Error("MODEL_RESPONSE_FAILED");
      return { text: execution.publishText ?? session.getLastAssistantText() ?? "", publishToChat: execution.publishText !== undefined };
    } finally {
      execution.accepting = false;
      execution.preflightDone();
      execution.session?.dispose();
      await externalTools?.close?.();
      this.cancelled.delete(id);
      this.active.delete(id);
    }
  }

  async steer(rootId: string, _id: string, input: RunInput): Promise<void> {
    const execution = this.active.get(rootId);
    if (!execution || execution.lane !== "main" || !execution.accepting) throw new Error("PI_RESPONSE_SETTLED");
    await this.submit(execution, input.content);
  }

  acceptingRoot(lane: RunLane): string | null {
    return [...this.active.values()].find(run => run.lane === lane && run.accepting && (lane === "main" || !run.parked))?.id ?? null;
  }

  async suspend(id: string): Promise<boolean> {
    const run = this.active.get(id);
    if (!run?.accepting || run.controller.signal.aborted) return false;
    run.parked = true;
    return true;
  }

  async resume(id: string): Promise<boolean> {
    const run = this.active.get(id);
    if (!run?.accepting || run.controller.signal.aborted) return false;
    if (run.lane === "background" && [...this.active.values()].some(other => other.id !== id && other.lane === "background" && other.accepting && !other.parked)) return false;
    run.parked = false;
    return true;
  }

  private submit(execution: ActiveExecution, content: string, first = false): Promise<void> {
    const work = (async () => {
      const session = await execution.ready;
      execution.session = session;
      if (!first) await execution.preflight;
      if (execution.controller.signal.aborted) throw new Error("RUN_CANCELLED");
      if (!execution.accepting) throw new Error("PI_RESPONSE_SETTLED");
      await session.prompt(content, { streamingBehavior: "steer",
        ...(first ? { preflightResult: () => execution.preflightDone() } : {}) });
    })();
    execution.submissions.add(work);
    // Both branches remove it; avoid an unhandled rejected finally promise.
    void work.then(() => execution.submissions.delete(work), () => execution.submissions.delete(work));
    return work;
  }

  async cancel(id: string): Promise<void> {
    this.cancelled.add(id);
    const execution = this.active.get(id);
    if (execution) {
      execution.accepting = false;
      execution.controller.abort();
      if (execution.session) await execution.session.abort();
    }
  }

  private async initialize(input: RunInput, execution: ActiveExecution, extra?: PiSessionTools): Promise<Session> {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } });
    const memoryPath = join(this.cwd, "MEMORY.md");
    let memory = "";
    try { memory = readFileSync(memoryPath, "utf8").slice(0, 30_000); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const instructions = [input.instructions,
      "Your shared long-term memory is MEMORY.md in your workspace. Chat and background tasks share this file, but have separate histories. Read it before changing it; retain durable preferences and useful facts, not every message.",
      memory ? `Current shared memory (read MEMORY.md again before editing):\n${memory}` : "",
      execution.lane === "background" ? "This is an independent background task. Your final answer stays in this task's activity. Call publish_to_chat with a useful result only when the user should see it in the main conversation." : "",
    ].filter(Boolean);
    const resourceLoader = new DefaultResourceLoader({ cwd: this.cwd, agentDir: this.agentDir, settingsManager, appendSystemPrompt: instructions });
    await resourceLoader.reload();
    const model = this.modelRuntime.getModel(this.provider, input.modelId??this.modelId);
    if (!model) throw new Error("MODEL_NOT_FOUND");
    const sessionDir = execution.lane === "main" ? this.sessionsDir : join(this.sessionsDir, "background", execution.id);
    const testTools = this.provider === "companion-test" ? [scriptedHumanTool(execution.id, this.cwd)] : [];
    mkdirSync(sessionDir, { recursive: true });
    const session = (await createAgentSession({
      cwd: this.cwd, agentDir: this.agentDir, modelRuntime: this.modelRuntime, model,
      settingsManager, resourceLoader, tools: ["read", "write", "edit", "bash", ...(extra?.tools.map(tool => tool.name) ?? []),
        ...testTools.map(tool => tool.name), ...(execution.lane === "background" ? ["publish_to_chat"] : [])],
      customTools: [...extra?.tools ?? [], ...testTools, ...(execution.lane === "background" ? [{
        name: "publish_to_chat", label: "Publish result", description: "Publish this task's useful result to the main conversation when the task finishes successfully.",
        parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 50_000 }) }),
        async execute(_toolId: string, params: { text: string }) {
          execution.publishText = params.text;
          return { content: [{ type: "text" as const, text: "Result selected for publication when the task succeeds." }], details: {} };
        },
      }] : [])],
      sessionManager: execution.lane === "main" ? SessionManager.continueRecent(this.cwd, sessionDir) : SessionManager.create(this.cwd, sessionDir),
    })).session;
    // Subscribe before the first prompt. Historical transcript messages are never counted.
    let lastPreviewAt=0;
    session.subscribe(event=>{
      if(event.type==='message_update' && event.message.role==='assistant'){
        execution.progress.previewText=event.message.content.filter(part=>part.type==='text').map(part=>part.text).join('').slice(0,50_000);
        if(Date.now()-lastPreviewAt>=150){lastPreviewAt=Date.now();execution.onProgress?.(execution.progress);}
      }
      if(event.type==='message_end' && event.message.role==='assistant'){
        const usage=event.message.usage;
        for(const key of ['input','output','cacheRead','cacheWrite','totalTokens'] as const){
          const value=usage[key];if(Number.isFinite(value)&&value>=0)execution.progress.usage[key]+=value;
        }
        if(Number.isFinite(usage.cost.total)&&usage.cost.total>=0)execution.progress.usage.costUsd+=usage.cost.total;
        execution.progress.previewText=event.message.content.filter(part=>part.type==='text').map(part=>part.text).join('').slice(0,50_000);
        execution.onProgress?.(execution.progress);
      }
    });
    return session;
  }

}

export async function guardedInitialization<T extends { dispose(): void }>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = () => {};
  let disposedValue: T | undefined;
  const stopped = new Promise<never>((_, reject) => {
    const abort = () => reject(new Error("RUN_CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", abort);
    timer = setTimeout(() => reject(new Error("INITIALIZATION_TIMEOUT")), timeoutMs);
    if (signal.aborted) abort();
  });
  try {
    const value = await Promise.race([work, stopped]);
    if (signal.aborted) { value.dispose(); disposedValue = value; throw new Error("RUN_CANCELLED"); }
    return value;
  } catch (error) {
    // createAgentSession has no AbortSignal. If it resolves after cancellation/timeout, disposal
    // happens here and no code path can call prompt on that late session.
    if (!disposedValue) void work.then(value => value.dispose(), () => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort();
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}
