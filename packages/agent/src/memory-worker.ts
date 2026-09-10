import { createInterface } from "node:readline";
import { MemoryStore } from "./memory-store";
import { MEMORY_TRANSPORT_MAX_BYTES } from "./memory-protocol";
import type { MemoryRequest, MemoryAuthority } from "./memory-protocol";

/** Private newline RPC on inherited pipes. EOF ends the child after a daemon crash. */
export async function runMemoryWorker(stateDir: string) {
  let store: MemoryStore | undefined;
  let maintenance: ReturnType<typeof setTimeout> | undefined;
  const scheduleMaintenance = () => {
    if (maintenance) return;
    maintenance = setTimeout(() => {
      maintenance = undefined;
      try {
        const response = store?.handle({ op: "maintain" });
        if (response && "more" in response && response.more) scheduleMaintenance();
      } catch { /* Derived maintenance cannot terminate the worker or emit memory content. */ }
    }, 25);
    maintenance.unref();
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let id: unknown;
      try {
        if (Buffer.byteLength(line) > MEMORY_TRANSPORT_MAX_BYTES) throw new Error("MEMORY_INVALID");
        const input = JSON.parse(line) as { id: string; request: MemoryRequest; authority?: MemoryAuthority };
        id = input.id;
        if (typeof id !== "string" || id.length > 100) throw new Error("MEMORY_INVALID");
        // Only the explicit scripted test boundary can simulate stalled initialization.
        if (!store && process.env.AGENT_TEST_MODE === "1") {
          const delay = Math.min(30_000, Number(process.env.MEMORY_TEST_DELAY_MS) || 0);
          if (delay > 0) await Bun.sleep(delay);
        }
        store ??= new MemoryStore(stateDir);
        const response = store.handle(input.request, input.authority ?? "agent");
        process.stdout.write(JSON.stringify({ id, response }) + "\n");
        if ("more" in response && response.more) scheduleMaintenance();
      } catch {
        process.stdout.write(JSON.stringify({ id, response: { status: "unavailable", error: "MEMORY_UNAVAILABLE" } }) + "\n");
      }
    }
  } finally {
    clearTimeout(maintenance);
    store?.close();
    lines.close();
  }
}
