import { resolve } from "node:path";
import { AgentDaemon } from "./daemon";
import { PiExecutor } from "./pi-executor";

export async function startAgent() {
  const token = process.env.AGENT_TOKEN?.trim();
  if (!token) throw new Error("MISSING_AGENT_TOKEN");
  const port = parsePort(process.env.PORT);
  const stateDir = resolve(process.env.AGENT_STATE_DIR ?? "/home/user/.companions");
  const executor = await PiExecutor.create(stateDir);
  const daemon = new AgentDaemon(stateDir, token, executor);
  const server = Bun.serve({ hostname: "0.0.0.0", port, fetch: request => daemon.fetch(request) });
  const shutdown = () => { server.stop(true); daemon.close(); process.exit(0); };
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
