import { mkdirSync, writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { config, dataDir, decrypt } from "./config";
import { BoxClient } from "../../../packages/box/client";
import { userSystemctl } from "../../../packages/box/layout";
import { fetchAgent } from "../../../packages/box/transport";

const box = config.boxKey ? new BoxClient(config.boxKey) : null;
const workspace = createHash("sha256").update(dataDir).digest("hex").slice(0, 10);
export class MachineError extends Error {}
async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new MachineError("local_machine_unavailable");
    return output.trim();
  } finally { clearTimeout(timer); }
}
export function modelEnvironment(token: string): Record<string, string> {
  const values: Record<string, string> = { AGENT_TOKEN: token, PORT: "8787", AGENT_STATE_DIR: "/state", MODEL_PROVIDER: config.modelProvider, MODEL_ID: config.modelId };
  if (config.testMode) values.AGENT_TEST_MODE = "1";
  const providerKeys: Record<string, string[]> = { google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"], anthropic: ["ANTHROPIC_API_KEY"], openai: ["OPENAI_API_KEY"], openrouter: ["OPENROUTER_API_KEY"], zai: ["ZAI_API_KEY"] };
  if (!config.testMode && !providerKeys[config.modelProvider]) throw new MachineError("unsupported_model_provider");
  for (const name of config.testMode ? [] : providerKeys[config.modelProvider] ?? []) {
    if (process.env[name]) values[name] = process.env[name]!;
  }
  return values;
}
export const environmentDigest = (secret: string, provider = "box") => createHash("sha256")
  .update(JSON.stringify(modelEnvironment(decrypt(secret))))
  .update(provider === "local" ? realpathSync(resolve("dist/agent")) : config.boxTemplate ?? "")
  .digest("hex");
export async function prepareLocal(companion: any, refreshConfig = true) {
  const name = `companions-${workspace}-${companion.id}`;
  const state = join(dataDir, "agents", companion.id);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  let existing: any;
  try { existing = JSON.parse(await docker(["inspect", name]))[0]; } catch {}
  const env = modelEnvironment(decrypt(companion.agent_secret));
  const digest = environmentDigest(companion.agent_secret, "local");
  if (existing && existing.Config?.Labels?.["companions.build.workspace"] !== workspace) throw new MachineError("local_machine_ownership_mismatch");
  if (existing && refreshConfig && existing.Config?.Labels?.["companions.build.config"] !== digest) {
    await docker(["rm", "-f", name]);
    existing = null;
  }
  if (!existing) {
    const envDir = join(dataDir, "private");
    mkdirSync(envDir, { recursive: true, mode: 0o700 });
    const envPath = join(envDir, `${companion.id}.env`);
    if (Object.values(env).some(value => /[\r\n]/.test(value))) throw new MachineError("invalid_environment");
    writeFileSync(envPath, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
    try { await docker(["run", "--detach", "--init", "--platform", "linux/amd64", "--name", name,
      "--label", `companions.build.workspace=${workspace}`, "--label", `companions.build.config=${digest}`,
      "--label", `companions.build.verification=${process.env.COMPANIONS_VERIFY_RUN ?? "development"}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--tmpfs", "/tmp", "--env-file", envPath, "--publish", "127.0.0.1::8787",
      "--mount", `type=bind,src=${realpathSync(resolve("dist/agent"))},dst=/opt/agent,readonly`,
      "--mount", `type=bind,src=${state},dst=/state`,
      "debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171", "/opt/agent/companion-agent"]); }
    finally { unlinkSync(envPath); }
  } else {
    if (existing.Config?.Labels?.["companions.build.workspace"] !== workspace) throw new MachineError("local_machine_ownership_mismatch");
    if (!existing.State.Running) await docker(["start", name]);
  }
  const port = await docker(["port", name, "8787/tcp"]);
  if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new MachineError("local_endpoint_invalid");
  return `http://${port}`;
}
export async function prepareBox(companion: any, checkpoint: (boxId: string) => Promise<void>, configured: () => Promise<void>): Promise<string | null> {
  if (!box || !config.boxTemplate) throw new MachineError("box_not_configured");
  let id = companion.box_id;
  if (!id) {
    if (companion.create_started_at && Date.now() - new Date(companion.create_started_at).getTime() > 23 * 3600_000) throw new MachineError("box_creation_needs_reconciliation");
    const created = await box.create(companion.create_key, config.boxTemplate);
    id = created.id;
    await checkpoint(id);
  }
  const machine = await box.get(id);
  if (machine.state === "archived") { await box.resume(id); return null; }
  if (!["ready", "idle"].includes(machine.state)) return null;
  if (machine.setupStatus === "failed") throw new MachineError("box_setup_failed");
  if (machine.setupStatus && machine.setupStatus !== "done") return null;
  if (companion.endpoint_secret && companion.config_digest === environmentDigest(companion.agent_secret)) return decrypt(companion.endpoint_secret);
  const values = { ...modelEnvironment(decrypt(companion.agent_secret)), AGENT_STATE_DIR: "/home/user/.companions" };
  // systemd EnvironmentFile uses double quoted values, not shell expansion.
  const envText = Object.entries(values).map(([key, value]) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`).join("\n");
  await box.writeFile(id, "/home/user/.companions.env", envText);
  const action = companion.config_digest === environmentDigest(companion.agent_secret) ? "start" : "restart";
  await box.command(id, `chmod 600 /home/user/.companions.env && ${userSystemctl(`${action} companions-agent.service`)}`);
  await configured();
  return box.host(id, 8787);
}
export async function agentRequest(endpoint: string, token: string, path: string, method = "GET", body?: unknown) {
  const result = await fetchAgent(endpoint, token, path, method, body, path === "/health" ? 2_000 : 10_000);
  if (result.status === 404) return null;
  if (result.status === 401 || result.status === 403) throw new MachineError("agent_auth_expired");
  if (!result.ok) throw new MachineError("agent_unavailable");
  return result.json() as Promise<any>;
}
