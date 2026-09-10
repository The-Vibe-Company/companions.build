import { resolve } from "node:path";
import { AgentDaemon } from "./daemon";
import { takeAgentToken } from "./environment";
import { PiExecutor } from "./pi-executor";

import { AgentControl } from "../../control/agent";
import {runGitCredentialHelper} from "../../control/git-credentials";
import { AgentFiles } from "../../control/files";
import { AgentSkills } from "../../control/skills";
import { desktopTools } from "../../desktop/tools";
import {runDesktopBroker} from '../../desktop/run';
import { runMemoryWorker } from "./memory-worker";

async function startupPhase<T>(phase:string,body:()=>T|Promise<T>):Promise<T>{
  try{return await body();}catch(error){
    if(error instanceof Error&&/^[A-Z0-9_]{1,80}$/.test(error.message))throw error;
    const raw=error&&typeof error==='object'&&'code' in error?String(error.code):'';
    const code=/^[A-Z_0-9]{1,40}$/.test(raw)?raw:'FAILED';
    throw new Error(`STARTUP_${phase}_${code}`);
  }
}
export async function startAgent() {
  const token = takeAgentToken();
  const port = parsePort(process.env.PORT);
  const stateDir = resolve(process.env.AGENT_STATE_DIR ?? "/home/user/.companions");
  const executor = await startupPhase("PI",()=>PiExecutor.create(stateDir));
  const files = await startupPhase("FILES",()=>new AgentFiles(stateDir));
  const skills = await startupPhase("SKILLS",()=>new AgentSkills(stateDir));
  const control = await startupPhase("CONTROL",()=>new AgentControl(stateDir,skills));
  Object.assign(process.env,control.gitCredentials.environment());
  const desktopSocket = process.env.DESKTOP_BOUNDARY_VERSION === "1" ? process.env.DESKTOP_AGENT_SOCKET : undefined;
  executor.toolsFactory = async context => {
    const product = await control.toolsFactory(context);
    return {tools:[...product.tools,...files.tools(context.runId),...(desktopSocket?desktopTools({socketPath:desktopSocket,runId:context.runId}):[])],close:product.close};
  };
  const daemon = new AgentDaemon(stateDir, token, executor, async request => {
    if(desktopSocket && request.method==='GET' && new URL(request.url).pathname==='/desktop') {
      try {return await fetch('http://desktop/state',{unix:desktopSocket,signal:AbortSignal.timeout(2000)} as RequestInit & {unix:string});}
      catch{return Response.json({error:'desktop_unavailable'},{status:503});}
    }
    return await control.handleRequest(request) ?? await files.handleRequest(request) ?? await skills.handleRequest(request);
  },desktopSocket?1:0);
  const server = await startupPhase("SERVER",()=>Bun.serve({ hostname: "0.0.0.0", port, maxRequestBodySize: 15 * 1024 * 1024, fetch: request => daemon.fetch(request) }));
  const shutdown = () => { server.stop(true); executor.close(); daemon.close(); control.close(); files.close(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return { server, daemon };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_PORT");
  return port;
}

if (import.meta.main) {
  const credentialHelper=process.argv.indexOf('--git-credential-helper');
  if(process.argv.includes('--memory-worker')) {
    const stateDir = process.argv[process.argv.indexOf('--memory-worker') + 1];
    if (!stateDir || !stateDir.startsWith('/')) process.exit(1);
    runMemoryWorker(stateDir).then(() => process.exit(0), () => process.exit(1));
  }else if(credentialHelper>=0){
    const socketPath=process.argv[credentialHelper+1]??'',operation=process.argv[credentialHelper+2]??'';
    runGitCredentialHelper(socketPath,operation).then(code=>{if(code===2)console.error('GITHUB_CREDENTIAL_AMBIGUOUS');process.exit(code===2?1:code);},()=>process.exit(1));
  }else if(process.argv.includes('--desktop-broker')){
    const service=runDesktopBroker();const shutdown=async()=>{await service.stop();process.exit(0);};
    process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
  }else startAgent().catch(error => {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "STARTUP_FAILED";
    console.error(code);
    process.exit(1);
  });
}
