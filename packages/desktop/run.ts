import { join } from "node:path";
import { serveDesktopBroker } from "./broker";
import { CommandDesktopDriver } from "./driver";

export function runDesktopBroker(env: NodeJS.ProcessEnv = process.env) {
  const stateDir = env.DESKTOP_STATE_DIR ?? "/var/lib/companions-desktop";
  return serveDesktopBroker({
    journalPath: join(stateDir, "journal.sqlite"),
    agentSocket: env.DESKTOP_AGENT_SOCKET ?? "/run/companions-desktop/agent.sock",
    adminSocket: env.DESKTOP_ADMIN_SOCKET ?? "/run/companions-desktop-admin/control.sock",
    driver: new CommandDesktopDriver({ display: env.DISPLAY ?? ":0", home: env.DESKTOP_HOME ?? "/home/user" }),
  });
}

if (import.meta.main) {
  const service = runDesktopBroker();
  const stop = async () => { await service.stop(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log("Desktop broker ready");
}
