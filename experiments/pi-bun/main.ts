// EXPERIMENT: JSON-lines interface for exercising the real SDK, not a product protocol.
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { scriptedModel } from "./scripted-model";
import { mcpTools } from "./mcp-tools";

const started = performance.now();
const emit = (event: unknown) => console.log(JSON.stringify(event));
if (process.argv[2] !== "serve" || !process.argv[3]) throw new Error("Usage: companion-probe serve STATE_DIRECTORY");
const root = resolve(process.argv[3]);
const cwd = join(root, "workspace");
const agentDir = join(root, "pi");
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
modelRuntime.registerProvider("probe", {
  api: "openai-completions", apiKey: "test-only-not-a-secret", baseUrl: "http://127.0.0.1:1",
  streamSimple: scriptedModel,
  models: [{ id: "scripted", name: "Scripted fixture", reasoning: false, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
});
const sessions = new Map<string, Awaited<ReturnType<typeof createAgentSession>>["session"]>();
const mcp = mcpTools();
for (const lane of ["chat", "background"]) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalSkillPaths: [join(dirname(process.execPath), "skills")] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime,
    model: modelRuntime.getModel("probe", "scripted"), thinkingLevel: "off", settingsManager, resourceLoader,
    tools: ["read", "write", "edit", "bash", ...mcp.tools.map(t => t.name)], customTools: mcp.tools,
    sessionManager: SessionManager.continueRecent(cwd, join(root, "sessions", lane)) });
  session.subscribe(event => {
    if (event.type === "agent_settled") {
      const last = session.messages.findLast(m => m.role === "assistant");
      emit({ type: "settled", lane, text: last?.content.filter(c => c.type === "text").map(c => c.text).join(""), stopReason: last?.stopReason });
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") emit({ type: event.type, lane, toolName: event.toolName });
  });
  sessions.set(lane, session);
}
const externalRuntimes = ["node", "bun", "npm", "pnpm", "yarn", "apt", "apt-get", "dpkg"].filter(name =>
  spawnSync("sh", ["-c", 'command -v "$1"', "probe", name]).status === 0);
emit({ type: "ready", platform: process.platform, arch: process.arch, externalRuntimes,
  initMs: performance.now() - started, uptimeMs: process.uptime() * 1000 });
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  void (async () => {
    const command = JSON.parse(line);
    if (command.op === "exit") {
      for (const session of sessions.values()) { await session.abort(); session.dispose(); }
      await mcp.close();
      process.exit(0);
    }
    const session = sessions.get(command.lane);
    if (!session) throw new Error("Unknown lane");
    if (command.op === "prompt") {
      await session.prompt(command.text, { streamingBehavior: "steer",
        preflightResult: accepted => emit({ type: "accepted", id: command.id, accepted }) });
      emit({ type: "prompt_returned", id: command.id });
    } else if (command.op === "history") emit({ type: "history", id: command.id, messages: session.messages });
    else if (command.op === "abort") { await session.abort(); emit({ type: "aborted", id: command.id }); }
    else throw new Error("Unknown operation");
  })().catch(error => emit({ type: "error", message: String(error) }));
});
