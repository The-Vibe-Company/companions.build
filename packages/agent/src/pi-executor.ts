import { buildCompanionInstructions } from "./companion-instructions";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { runtimeSettings, skillCommands, type SkillCommands } from "./skill-commands";
import { scriptedModel, scriptedHumanTool } from "./scripted-model";
import { clearProviderSecrets, takeProviderApiKey } from "./environment";
import { SharedMemory } from "./memory";
import { MemoryService } from "./memory-service";
import { configureModelGateway, withModelGatewayRequest } from "./model-gateway";
import type { RunExecutor, RunInput, RunLane, RunMessage, RunProgress } from "./types";
import {configureAzureFoundry} from './azure-foundry';
import { PLUGIN_ERROR_CODES, type PluginErrorCode } from '../../plugins/execution';

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type ActiveExecution = {
  id: string; lane: RunLane; controller: AbortController; session: Session | null;
  ready: Promise<Session>; submissions: Set<Promise<void>>; accepting: boolean;
  preflight: Promise<void>; preflightDone(): void;
  drained: Promise<void>; drainDone(): void;
  parked: boolean;
  publishText?: string;
  progress:RunProgress;
  modelGateway?:RunInput["modelGateway"];
  onProgress?:(progress:RunProgress)=>void;
  closed:boolean;
  pluginFailureCode?:string;
  pluginFailureTimer?:ReturnType<typeof setTimeout>;
  assistantEnds:number;
  pluginFailureAssistantEnds?:number;
  pluginFailureExplained?:boolean;
};

export interface PiSessionTools {
  tools: import("@earendil-works/pi-coding-agent").ToolDefinition[];
  close?(): Promise<void>;
}
export type PiToolsFactory = (context: {
  runId: string;
  lane: RunLane;
  cwd: string;
  signal?: AbortSignal;
  onPluginFailure?: (code: string) => void;
}) => Promise<PiSessionTools>;
const INITIALIZATION_TIMEOUT_MS = 30_000;
export const PLUGIN_FAILURE_GRACE_MS = 30_000;
export const RUNTIME_CLEANUP_TIMEOUT_MS = 5_000;
export interface PiRuntimeOptions {
  /** Test seam for deterministic runtime deadline scenarios. Production uses the default. */
  pluginFailureGraceMs?: number;
  /** Test seam for non-cooperative cleanup scenarios. Production uses the default. */
  cleanupTimeoutMs?: number;
}

export class PiExecutor implements RunExecutor {
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly sessionsDir: string;
  private readonly modelRuntime: ModelRuntime;
  private readonly provider: string;
  private readonly modelId: string;
  private readonly memory: SharedMemory;
  private readonly persistentMemory: MemoryService;
  private readonly gatewayUrl?: string;
  private readonly active = new Map<string, ActiveExecution>();
  toolsFactory?: PiToolsFactory;
  private readonly cancelled = new Set<string>();

  private constructor(stateDir: string, modelRuntime: ModelRuntime, provider: string, modelId: string, gatewayUrl:string|undefined,
    private readonly runtimeOptions:Required<PiRuntimeOptions>) {
    this.cwd = join(stateDir, "workspace");
    this.agentDir = join(stateDir, "pi");
    this.sessionsDir = join(stateDir, "sessions");
    this.modelRuntime = modelRuntime;
    this.provider = provider;
    this.modelId = modelId;
    this.gatewayUrl = gatewayUrl;
    for (const path of [this.cwd, this.agentDir, this.sessionsDir]) mkdirSync(path, { recursive: true });
    this.memory = new SharedMemory(this.cwd);
    this.persistentMemory = new MemoryService(stateDir);
  }

  static async create(stateDir: string, options:PiRuntimeOptions = {}): Promise<PiExecutor> {
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
    return new PiExecutor(stateDir, modelRuntime, provider, modelId,gatewayUrl,{
      pluginFailureGraceMs: runtimeDuration(options.pluginFailureGraceMs, PLUGIN_FAILURE_GRACE_MS),
      cleanupTimeoutMs: runtimeDuration(options.cleanupTimeoutMs, RUNTIME_CLEANUP_TIMEOUT_MS),
    });
  }

  async listSkillCommands(): Promise<SkillCommands> {
    const session = [...this.active.values()].find(run => run.lane === "main")?.session;
    if (session) return skillCommands(session.resourceLoader, session.settingsManager);
    const settings = runtimeSettings();
    const loader = new DefaultResourceLoader({ cwd: this.cwd, agentDir: this.agentDir, settingsManager: settings });
    await loader.reload();
    return skillCommands(loader, settings);
  }

  async execute(id: string, input: RunInput, onProgress?:(progress:RunProgress)=>void): Promise<{ text: string; publishToChat: boolean }> {
    const lane = input.lane ?? "main";
    if (this.occupiedRoot(lane)) throw new Error("EXECUTOR_BUSY");
    let preflightDone!: () => void;
    const preflight = new Promise<void>(resolve => { preflightDone = resolve; });
    let drainDone!: () => void;
    const drained = new Promise<void>(resolve => { drainDone = resolve; });
    const execution: ActiveExecution = {
      id, lane, controller: new AbortController(), session: null, submissions: new Set(),
      accepting: true, ready: undefined!,
      preflight, preflightDone, parked: false, onProgress,
      drained, drainDone,
      closed: false,
      assistantEnds: 0,
      modelGateway:input.modelGateway,
      progress:{previewText:"",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,costUsd:0},messages:[],messageVersion:0},
    };
    if(this.gatewayUrl&&!input.modelGateway)throw new Error("MODEL_GATEWAY_CREDENTIAL_REQUIRED");
    this.active.set(id, execution);
    if (this.cancelled.has(id)) execution.controller.abort();
    let externalTools: PiSessionTools | undefined;
    try {
      execution.ready = guardedInitialization((async () => {
        externalTools = await this.toolsFactory?.({
          runId: id, lane, cwd: this.cwd, signal: execution.controller.signal,
          onPluginFailure: code => this.pluginFailed(execution, code),
        });
        if (execution.closed || execution.controller.signal.aborted) {
          await boundedCleanup(externalTools?.close?.(), this.runtimeOptions.cleanupTimeoutMs);
          throw abortReason(execution.controller.signal);
        }
        return this.initialize(input, execution, externalTools);
      })(), execution.controller.signal, INITIALIZATION_TIMEOUT_MS);
      // Record the native prompt immediately, before initialization can yield to a steer.
      await abortable(this.submit(execution, input.content, true), execution.controller.signal);
      const session = await execution.ready;
      for (;;) {
        await abortable(Promise.all([...execution.submissions]), execution.controller.signal);
        await abortable(session.waitForIdle(), execution.controller.signal);
        // A steering message arriving during either await belongs to this same response root.
        if (execution.submissions.size === 0 && session.isIdle) break;
      }
      execution.accepting = false;
      execution.preflightDone();
      if (execution.controller.signal.aborted) throw new Error("RUN_CANCELLED");
      const last = session.messages.findLast(message => message.role === "assistant");
      if (last?.role === "assistant" && last.stopReason === "error") {
        throw new Error(execution.pluginFailureCode ?? "MODEL_RESPONSE_FAILED");
      }
      if (execution.pluginFailureCode && !execution.pluginFailureExplained) throw new Error("PLUGIN_RESPONSE_TIMEOUT");
      return { text: execution.publishText ?? session.getLastAssistantText() ?? "", publishToChat: execution.publishText !== undefined };
    } finally {
      execution.accepting = false;
      execution.preflightDone();
      this.emitProgress(execution);
      execution.closed = true;
      if (execution.pluginFailureTimer) clearTimeout(execution.pluginFailureTimer);
      if (!execution.controller.signal.aborted) execution.controller.abort(new Error("RUN_SETTLED"));
      this.cancelled.delete(id);
      try {
        try { execution.session?.dispose(); } catch {}
        let closeWork: Promise<void> | undefined;
        try { closeWork = externalTools?.close?.(); } catch {}
        await boundedCleanup(closeWork, this.runtimeOptions.cleanupTimeoutMs);
        try { this.persistentMemory.afterResponse(); } catch {}
      } finally {
        this.active.delete(id);
        execution.drainDone();
      }
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

  occupiedRoot(lane: RunLane): string | null {
    return [...this.active.values()].find(run => run.lane === lane && (lane === "main" || !run.parked))?.id ?? null;
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
    if (run.lane === "background" && [...this.active.values()].some(other => other.id !== id && other.lane === "background" && !other.parked)) return false;
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
      await abortable(Promise.resolve(this.gatewayUrl
        ? withModelGatewayRequest(execution.id,execution.modelGateway!,prompt) : prompt()), execution.controller.signal);
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
      execution.controller.abort(new Error("RUN_CANCELLED"));
      let abortWork: Promise<void> | undefined;
      try { abortWork = execution.session?.abort(); } catch {}
      await boundedCleanup(Promise.allSettled([abortWork, execution.drained]), this.runtimeOptions.cleanupTimeoutMs);
    }
  }

  private async initialize(input: RunInput, execution: ActiveExecution, extra?: PiSessionTools): Promise<Session> {
    const settingsManager = runtimeSettings();
    const memory = await this.persistentMemory.startupContext();
    const instructions = buildCompanionInstructions({ instructions: input.instructions, memory,
      lane: execution.lane, desktopBoundary: process.env.DESKTOP_BOUNDARY_VERSION === "1" });
    const resourceLoader = new DefaultResourceLoader({ cwd: this.cwd, agentDir: this.agentDir, settingsManager, systemPrompt: instructions.join("\n\n") });
    await resourceLoader.reload();
    const model = this.modelRuntime.getModel(this.provider, input.modelId??this.modelId);
    if (!model) throw new Error("MODEL_NOT_FOUND");
    const sessionDir = execution.lane === "main" ? this.sessionsDir : join(this.sessionsDir, "background", execution.id);
    const testTools = this.provider === "companion-test" ? [scriptedHumanTool(execution.id, this.cwd)] : [];
    const memoryTools = [...this.memory.tools(), ...this.persistentMemory.tools(execution.id)];
    const externalTools = bindRunSignal(extra?.tools ?? [], execution.controller.signal,
      () => !execution.closed && this.active.get(execution.id) === execution);
    mkdirSync(sessionDir, { recursive: true });
    const session = (await createAgentSession({
      cwd: this.cwd, agentDir: this.agentDir, modelRuntime: this.modelRuntime, model,
      settingsManager, resourceLoader, tools: ["read", "write", "edit", "bash", ...memoryTools.map(tool => tool.name), ...externalTools.map(tool => tool.name),
        ...testTools.map(tool => tool.name), ...(execution.lane === "background" ? ["publish_to_chat"] : [])],
      customTools: [...memoryTools, ...externalTools, ...testTools, ...(execution.lane === "background" ? [{
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
      if (execution.closed || this.active.get(execution.id) !== execution) return;
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
        execution.assistantEnds++;
        const usage=event.message.usage;
        for(const key of ['input','output','cacheRead','cacheWrite','totalTokens'] as const){
          const value=usage[key];if(Number.isFinite(value)&&value>=0)execution.progress.usage[key]+=value;
        }
        if(Number.isFinite(usage.cost.total)&&usage.cost.total>=0)execution.progress.usage.costUsd+=usage.cost.total;
        const text=assistantText(event.message);
        const complete=["stop","toolUse","length"].includes(event.message.stopReason);
        if (execution.pluginFailureAssistantEnds !== undefined
          && execution.assistantEnds > execution.pluginFailureAssistantEnds
          && ["stop", "length"].includes(event.message.stopReason) && text.trim()) {
          execution.pluginFailureExplained = true;
        }
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

  close(): void { this.persistentMemory.close(); }

  private emitProgress(execution: ActiveExecution): void {
    if (execution.closed || this.active.get(execution.id) !== execution) return;
    execution.progress.messageVersion=(execution.progress.messageVersion??0)+1;
    try {
      execution.onProgress?.({
        ...execution.progress,
        usage:{...execution.progress.usage},
        messages:execution.progress.messages?.map(message=>({...message})),
      });
    } catch {
      execution.controller.abort(new Error("RUN_JOURNAL_FAILED"));
    }
  }

  private pluginFailed(execution: ActiveExecution, rawCode: string): void {
    if (execution.closed || execution.controller.signal.aborted || this.active.get(execution.id) !== execution) return;
    const code = pluginCode(rawCode);
    if (execution.pluginFailureCode) return;
    execution.pluginFailureCode = code;
    execution.pluginFailureAssistantEnds = execution.assistantEnds;
    execution.pluginFailureTimer = setTimeout(() => {
      if (execution.closed || this.active.get(execution.id) !== execution) return;
      execution.accepting = false;
      execution.controller.abort(new Error("PLUGIN_RESPONSE_TIMEOUT"));
      if (execution.session) {
        try { void boundedCleanup(execution.session.abort(), this.runtimeOptions.cleanupTimeoutMs); } catch {}
      }
    }, this.runtimeOptions.pluginFailureGraceMs);
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
    const abort = () => reject(abortReason(signal));
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

export async function bounded<T>(work: Promise<T>, timeoutMs: number, timeoutCode: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutCode)), timeoutMs);
  });
  try { return await Promise.race([work, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

async function boundedCleanup(work: Promise<unknown> | undefined, timeoutMs: number): Promise<void> {
  if (!work) return;
  try { await bounded(work, timeoutMs, "RUNTIME_CLEANUP_TIMEOUT"); } catch {}
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let removeAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => reject(abortReason(signal));
    signal.addEventListener("abort", stop, { once: true });
    removeAbort = () => signal.removeEventListener("abort", stop);
    if (signal.aborted) stop();
  });
  try { return await Promise.race([work, aborted]); }
  finally { removeAbort(); }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name !== "AbortError"
    ? signal.reason : new Error("RUN_CANCELLED");
}

function pluginCode(code: string): PluginErrorCode {
  return PLUGIN_ERROR_CODES.find(value => value === code) ?? "PLUGIN_REMOTE_FAILED";
}

function bindRunSignal(
  tools: import("@earendil-works/pi-coding-agent").ToolDefinition[],
  rootSignal: AbortSignal,
  active: () => boolean,
): import("@earendil-works/pi-coding-agent").ToolDefinition[] {
  return tools.map(tool => ({
    ...tool,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      const [toolCallId, params, signal, onUpdate, context] = args;
      if (!active() || rootSignal.aborted) throw abortReason(rootSignal);
      const combined = combineSignals(rootSignal, signal);
      const guardedUpdate: typeof onUpdate = onUpdate ? update => {
        if (active() && !combined.signal.aborted) onUpdate(update);
      } : undefined;
      try {
        const result = await tool.execute(toolCallId, params, combined.signal, guardedUpdate, context);
        if (!active() || combined.signal.aborted) throw abortReason(combined.signal);
        return result;
      } finally {
        combined.dispose();
      }
    },
  }));
}

function combineSignals(root: AbortSignal, local?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  if (!local || local === root) return { signal: root, dispose() {} };
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const rootAbort = () => abortFrom(root), localAbort = () => abortFrom(local);
  root.addEventListener("abort", rootAbort, { once: true });
  local.addEventListener("abort", localAbort, { once: true });
  if (root.aborted) abortFrom(root);
  else if (local.aborted) abortFrom(local);
  return {
    signal: controller.signal,
    dispose() {
      root.removeEventListener("abort", rootAbort);
      local.removeEventListener("abort", localAbort);
    },
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

function runtimeDuration(value:number|undefined,fallback:number):number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
