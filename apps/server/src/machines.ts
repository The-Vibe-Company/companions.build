import {restoreSpecialistWorkspace} from './specialist-box';
import {tracePreparation,preparationState,preparationMeasurement,type PreparationPhase} from './preparation-trace';
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
export class ExecutionStopped extends Error {}
export type EffectGuard=()=>Promise<void>;
export type DesktopMachineState={generation:number;taken:boolean;confirmed:boolean;bootId:string};
const unguarded:EffectGuard=async()=>{};
const serviceMarker=/^__COMPANIONS_SERVICE_PHASE__ (desktop|agent|proxy) (\d{1,20}) (\d{1,20}) 0$/;
function recordServiceMeasurements(companionId:string,output:string,completedMs:number){
 const measurements:Array<{phase:PreparationPhase;started:bigint;ended:bigint}>=[];
 for(const line of output.split('\n')){
  const match=line.match(serviceMarker);if(!match)continue;
  const started=BigInt(match[2]),ended=BigInt(match[3]);if(ended<started)continue;
  measurements.push({phase:`box_service_${match[1]}` as PreparationPhase,started,ended});
 }
 const remoteEnd=measurements.reduce((latest,item)=>item.ended>latest?item.ended:latest,0n);if(!remoteEnd)return;
 for(const item of measurements){
  const duration=Number(item.ended-item.started)/1_000_000;
  const startedMs=completedMs-Number(remoteEnd-item.started)/1_000_000;
  preparationMeasurement(companionId,item.phase,startedMs,duration);
 }
}
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
  if(!config.testMode&&config.modelGatewayUrl){
    values.MODEL_GATEWAY_URL=config.modelGatewayUrl;
    return values;
  }
  if(!config.testMode&&process.env.NODE_ENV==='production')throw new MachineError('model_gateway_required');
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
export async function prepareLocal(companion: any, refreshConfig = true, beforeEffect:EffectGuard=unguarded) {
  const runDocker=async(args:string[])=>{await beforeEffect();return docker(args);};
  await beforeEffect();
  const name = `companions-${workspace}-${companion.id}`;
  const state = join(dataDir, "agents", companion.id);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  let existing: any;
  try { existing = JSON.parse(await runDocker(["inspect", name]))[0]; } catch {}
  await beforeEffect();
  const env = modelEnvironment(decrypt(companion.agent_secret));
  const digest = environmentDigest(companion.agent_secret, "local");
  if (existing && existing.Config?.Labels?.["companions.build.workspace"] !== workspace) throw new MachineError("local_machine_ownership_mismatch");
  if (existing && refreshConfig && existing.Config?.Labels?.["companions.build.config"] !== digest) {
    await runDocker(["rm", "-f", name]);
    existing = null;
  }
  if (!existing) {
    const envDir = join(dataDir, "private");
    mkdirSync(envDir, { recursive: true, mode: 0o700 });
    const envPath = join(envDir, `${companion.id}.env`);
    if (Object.values(env).some(value => /[\r\n]/.test(value))) throw new MachineError("invalid_environment");
    writeFileSync(envPath, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
    try { await runDocker(["run", "--detach", "--init", "--platform", "linux/amd64", "--name", name,
      "--label", `companions.build.workspace=${workspace}`, "--label", `companions.build.config=${digest}`,
      "--label", `companions.build.verification=${process.env.COMPANIONS_VERIFY_RUN ?? "development"}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--tmpfs", "/tmp", "--env-file", envPath, "--publish", "127.0.0.1::8787",
      "--mount", `type=bind,src=${realpathSync(resolve("dist/agent"))},dst=/opt/agent,readonly`,
      "--mount", `type=bind,src=${state},dst=/state`,
      "debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171", "/opt/agent/companion-agent"]); }
    finally { unlinkSync(envPath); }
  } else {
    if (existing.Config?.Labels?.["companions.build.workspace"] !== workspace) throw new MachineError("local_machine_ownership_mismatch");
    if (!existing.State.Running) await runDocker(["start", name]);
  }
  const port = await runDocker(["port", name, "8787/tcp"]);
  if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new MachineError("local_endpoint_invalid");
  return `http://${port}`;
}
export async function prepareBox(companion: any, checkpoint: (boxId: string) => Promise<void>, configured: () => Promise<void>, beforeEffect:EffectGuard=unguarded, client:BoxClient|null=box): Promise<string | null> {
  const box=client;
  await beforeEffect();
  if (!box || !config.boxTemplate) throw new MachineError("box_not_configured");
  let id = companion.box_id;
  if (!id) {
    if (companion.create_started_at && Date.now() - new Date(companion.create_started_at).getTime() > 23 * 3600_000) throw new MachineError("box_creation_needs_reconciliation");
    await beforeEffect();
    const created = await tracePreparation(companion.id,'box_create',()=>box.create(companion.create_key, companion.snapshot_name ?? config.boxTemplate));
    id = created.id;
    await checkpoint(id);
  }
  await beforeEffect();
  const machine = await tracePreparation(companion.id,'box_get',()=>box.get(id),value=>value.state==='archived'?'archived':['ready','idle','running'].includes(value.state)?'ready':'not_ready');
  if (machine.state === "archived") { await beforeEffect(); await tracePreparation(companion.id,'box_resume',()=>box.resume(id)); return null; }
  if (!["ready", "idle", "running"].includes(machine.state)) return null;
  preparationState(companion.id,'box_setup',machine.setupStatus==='failed'?'setup_failed':machine.setupStatus&&machine.setupStatus!=='done'?'setup_pending':'ready');
  if (machine.setupStatus === "failed") throw new MachineError("box_setup_failed");
  if (machine.setupStatus && machine.setupStatus !== "done") return null;
  if (companion.endpoint_secret && companion.config_digest === environmentDigest(companion.agent_secret)) {preparationState(companion.id,'box_endpoint','reused');return decrypt(companion.endpoint_secret);}
  const values = { ...modelEnvironment(decrypt(companion.agent_secret)), AGENT_STATE_DIR: companion.template_id ? `/home/user/.companions/agents/${companion.id}` : "/home/user/.companions" };
  if(companion.template_id||companion.specialist_draft_id){
    await beforeEffect();
    await box.command(id,restoreSpecialistWorkspace(values.AGENT_STATE_DIR));
  }
  // systemd EnvironmentFile uses double quoted values, not shell expansion.
  const envText = Object.entries(values).map(([key, value]) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`).join("\n");
  await beforeEffect();
  await tracePreparation(companion.id,'box_environment',()=>box.writeFile(id, "/home/user/.companions.env", envText));
  const action = companion.config_digest === environmentDigest(companion.agent_secret) ? "start" : "restart";
  await beforeEffect();
  if(!/^[a-f0-9-]{36}$/.test(companion.id))throw new MachineError('invalid_companion_identity');
  const serviceOutput=await tracePreparation(companion.id,'box_services',()=>box.command(id, `trace_service(){ phase="$1"; shift; started="$(date +%s%N)"; "$@"; code="$?"; ended="$(date +%s%N)"; printf '__COMPANIONS_SERVICE_PHASE__ %s %s %s %s\\n' "$phase" "$started" "$ended" "$code"; return "$code"; }
chmod 600 /home/user/.companions.env && if test -f /opt/companions/desktop-boundary.version; then trace_service desktop sudo -n python3 /opt/companions/configure-desktop.py ${companion.id} && trace_service agent sudo -n systemctl ${action} companions-agent.service && trace_service proxy sudo -n systemctl start companions-agent-proxy.socket; else started="$(date +%s%N)" && ${userSystemctl(`${action} companions-agent.service`)} && ended="$(date +%s%N)" && printf '__COMPANIONS_SERVICE_PHASE__ agent %s %s 0\\n' "$started" "$ended"; fi`));
  recordServiceMeasurements(companion.id,serviceOutput,performance.now());
  await configured();
  await beforeEffect();
  return tracePreparation(companion.id,'box_host',()=>box.host(id, 8787));
}
export async function agentRequest(endpoint: string, token: string, path: string, method = "GET", body?: unknown) {
  const result = await fetchAgent(endpoint, token, path, method, body, path === "/health" ? 2_000 : 10_000);
  if (result.status === 404) return null;
  if (result.status === 401 || result.status === 403) throw new MachineError("agent_auth_expired");
  if (!result.ok) throw new MachineError("agent_unavailable");
  return result.json() as Promise<any>;
}

/** Only the executor calls these after persisting desired lifecycle state. */
export async function pauseMachine(companion: any, paused: boolean, beforeEffect:EffectGuard=unguarded,client:BoxClient|null=box):Promise<DesktopMachineState> {
  const box=client;
  await beforeEffect();
  if(companion.desktop_boundary_version!==1)throw new MachineError('desktop_isolation_upgrade_required');
  if(companion.provider!=='box'||!box||!companion.box_id)throw new MachineError('desktop_unavailable');
  function parse(raw:string):DesktopMachineState{
    const value=JSON.parse(raw);
    if(!Number.isSafeInteger(value.generation)||value.generation<0||typeof value.taken!=='boolean'||typeof value.confirmed!=='boolean'||typeof value.bootId!=='string')throw new MachineError('desktop_state_invalid');
    return value;
  }
  const generation=Number(companion.desktop_generation??0);
  if(!Number.isSafeInteger(generation)||generation<0)throw new MachineError('desktop_generation_invalid');
  const current=parse(await box.command(companion.box_id,'sudo -n /usr/local/bin/companions-desktop-state'));
  await beforeEffect(); // A leader can be lost while the read-only observation is in flight.
  if(current.generation===generation&&current.taken===paused&&current.confirmed)return current;
  const applied=parse(await box.command(companion.box_id,`sudo -n /usr/local/bin/companions-desktop-state ${generation} ${paused?'true':'false'}`));
  if(applied.generation!==generation||applied.taken!==paused||!applied.confirmed)throw new MachineError('desktop_not_confirmed');
  return applied;
}
export async function archiveMachine(companion: any, beforeEffect:EffectGuard=unguarded, runLocal:(args:string[])=>Promise<string>=docker) {
  const runDocker=async(args:string[])=>{await beforeEffect();return runLocal(args);};
  await beforeEffect();
  if (companion.provider === "box") {
    if (!companion.box_id && !companion.create_started_at) return true;
    if (!box || !companion.box_id) throw new MachineError("box_not_configured");
    const machine = await box.get(companion.box_id);
    if (machine.state === "archived") return true;
    if (["ready", "idle", "running"].includes(machine.state)) { await beforeEffect(); await box.stop(companion.box_id); }
    return false;
  }
  const name = `companions-${workspace}-${companion.id}`;
  // A successful exact-name listing distinguishes absence from a broken Docker transport.
  const names=await runDocker(["ps","-a","--filter",`name=^/${name}$`,"--format","{{.Names}}"]);
  if(!names.trim())return true;
  if(names.trim()!==name)throw new MachineError("local_machine_ownership_mismatch");
  const current=JSON.parse(await runDocker(["inspect", name]))[0];
  if (current.Config?.Labels?.["companions.build.workspace"] !== workspace) throw new MachineError("local_machine_ownership_mismatch");
  if (current.State.Paused) await runDocker(["unpause", name]);
  if (current.State.Running) await runDocker(["stop", "--time", "10", name]);
  return true;
}
