import { buildCompanionInstructions } from "./companion-instructions";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { scriptedModel, scriptedHumanTool } from "./scripted-model";
import { clearProviderSecrets, takeProviderApiKey } from "./environment";
import { SharedMemory } from "./memory";
import { configureModelGateway, withModelGatewayRequest } from "./model-gateway";
import type { RunExecutor, RunInput, RunLane, RunMessage, RunProgress } from "./types";
import {configureAzureFoundry} from './azure-foundry';

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type ActiveExecution = {
  id: string; lane: RunLane; controller: AbortController; session: Session | null;
  ready: Promise<Session>; submissions: Set<Promise<void>>; accepting: boolean;
  preflight: Promise<void>; preflightDone(): void;
  parked: boolean;
  publishText?: string;
  progress:RunProgress;
  modelGateway?:RunInput["modelGateway"];
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
  private readonly memory: SharedMemory;
  private readonly gatewayUrl?: string;
  private readonly active = new Map<string, ActiveExecution>();
  toolsFactory?: PiToolsFactory;
  private readonly cancelled = new Set<string>();

  private constructor(stateDir: string, modelRuntime: ModelRuntime, provider: string, modelId: string, gatewayUrl?:string) {
    this.cwd = join(stateDir, "workspace");
    this.agentDir = join(stateDir, "pi");
    this.sessionsDir = join(stateDir, "sessions");
    this.modelRuntime = modelRuntime;
    this.provider = provider;
    this.modelId = modelId;
    this.gatewayUrl = gatewayUrl;
    for (const path of [this.cwd, this.agentDir, this.sessionsDir]) mkdirSync(path, { recursive: true });
    this.memory = new SharedMemory(this.cwd);
  }

  static async create(stateDir: string): Promise<PiExecutor> {
    mkdirSync(stateDir, { recursive: true });
    const testMode = process.env.AGENT_TEST_MODE === "1";
    const provider = testMode ? "companion-test" : requiredEnvironment("MODEL_PROVIDER");
    const modelId = testMode ? "scripted" : requiredEnvironment("MODEL_ID");
    const rawGatewayUrl=process.env.MODEL_GATEWAY_URL?.trim();
    const providerApiKey = rawGatewayUrl ? (clearProviderSecrets(),undefined) : takeProviderApiKey(provider);
    if (!testMode && !rawGatewayUrl && !providerApiKey) throw new Error("MISSING_MODEL_API_KEY");
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(stateDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false,
    });
    if(provider==='azure-openai-responses')configureAzureFoundry(modelRuntime,requiredEnvironment('AZURE_OPENAI_BASE_URL'));
    if (testMode) {
      modelRuntime.registerProvider(provider, {
        api: "openai-completions", apiKey: "test-only", baseUrl: "http://127.0.0.1:1", streamSimple: scriptedModel,
        models: [{ id: modelId, name: "Companion scripted fixture", reasoning: false, input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      });
    }
    const gatewayUrl=rawGatewayUrl?await configureModelGateway(modelRuntime,provider,rawGatewayUrl,testMode):undefined;
    if (!gatewayUrl&&providerApiKey) await modelRuntime.setRuntimeApiKey(provider, providerApiKey);
    if (!modelRuntime.getModel(provider, modelId)) throw new Error("MODEL_NOT_FOUND");
    return new PiExecutor(stateDir, modelRuntime, provider, modelId,gatewayUrl);
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
      modelGateway:input.modelGateway,
      progress:{previewText:"",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,costUsd:0},messages:[],messageVersion:0},
    };
    if(this.gatewayUrl&&!input.modelGateway)throw new Error("MODEL_GATEWAY_CREDENTIAL_REQUIRED");
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
      this.emitProgress(execution);
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
      const prompt=()=>session.prompt(content, { streamingBehavior: "steer",
        ...(first ? { preflightResult: () => execution.preflightDone() } : {}) });
      await (this.gatewayUrl?withModelGatewayRequest(execution.id,execution.modelGateway!,prompt):prompt());
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
    const memory = this.memory.read().content.slice(0, 30_000);
    const instructions = buildCompanionInstructions({ instructions: input.instructions, memory,
      lane: execution.lane, desktopBoundary: process.env.DESKTOP_BOUNDARY_VERSION === "1" });
    const resourceLoader = new DefaultResourceLoader({ cwd: this.cwd, agentDir: this.agentDir, settingsManager, systemPrompt: instructions.join("\n\n") });
    await resourceLoader.reload();
    const model = this.modelRuntime.getModel(this.provider, input.modelId??this.modelId);
    if (!model) throw new Error("MODEL_NOT_FOUND");
    const sessionDir = execution.lane === "main" ? this.sessionsDir : join(this.sessionsDir, "background", execution.id);
    const testTools = this.provider === "companion-test" ? [scriptedHumanTool(execution.id, this.cwd)] : [];
    const memoryTools = this.memory.tools();
    mkdirSync(sessionDir, { recursive: true });
    const session = (await createAgentSession({
      cwd: this.cwd, agentDir: this.agentDir, modelRuntime: this.modelRuntime, model,
      settingsManager, resourceLoader, tools: ["read", "write", "edit", "bash", ...memoryTools.map(tool => tool.name), ...(extra?.tools.map(tool => tool.name) ?? []),
        ...testTools.map(tool => tool.name), ...(execution.lane === "background" ? ["publish_to_chat"] : [])],
      customTools: [...memoryTools, ...extra?.tools ?? [], ...testTools, ...(execution.lane === "background" ? [{
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
    let activeMessage: { createdAt: string; index?: number } | undefined;
    const updateMessage = (text: string, complete: boolean) => {
      const messages = execution.progress.messages!;
      if (!activeMessage) activeMessage = { createdAt: new Date().toISOString() };
      if (activeMessage.index === undefined) {
        if (!text) return false;
        activeMessage.index = messages.length;
        messages.push({ sequence: messages.length + 1, text, createdAt: activeMessage.createdAt, complete });
        return true;
      }
      const previous = messages[activeMessage.index]!;
      const next: RunMessage = { ...previous, text:text||previous.text, complete: previous.complete || complete };
      if (next.text === previous.text && next.complete === previous.complete) return false;
      messages[activeMessage.index] = next;
      return true;
    };
    session.subscribe(event=>{
      if(event.type==='message_start' && event.message.role==='assistant'){
        activeMessage={createdAt:new Date().toISOString()};
        const text=assistantText(event.message);
        execution.progress.previewText=text.slice(0,50_000);
        if(updateMessage(text,false)){lastPreviewAt=Date.now();this.emitProgress(execution);}
      }
      if(event.type==='message_update' && event.message.role==='assistant'){
        const text=assistantText(event.message);
        execution.progress.previewText=text.slice(0,50_000);
        updateMessage(text,false);
        const thinking=event.message.content.filter(part=>part.type==='thinking').map(part=>part.thinking).join('').slice(0,20_000);
        if(thinking)execution.progress.thinkingText=thinking;
        if(Date.now()-lastPreviewAt>=150){lastPreviewAt=Date.now();this.emitProgress(execution);}
      }
      if(event.type==='message_end' && event.message.role==='assistant'){
        const usage=event.message.usage;
        for(const key of ['input','output','cacheRead','cacheWrite','totalTokens'] as const){
          const value=usage[key];if(Number.isFinite(value)&&value>=0)execution.progress.usage[key]+=value;
        }
        if(Number.isFinite(usage.cost.total)&&usage.cost.total>=0)execution.progress.usage.costUsd+=usage.cost.total;
        const text=assistantText(event.message);
        const complete=["stop","toolUse","length"].includes(event.message.stopReason);
        updateMessage(text,complete);
        const captured=activeMessage?.index===undefined?undefined:execution.progress.messages![activeMessage.index];
        execution.progress.previewText=(text||captured?.text||"").slice(0,50_000);
        const thinking=event.message.content.filter(part=>part.type==='thinking').map(part=>part.thinking).join('').slice(0,20_000);
        if(thinking)execution.progress.thinkingText=thinking;
        this.emitProgress(execution);
        activeMessage=undefined;
      }
    });
    return session;
  }

  private emitProgress(execution: ActiveExecution): void {
    execution.progress.messageVersion=(execution.progress.messageVersion??0)+1;
    execution.onProgress?.({
      ...execution.progress,
      usage:{...execution.progress.usage},
      messages:execution.progress.messages?.map(message=>({...message})),
    });
  }

}

function assistantText(message: {content: readonly unknown[]}): string {
  return message.content.filter((part):part is {type:"text";text:string}=>
    !!part&&typeof part==="object"&&(part as {type?:unknown}).type==="text"&&typeof (part as {text?:unknown}).text==="string")
    .map(part=>part.text).join("");
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
