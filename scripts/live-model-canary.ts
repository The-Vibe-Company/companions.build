/** Optional paid model canary. Uses the selected key, no Box and no production data. */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config, dataDir, encrypt } from "../apps/server/src/config";
import { prepareLocal, agentRequest, modelEnvironment } from "../apps/server/src/machines";
if (config.testMode) throw new Error("Set AGENT_TEST_MODE=0 for the live model canary.");
const id = crypto.randomUUID();
const token = randomBytes(32).toString("hex");
if (!Object.keys(modelEnvironment(token)).some(key => key.endsWith("_API_KEY"))) throw new Error("Configure the selected model provider API key before running the live canary.");
const name = `companions-${createHash("sha256").update(dataDir).digest("hex").slice(0, 10)}-${id}`;
const started = performance.now();
const withTools = process.argv.includes("--tools");
try {
  const endpoint = await prepareLocal({ id, agent_secret: encrypt(token) });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { if ((await agentRequest(endpoint, token, "/health"))?.ready) break; } catch {}
    if (Date.now() > deadline) throw new Error("Live model daemon failed to start; check model configuration.");
    await Bun.sleep(200);
  }
  const runId = crypto.randomUUID();
  await agentRequest(endpoint, token, `/runs/${runId}`, "PUT", {
    content: withTools ? "Create canary.sh containing exactly: printf COMPANIONS_CANARY_OK. Run it with bash, verify the output, then reply with exactly COMPANIONS_CANARY_OK and nothing else."
      : "Reply with exactly COMPANIONS_CANARY_OK and nothing else. Do not use tools.",
    instructions: "Follow the user's requested output exactly." });
  for (;;) {
    const result = await agentRequest(endpoint, token, `/runs/${runId}`);
    if (result.status !== "running") {
      if (result.status !== "succeeded" || result.text?.trim() !== "COMPANIONS_CANARY_OK") throw new Error("Live model canary did not produce the expected result.");
      if (withTools && readFileSync(join(dataDir, "agents", id, "workspace/canary.sh"), "utf8").trim() !== "printf COMPANIONS_CANARY_OK") throw new Error("The canary file does not match the requested content.");
      console.log(JSON.stringify({ status: "passed", model: `${config.modelProvider}/${config.modelId}`, tools: withTools, seconds: (performance.now() - started) / 1000 }));
      break;
    }
    if (Date.now() > deadline) throw new Error("Live model response timed out.");
    await Bun.sleep(200);
  }
} finally {
  const cleanup = Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
  await cleanup.exited;
}
