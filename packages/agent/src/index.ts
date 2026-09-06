import { resolve } from "node:path";
import { AgentDaemon } from "./daemon";
import { takeAgentToken } from "./environment";
import { PiExecutor } from "./pi-executor";

import { AgentControl } from "../../control/agent";
import { AgentFiles } from "../../control/files";

export async function startAgent() {
  const token = takeAgentToken();
  const port = parsePort(process.env.PORT);
  const stateDir = resolve(process.env.AGENT_STATE_DIR ?? "/home/user/.companions");
  const executor = await PiExecutor.create(stateDir);
  const control = new AgentControl(stateDir);
  const files = new AgentFiles(stateDir);
  executor.toolsFactory = async context => {
    const product = await control.toolsFactory(context);
    return {tools:[...product.tools,...files.tools(context.runId)],close:product.close};
  };
  const daemon = new AgentDaemon(stateDir, token, executor, async request => await control.handleRequest(request) ?? await files.handleRequest(request));
  const server = Bun.serve({ hostname: "0.0.0.0", port, maxRequestBodySize: 15 * 1024 * 1024, fetch: request => daemon.fetch(request) });
  const shutdown = () => { server.stop(true); daemon.close(); control.close(); files.close(); process.exit(0); };
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
  startAgent().catch(error => {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "STARTUP_FAILED";
    console.error(code);
    process.exit(1);
  });
}
