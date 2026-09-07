/** Optional paid acceptance: Pi installs a native skill through companion_control, then discovers it next turn. */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { config, decrypt } from "../apps/server/src/config";
import { agentRequest } from "../apps/server/src/machines";
import { db } from "../apps/server/src/store";

const prefix = "CONTROL_SKILLS_CANARY";
const uuid = z.string().uuid();
function fail(code: string): never { throw Error(`${prefix}_${code}`); }
function sha(value: Uint8Array | string) { return createHash("sha256").update(value).digest("hex"); }

const stateSchema = z.object({
  version: z.literal(1), companionId: uuid,
  skillName: z.string().regex(/^control-canary-[a-f0-9]{16}$/),
  marker: z.string().regex(/^CONTROL_SKILL_[A-F0-9]{32}$/),
  installMessageId: uuid, installOperationId: uuid, useMessageId: uuid,
  installRunId: uuid.optional(), useRunId: uuid.optional(),
  installedAt: z.string().optional(), passedAt: z.string().optional(),
});
const controlResultSchema = z.object({
  listedBefore: z.boolean(),
  first: z.object({ bundleHash: z.string().regex(/^[a-f0-9]{64}$/), imported: z.array(z.string()), unchanged: z.array(z.string()) }),
  second: z.object({ bundleHash: z.string().regex(/^[a-f0-9]{64}$/), imported: z.array(z.string()), unchanged: z.array(z.string()) }),
  listedAfter: z.boolean(),
}).strict();
const exportSchema = z.object({ version: z.literal(1), skills: z.array(z.object({
  name: z.string(), files: z.array(z.object({ path: z.string(), data: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
})) });

try {
  if (!config.boxKey || !config.boxTemplate || config.testMode) fail("LIVE_CONFIGURATION_REQUIRED");
  const companionId = uuid.parse(process.env.CONTROL_SKILLS_COMPANION_ID);
  const sessionFile = Bun.file(process.env.CONTROL_SKILLS_SESSION_FILE ?? ".local/session-cookie");
  if (!await sessionFile.exists()) fail("SESSION_REQUIRED");
  const cookie = (await sessionFile.text()).trim();
  if (!cookie) fail("SESSION_REQUIRED");
  const apiBase = `http://127.0.0.1:${process.env.API_PORT ?? Number(process.env.WEB_PORT ?? 4310) + 1}/api`;
  const journalPath = process.env.CONTROL_SKILLS_CANARY_STATE_FILE ?? ".local/control-skills-canary.json";
  const journalFile = Bun.file(journalPath);
  const state: z.infer<typeof stateSchema> = await journalFile.exists() ? stateSchema.parse(await journalFile.json()) : {
    version: 1, companionId,
    skillName: `control-canary-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    marker: `CONTROL_SKILL_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`,
    installMessageId: crypto.randomUUID(), installOperationId: crypto.randomUUID(), useMessageId: crypto.randomUUID(),
  };
  if (state.companionId !== companionId) fail("JOURNAL_COMPANION_MISMATCH");
  if (state.useRunId && !state.installedAt) fail("JOURNAL_PHASE_MISMATCH");
  function save() {
    mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
    const temporary = `${journalPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, journalPath); chmodSync(journalPath, 0o600);
  }
  save();

  async function api(path: string, body?: unknown) {
    const response = await fetch(`${apiBase}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) fail(`API_${response.status}`);
    return response.json() as Promise<any>;
  }
  const companionPath = `/companions/${companionId}`;
  async function authorizedDetail() {
    // A foreign id returns 404 here. Do this before every direct lookup of encrypted daemon credentials.
    const detail = await api(companionPath);
    if (detail.companion.provider !== "box" || detail.companion.retiredAt) fail("OWNED_ACTIVE_BOX_REQUIRED");
    if (detail.companion.desktopTaken || detail.companion.desktopPausedAt) fail("DESKTOP_TAKEN");
    return detail;
  }
  async function agent() {
    await authorizedDetail();
    const [row] = await db`SELECT endpoint_secret,agent_secret FROM companions WHERE id=${companionId} AND retired_at IS NULL`;
    if (!row?.endpoint_secret || !row.agent_secret) fail("AGENT_UNAVAILABLE");
    return { endpoint: decrypt(row.endpoint_secret), token: decrypt(row.agent_secret) };
  }
  async function completed(runId: string, phase: string) {
    const deadline = Date.now() + 360_000;
    for (;;) {
      const detail = await authorizedDetail();
      const run = detail.runs.find((item: any) => item.id === runId);
      if (["failed", "interrupted", "cancelled", "needs_input"].includes(run?.status)) fail(`${phase}_${String(run.status).toUpperCase()}`);
      if (run?.status === "succeeded") {
        const reply = detail.messages.find((item: any) => item.runId === runId && item.role === "assistant");
        if (typeof reply?.content !== "string") fail(`${phase}_MISSING_REPLY`);
        return reply.content.trim() as string;
      }
      if (Date.now() > deadline) fail(`${phase}_TIMEOUT`);
      await Bun.sleep(1_000);
    }
  }

  const detail = await authorizedDetail();
  // Recover an accepted POST whose response or following local journal write was lost.
  const accepted = await db`SELECT id,client_message_id FROM runs WHERE companion_id=${companionId}
    AND client_message_id IN (${state.installMessageId},${state.useMessageId})`;
  for (const run of accepted) {
    if (run.client_message_id === state.installMessageId) state.installRunId ??= uuid.parse(run.id);
    if (run.client_message_id === state.useMessageId) state.useRunId ??= uuid.parse(run.id);
  }
  save();
  if (detail.runs.some((run: any) => !["succeeded", "failed", "interrupted", "cancelled"].includes(run.status)
    && run.id !== state.installRunId && run.id !== state.useRunId)) fail("COMPANION_BUSY");

  const skillText = `---\nname: ${state.skillName}\ndescription: Read the private control canary marker when explicitly requested.\n---\n\nRead fixture/marker.txt in this skill directory with a file tool. Reply with exactly its contents and nothing else. Do not use external services.\n`;
  const markerText = `${state.marker}\n`;
  const files = [
    { path: "SKILL.md", data: Buffer.from(skillText).toString("base64"), sha256: sha(skillText) },
    { path: "fixture/marker.txt", data: Buffer.from(markerText).toString("base64"), sha256: sha(markerText) },
  ];
  const installInput = { clientOperationId: state.installOperationId, skill: { name: state.skillName, files } };
  const installPrompt = `Use only the companion_control tool for this operation. First call skills with empty input. Then call skill_install twice with this exact same input, including the same clientOperationId: ${JSON.stringify(installInput)}. Call skills again and confirm ${state.skillName} is listed. Do not use file, shell, plugins, Skills Hub, or HTTP tools. Reply only with compact JSON shaped exactly as {"listedBefore":boolean,"first":{"bundleHash":string,"imported":string[],"unchanged":string[]},"second":{"bundleHash":string,"imported":string[],"unchanged":string[]},"listedAfter":boolean}, copying the two tool results exactly.`;
  if (!state.installRunId) {
    const response = await api(`${companionPath}/messages`, { clientMessageId: state.installMessageId, content: installPrompt });
    state.installRunId = uuid.parse(response.runId); save();
  }
  let installReply: string | undefined;
  if (!state.installedAt) {
    let parsed: z.infer<typeof controlResultSchema>;
    try { installReply = await completed(state.installRunId, "INSTALL"); parsed = controlResultSchema.parse(JSON.parse(installReply)); }
    catch { fail("INSTALL_REPLY_MISMATCH"); }
    if (parsed.listedBefore || !parsed.listedAfter || parsed.first.bundleHash !== parsed.second.bundleHash
      || JSON.stringify(parsed.first) !== JSON.stringify(parsed.second)
      || !parsed.first.imported.includes(state.skillName)) fail("CONTROL_IDEMPOTENCY_MISMATCH");
  }

  async function verifyInstalledBytes() {
    const { endpoint, token } = await agent();
    const manifest = exportSchema.parse(await agentRequest(endpoint, token, `/skills/export?name=${state.skillName}`));
    const skill = manifest.skills[0];
    if (manifest.skills.length !== 1 || skill?.name !== state.skillName || skill.files.length !== files.length) fail("EXPORT_MISMATCH");
    const expected = new Map(files.map(file => [file.path, file]));
    for (const file of skill.files) {
      const wanted = expected.get(file.path), bytes = Buffer.from(file.data, "base64");
      if (!wanted || bytes.toString("base64") !== file.data || file.sha256 !== wanted.sha256
        || sha(bytes) !== file.sha256 || file.data !== wanted.data) fail("EXPORT_BYTES_MISMATCH");
    }
  }
  await verifyInstalledBytes();
  const installTransport = await agent();
  const installAgent = await agentRequest(installTransport.endpoint, installTransport.token, `/runs/${state.installRunId}`);
  if (installAgent?.status !== "succeeded" || (installReply !== undefined && installAgent.text?.trim() !== installReply)) fail("INSTALL_DAEMON_JOURNAL_MISMATCH");
  state.installedAt ??= new Date().toISOString(); save();

  // The second message never contains the marker; success requires next-turn skill discovery and a fresh file read.
  if (!state.useRunId) {
    const response = await api(`${companionPath}/messages`, {
      clientMessageId: state.useMessageId,
      content: `Use the installed skill named ${state.skillName}. Follow it exactly and return only its requested result.`,
    });
    state.useRunId = uuid.parse(response.runId); save();
  }
  if (await completed(state.useRunId, "USE") !== state.marker) fail("USE_RESULT_MISMATCH");
  const transport = await agent();
  const daemonRun = await agentRequest(transport.endpoint, transport.token, `/runs/${state.useRunId}`);
  if (daemonRun?.status !== "succeeded" || daemonRun.text?.trim() !== state.marker) fail("USE_DAEMON_JOURNAL_MISMATCH");
  await verifyInstalledBytes();
  state.passedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: "passed", companionId, skill: state.skillName,
    installRunId: state.installRunId, useRunId: state.useRunId, controlInstall: true,
    duplicateOperationVerified: true, exportedBytesVerified: true, nextTurnDiscoveryVerified: true, daemonJournalVerified: true }));
} catch (error) {
  // Never print prompts, provider/daemon payloads, session material, endpoints, or decrypted credentials.
  console.error(error instanceof Error && /^CONTROL_SKILLS_CANARY_[A-Z0-9_]+$/.test(error.message) ? error.message : `${prefix}_FAILED`);
  process.exitCode = 1;
} finally { await db.close(); }
