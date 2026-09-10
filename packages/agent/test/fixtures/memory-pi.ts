import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { MemoryService } from "../../src/memory-service";
import { runMemoryWorker } from "../../src/memory-worker";
import { scriptedModel } from "../../src/scripted-model";

if (process.argv.includes("--memory-worker")) {
  await runMemoryWorker(process.argv.at(-1)!);
} else {
  const state = mkdtempSync(join(tmpdir(), "memory-pi-"));
  const cwd = join(state, "workspace"), agentDir = join(state, "pi"), sessionsDir = join(state, "sessions");
  for (const directory of [cwd, agentDir, sessionsDir]) mkdirSync(directory);
  let memory = new MemoryService(state);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(state, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("memory-proof", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
    streamSimple: scriptedModel, models: [{ id: "scripted", name: "Memory proof", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
  const create = async () => {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 50 }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: await memory.startupContext() });
    await resourceLoader.reload();
    const tools = memory.tools("main-fixture");
    return (await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime: runtime,
      model: runtime.getModel("memory-proof", "scripted"), tools: tools.map(tool => tool.name), customTools: tools,
      sessionManager: SessionManager.continueRecent(cwd, sessionsDir) })).session;
  };
  let session: Awaited<ReturnType<typeof create>> | undefined;
  try {
    session = await create();
    await session.prompt("remember-structured-preference");
    await session.waitForIdle();
    assert.equal(session.getLastAssistantText(), "Structured preference saved.");
    for (let index = 0; index < 3; index++) {
      await session.prompt("Compaction fixture context " + "historical detail ".repeat(100));
      await session.waitForIdle();
    }
    await session.compact();
    assert(session.sessionManager.getEntries().some(entry => entry.type === "compaction"));
    const file = session.sessionManager.getSessionFile();
    session.dispose(); session = undefined;
    memory.close();
    memory = new MemoryService(state);
    session = await create();
    assert.equal(session.sessionManager.getSessionFile(), file);
    assert(session.sessionManager.getEntries().some(entry => entry.type === "compaction"));
    assert((await memory.startupContext()).includes("Use brief answers"));
    await session.prompt("find-structured-preference");
    await session.waitForIdle();
    assert.equal(session.getLastAssistantText(), "Structured preference found.");
    console.log("Native Pi compaction, continuation and independent persistent memory verified.");
  } finally {
    session?.dispose(); memory.close();
    rmSync(state, { recursive: true, force: true });
  }
}
