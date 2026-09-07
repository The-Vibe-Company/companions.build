/** Optional live canary: owns one named Companion, persists its IDs, never deletes its disk. */
import { z } from "zod";
import { config } from "../apps/server/src/config";
import { BoxClient } from "../packages/box/client";
import {waitForDesktopUrl} from "./live-box-desktop-wait";
if (!config.boxKey || !config.boxTemplate || config.testMode) throw new Error("Configure Box template/key and a real model before running this canary.");
const sessionFile=Bun.file(".local/session-cookie");
if(!await sessionFile.exists())throw Error("Run python3 scripts/dev-session.py before the authenticated live canary.");
const cookie=(await sessionFile.text()).trim();
const box = new BoxClient(config.boxKey);
const apiBase = `http://127.0.0.1:${process.env.API_PORT ?? Number(process.env.WEB_PORT ?? 4310) + 1}`;
async function apiResponse(path: string, body?: unknown): Promise<Response> {
  return fetch(`${apiBase}/api${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
}
async function api(path: string, body?: unknown): Promise<any> {
  const response=await apiResponse(path,body);
  if (!response.ok) throw new Error(`CANARY_API_${response.status}`);
  return response.json();
}
const journal = Bun.file(process.env.CANARY_STATE_FILE??".local/box-canary.json");
const state = await journal.exists() ? await journal.json() : { firstMessageId: crypto.randomUUID(), wakeMessageId: crypto.randomUUID() };
state.creationId??=crypto.randomUUID();
const save = () => Bun.write(journal, JSON.stringify(state, null, 2));
// Re-run an intentional wake without reusing a completed message's identity.
if (process.argv.includes("--wake-only") && state.wake) {
  (state.previousWakes ??= []).push(state.wake);
  delete state.wake;
  state.wakeMessageId = crypto.randomUUID();
}
await save();
if (!state.companionId) {
  const { companion } = await api("/companions", { clientCreationId:state.creationId,name: "Box coding companion", provider: "box", instructions: "You are a careful coding teammate. Use tools to verify your work." });
  state.companionId = companion.id; await save();
}
state.companionId = z.string().uuid().parse(state.companionId);
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
const owned = await api(path);
if (owned.companion.provider !== "box" || owned.companion.retiredAt || owned.companion.boxId !== state.boxId) throw Error("CANARY_OWNED_BOX_REQUIRED");
// Independent provider read uses physical POSIX storage, while Pi retains its logical cwd.
const contents = await box.command(state.boxId, `sudo -n cat /var/lib/companions-agent/${state.companionId}/workspace/box-canary.sh`, 30);
if (contents.trim() !== "printf BOX_CANARY_OK") throw new Error("CANARY_FILE_MISMATCH");
if (!state.wake) {
  const started = performance.now();
  await box.stop(state.boxId);
  await waitFor("archive", async () => (await box.get(state.boxId)).state === "archived");
  state.archiveSeconds = (performance.now() - started) / 1000; await save();
  const originalId = state.boxId;
  const wakeId = z.string().uuid().parse(state.wakeMessageId);
  const probeName = `wake-write-${wakeId}.txt`;
  await task(state.wakeMessageId,
    `Read the existing box-canary.sh, execute it with bash and verify its output. Do not rewrite it. Create a NEW workspace file named ${probeName} containing exactly ${wakeId}, then read it back and verify it. Reply exactly BOX_CANARY_OK and nothing else.`, "wake");
  if (state.boxId !== originalId) throw new Error("BOX_ID_CHANGED");
}
// Re-running the script must still verify the independent file proof if a
// previous observation failed after the task's successful status was journaled.
const wakeId = z.string().uuid().parse(state.wakeMessageId);
const written = await box.command(state.boxId, `sudo -n cat /var/lib/companions-agent/${state.companionId}/workspace/wake-write-${wakeId}.txt`, 30);
if (written.trim() !== wakeId) throw Error("CANARY_WAKE_WRITE_MISMATCH");
state.wake.newFileVerified = true; await save();
await waitForDesktopUrl({request:()=>apiResponse(`${path}/desktop`,{}),state,save});
state.desktopVerified = true; await save();
console.log(JSON.stringify({ status: "passed", companionId: state.companionId, boxId: state.boxId, first: state.first, wake: state.wake, archiveSeconds: state.archiveSeconds, desktopVerified: true }));
