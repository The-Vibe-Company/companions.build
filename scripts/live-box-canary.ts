/** Optional live canary: owns one named Companion, persists its IDs, never deletes its disk. */
import { config } from "../apps/server/src/config";
import { BoxClient } from "../packages/box/client";
if (!config.boxKey || !config.boxTemplate || config.testMode) throw new Error("Configure Box template/key and a real model before running this canary.");
const box = new BoxClient(config.boxKey);
const apiBase = `http://127.0.0.1:${process.env.API_PORT ?? Number(process.env.WEB_PORT ?? 4310) + 1}`;
async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${apiBase}/api${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`CANARY_API_${response.status}`);
  return response.json();
}
const journal = Bun.file(".local/box-canary.json");
const state = await journal.exists() ? await journal.json() : { firstMessageId: crypto.randomUUID(), wakeMessageId: crypto.randomUUID() };
const save = () => Bun.write(journal, JSON.stringify(state, null, 2));
// Re-run an intentional wake without reusing a completed message's identity.
if (process.argv.includes("--wake-only") && state.wake) {
  (state.previousWakes ??= []).push(state.wake);
  delete state.wake;
  state.wakeMessageId = crypto.randomUUID();
}
await save();
if (!state.companionId) {
  const { companion } = await api("/companions", { name: "Box coding companion", provider: "box", instructions: "You are a careful coding teammate. Use tools to verify your work." });
  state.companionId = companion.id; await save();
}
const path = `/companions/${state.companionId}`;
async function waitFor(label: string, condition: () => Promise<boolean>, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) { if (Date.now() > deadline) throw new Error(`${label}_TIMEOUT`); await Bun.sleep(500); }
}
async function task(clientMessageId: string, content: string, key: string) {
  const started = performance.now();
  const { runId } = await api(`${path}/messages`, { clientMessageId, content });
  const admissionMs = performance.now() - started;
  let preparationSeconds: number | null = null;
  let executionSeconds: number | null = null;
  await waitFor(key, async () => {
    const detail = await api(path); const run = detail.runs.find((r: any) => r.id === runId);
    if (["failed", "interrupted", "cancelled"].includes(run?.status)) throw new Error(`${key}_${run.status}`);
    if (run?.status !== "succeeded") return false;
    if (run.preparedAt) {
      preparationSeconds = (Date.parse(run.preparedAt) - Date.parse(run.createdAt)) / 1000;
      executionSeconds = (Date.parse(run.finishedAt) - Date.parse(run.preparedAt)) / 1000;
    }
    const reply = detail.messages.find((m: any) => m.runId === runId && m.role === "assistant");
    if (reply?.content.trim() !== "BOX_CANARY_OK") throw new Error(`${key}_UNEXPECTED_REPLY`);
    state.boxId = detail.companion.boxId;
    return true;
  });
  state[key] = { admissionMs, totalSeconds: (performance.now() - started) / 1000, preparationSeconds, executionSeconds }; await save();
  console.log(JSON.stringify({ phase: key, ...state[key] }));
}
if (!state.first) await task(state.firstMessageId,
  "Create box-canary.sh containing exactly: printf BOX_CANARY_OK. Run it with bash, verify the output, then reply exactly BOX_CANARY_OK and nothing else.", "first");
const contents = await box.request(`/boxes/${encodeURIComponent(state.boxId)}/files?path=${encodeURIComponent('/home/user/.companions/workspace/box-canary.sh')}&encoding=utf8`);
if (contents.content?.trim() !== "printf BOX_CANARY_OK") throw new Error("CANARY_FILE_MISMATCH");
if (!state.wake) {
  const started = performance.now();
  await box.stop(state.boxId);
  await waitFor("archive", async () => (await box.get(state.boxId)).state === "archived");
  state.archiveSeconds = (performance.now() - started) / 1000; await save();
  const originalId = state.boxId;
  await task(state.wakeMessageId,
    "Read the existing box-canary.sh, execute it with bash and verify its output. Do not rewrite it. Reply exactly BOX_CANARY_OK and nothing else.", "wake");
  if (state.boxId !== originalId) throw new Error("BOX_ID_CHANGED");
}
await waitFor("desktop", async () => {
  try { const { url } = await api(`${path}/desktop`, {}); return new URL(url).protocol === "https:"; } catch { return false; }
}, 60_000);
state.desktopVerified = true; await save();
console.log(JSON.stringify({ status: "passed", companionId: state.companionId, boxId: state.boxId, first: state.first, wake: state.wake, archiveSeconds: state.archiveSeconds, desktopVerified: true }));
