import {tracePreparation,preparationState,preparationMeasurement,type PreparationPhase} from './preparation-trace';
import { mkdirSync, writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { config, dataDir, decrypt } from "./config";
import { BoxClient, BoxError } from "../../../packages/box/client";
import { userSystemctl } from "../../../packages/box/layout";
import { fetchAgent } from "../../../packages/box/transport";
import {pinManagedBaseImage,managedBaseImageError,MANAGED_BASE_IMAGE_REGISTRY_LOCK_ID} from './managed-base-image';
import {db} from './store';
import {normalizeAzureOpenAIBaseUrl} from './azure-openai';

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
  const agentProvider=config.modelProvider==='azure'?(config.modelGatewayUrl?'openai':'azure-openai-responses'):config.modelProvider;
  const values: Record<string, string> = { AGENT_TOKEN: token, PORT: "8787", AGENT_STATE_DIR: "/state", MODEL_PROVIDER: agentProvider, MODEL_ID: config.modelId };
  if (config.testMode) values.AGENT_TEST_MODE = "1";
  if(!config.testMode&&config.modelGatewayUrl){
    values.MODEL_GATEWAY_URL=config.modelGatewayUrl;
    return values;
  }
  if(!config.testMode&&process.env.NODE_ENV==='production')throw new MachineError('model_gateway_required');
  const providerEnvironment: Record<string, string[]> = { google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"], anthropic: ["ANTHROPIC_API_KEY"], "azure-openai-responses": ["AZURE_OPENAI_API_KEY","AZURE_OPENAI_BASE_URL"], openai: ["OPENAI_API_KEY"], openrouter: ["OPENROUTER_API_KEY"], zai: ["ZAI_API_KEY"] };
  if (!config.testMode && !providerEnvironment[agentProvider]) throw new MachineError("unsupported_model_provider");
  for (const name of config.testMode ? [] : providerEnvironment[agentProvider] ?? []) {
    if (process.env[name]) values[name] = process.env[name]!;
  }
  if(agentProvider==='azure-openai-responses'&&values.AZURE_OPENAI_BASE_URL){
    try{values.AZURE_OPENAI_BASE_URL=normalizeAzureOpenAIBaseUrl(values.AZURE_OPENAI_BASE_URL);}
    catch{throw new MachineError('unsupported_model_provider');}
  }
  return values;
}
function localUser():string {
  if(!process.getuid || !process.getgid)throw new MachineError('local_posix_user_required');
  return `${process.getuid()}:${process.getgid()}`;
}
export const environmentDigest = (secret: string, provider = "box") => createHash("sha256")
  .update(JSON.stringify(modelEnvironment(decrypt(secret))))
  .update(provider === "local" ? realpathSync(resolve("dist/agent")) : config.managedBoxTemplate ? "managed-base-image" : config.boxTemplate ?? "")
  .update(provider === "local" ? JSON.stringify({user:localUser(),home:'/state'}) : '')
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
  // With all capabilities dropped, UID 0 cannot override a host-owned 0700 bind mount.
  const env = {...modelEnvironment(decrypt(companion.agent_secret)),HOME:'/state'};
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
    try { await runDocker(["run", "--detach", "--init", "--platform", "linux/amd64", "--name", name, "--user", localUser(),
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
/** The executor publisher owns image creation. Companions only pin a verified image. */
export async function machinePreparationReady(companion:any,beforeEffect:EffectGuard=unguarded):Promise<boolean> {
  if (companion.provider !== 'box' || companion.box_id || !config.managedBoxTemplate) return true;
  const name = await pinManagedBaseImage(companion.id,db,beforeEffect);
  if (!name) { companion.baseImageError = await managedBaseImageError(); return false; }
  companion.snapshot_name = name;
  return true;
}
export async function prepareBox(companion: any, checkpoint: (boxId: string) => Promise<void>, configured: () => Promise<void>, beforeEffect:EffectGuard=unguarded, client:BoxClient|null=box): Promise<string | null> {
  const box=client;
  await beforeEffect();
  if (!box || (!config.managedBoxTemplate && !config.boxTemplate && !companion.snapshot_name)) throw new MachineError("box_not_configured");
  if (!companion.snapshot_name && !await machinePreparationReady(companion,beforeEffect)) return null;
  let id = companion.box_id;
  if (!id) {
    if (companion.create_started_at && Date.now() - new Date(companion.create_started_at).getTime() > 23 * 3600_000) throw new MachineError("box_creation_needs_reconciliation");
    await beforeEffect();
    let created;
    try { created = await tracePreparation(companion.id,'box_create',()=>box.create(companion.create_key, companion.snapshot_name ?? config.boxTemplate)); }
    catch (error) {
      // A definitive missing-image rejection did not create a machine. Invalidate
      // only registered base images; unknown create outcomes retain their identity.
      if (config.managedBoxTemplate && companion.snapshot_name && error instanceof BoxError && error.status === 404) {
        await beforeEffect();
        let missing = false;
        try { await box.getSnapshot(companion.snapshot_name); }
        catch (observation) { if (observation instanceof BoxError && observation.status === 404) missing = true; }
        if (missing) {
          await beforeEffect();
          const invalidated = await db.begin(async tx => {
            await beforeEffect();
            await tx`SELECT pg_advisory_xact_lock(${MANAGED_BASE_IMAGE_REGISTRY_LOCK_ID})`;
            const [registered] = await tx`UPDATE managed_base_images SET status='missing',error_code='managed_image_snapshot_missing',updated_at=now()
              WHERE snapshot_name=${companion.snapshot_name} AND status IN ('ready','retired','missing') RETURNING id`;
            if (!registered) return false;
            await tx`UPDATE companions SET snapshot_name=null,create_started_at=null,preparation_started_at=null,error='Base image publication is pending.'
              WHERE id=${companion.id} AND box_id IS NULL AND snapshot_name=${companion.snapshot_name}`;
            await beforeEffect();
            return true;
          });
          if (invalidated) return null;
        }
      }
      throw error;
    }
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
  const values = { ...modelEnvironment(decrypt(companion.agent_secret)), AGENT_STATE_DIR: companion.agent_state_layout==='per_companion' ? `/home/user/.companions/agents/${companion.id}` : "/home/user/.companions" };
  if(companion.agent_state_layout==='per_companion'&&!companion.agent_state_seeded_at){
    await beforeEffect();
    await box.command(id,`set -eu; state=${values.AGENT_STATE_DIR}; marker="$state/.legacy-state-seeded"; mkdir -p "$state"; if ! test -e "$marker"; then if test -d /home/user/.specialist-workspace && ! test -e "$state/workspace"; then mkdir -p "$state/workspace"; cp -an /home/user/.specialist-workspace/. "$state/workspace"/; fi; if test -d /home/user/.specialist-skills && ! test -e "$state/pi/skills"; then mkdir -p "$state/pi/skills"; cp -an /home/user/.specialist-skills/. "$state/pi/skills"/; fi; marker_tmp="$marker.$$"; printf '%s\n' seeded > "$marker_tmp"; mv "$marker_tmp" "$marker"; fi`);
    await beforeEffect();
    await db`UPDATE companions SET agent_state_seeded_at=now() WHERE id=${companion.id} AND box_id=${id} AND agent_state_seeded_at IS NULL`;
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
  // A Box desktop is provisioned lazily by the provider. The initial broker is
  // deliberately fail-closed until that display exists, so provision it before
  // the first durable reconciliation. A desktop_preparing response leaves the
  // intent untouched and the lifecycle retries on its existing bounded cadence.
  if(!current.confirmed&&companion.desktop_observed_generation==null){
    await box.desktop(companion.box_id);
    await beforeEffect(); // Provisioning can outlive executor authority.
  }
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
