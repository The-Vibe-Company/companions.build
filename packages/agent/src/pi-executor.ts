import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { scriptedModel } from "./scripted-model";
import type { RunExecutor, RunInput } from "./types";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

export class PiExecutor implements RunExecutor {
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly sessionsDir: string;
  private readonly modelRuntime: ModelRuntime;
  private readonly provider: string;
  private readonly modelId: string;
  private active: { id: string; session: Session } | null = null;
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
    if (!modelRuntime.getModel(provider, modelId)) throw new Error("MODEL_NOT_FOUND");
    return new PiExecutor(stateDir, modelRuntime, provider, modelId);
  }

  async execute(id: string, input: RunInput): Promise<{ text: string }> {
    if (this.active) throw new Error("EXECUTOR_BUSY");
    if (this.cancelled.has(id)) throw new Error("RUN_CANCELLED");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd, agentDir: this.agentDir, settingsManager,
      appendSystemPrompt: input.instructions ? [input.instructions] : [],
    });
    await resourceLoader.reload();
    const model = this.modelRuntime.getModel(this.provider, this.modelId);
    if (!model) throw new Error("MODEL_NOT_FOUND");
    const { session } = await createAgentSession({
      cwd: this.cwd, agentDir: this.agentDir, modelRuntime: this.modelRuntime, model,
      settingsManager, resourceLoader, tools: ["read", "write", "edit", "bash"],
      sessionManager: SessionManager.continueRecent(this.cwd, this.sessionsDir),
    });
    this.active = { id, session };
    let settled!: () => void;
    const settledPromise = new Promise<void>(resolve => { settled = resolve; });
    const unsubscribe = session.subscribe(event => { if (event.type === "agent_settled") settled(); });
    try {
      if (this.cancelled.has(id)) throw new Error("RUN_CANCELLED");
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
      this.cancelled.delete(id);
      if (this.active?.id === id) this.active = null;
    }
  }

  async cancel(id: string): Promise<void> {
    this.cancelled.add(id);
    if (this.active?.id === id) await this.active.session.abort();
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}
