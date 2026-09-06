import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { scriptedModel } from "./scripted-model";
import { takeProviderApiKey } from "./environment";
import type { RunExecutor, RunInput } from "./types";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type ActiveExecution = { id: string; controller: AbortController; session: Session | null };
const INITIALIZATION_TIMEOUT_MS = 30_000;

export class PiExecutor implements RunExecutor {
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly sessionsDir: string;
  private readonly modelRuntime: ModelRuntime;
  private readonly provider: string;
  private readonly modelId: string;
  private active: ActiveExecution | null = null;
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

  async execute(id: string, input: RunInput): Promise<{ text: string }> {
    if (this.active) throw new Error("EXECUTOR_BUSY");
    const execution: ActiveExecution = { id, controller: new AbortController(), session: null };
    this.active = execution;
    if (this.cancelled.has(id)) execution.controller.abort();
    try {
      const session = await guardedInitialization(this.initialize(input), execution.controller.signal, INITIALIZATION_TIMEOUT_MS);
      execution.session = session;
      let settled!: () => void;
      const settledPromise = new Promise<void>(resolve => { settled = resolve; });
      const unsubscribe = session.subscribe(event => { if (event.type === "agent_settled") settled(); });
      try {
        if (execution.controller.signal.aborted) throw new Error("RUN_CANCELLED");
        const promptPromise = session.prompt(input.content, { streamingBehavior: "steer" });
        // A preflight failure rejects prompt without guaranteeing a settled event.
        await Promise.race([settledPromise, promptPromise]);
        await settledPromise;
        await promptPromise;
        const last = session.messages.findLast(message => message.role === "assistant");
        if (last?.role === "assistant" && last.stopReason === "error") throw new Error("MODEL_RESPONSE_FAILED");
        return { text: session.getLastAssistantText() ?? "" };
      } finally {
        unsubscribe();
        session.dispose();
      }
    } finally {
      this.cancelled.delete(id);
      if (this.active?.id === id) this.active = null;
    }
  }

  async cancel(id: string): Promise<void> {
    this.cancelled.add(id);
    if (this.active?.id === id) {
      this.active.controller.abort();
      if (this.active.session) await this.active.session.abort();
    }
  }

  private async initialize(input: RunInput): Promise<Session> {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd, agentDir: this.agentDir, settingsManager,
      appendSystemPrompt: input.instructions ? [input.instructions] : [],
    });
    await resourceLoader.reload();
    const model = this.modelRuntime.getModel(this.provider, this.modelId);
    if (!model) throw new Error("MODEL_NOT_FOUND");
    return (await createAgentSession({
      cwd: this.cwd, agentDir: this.agentDir, modelRuntime: this.modelRuntime, model,
      settingsManager, resourceLoader, tools: ["read", "write", "edit", "bash"],
      sessionManager: SessionManager.continueRecent(this.cwd, this.sessionsDir),
    })).session;
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
