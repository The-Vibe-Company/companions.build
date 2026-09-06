import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { providerSecretEnvironmentNames, takeAgentToken, takeProviderApiKey } from "../src/environment";

const original = { ...process.env };
afterEach(() => {
  for (const name of ["AGENT_TOKEN", ...providerSecretEnvironmentNames]) delete process.env[name];
  Object.assign(process.env, original);
});

test("captures control and Google alias credentials then removes secrets from Pi shell inheritance", async () => {
  process.env.AGENT_TOKEN = "control-secret";
  process.env.GOOGLE_API_KEY = "google-secret";
  process.env.OPENAI_API_KEY = "unselected-secret";
  expect(takeAgentToken()).toBe("control-secret");
  expect(takeProviderApiKey("google")).toBe("google-secret");

  const tool = createBashTool(mkdtempSync(join(tmpdir(), "companion-agent-env-")));
  const result = await tool.execute("environment-test", {
    command: "if env | grep -E '^(AGENT_TOKEN|GOOGLE_API_KEY|OPENAI_API_KEY)='; then exit 9; else printf CLEAN; fi",
  });
  expect(result.content).toEqual([{ type: "text", text: "CLEAN" }]);
});
