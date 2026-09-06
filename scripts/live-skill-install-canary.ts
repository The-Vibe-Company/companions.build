/** Optional, paid acceptance: a real chat attachment installs a native Pi skill. No direct imports. */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { config, decrypt } from "../apps/server/src/config";
import { agentRequest } from "../apps/server/src/machines";
import { db } from "../apps/server/src/store";

const prefix = "SKILL_INSTALL_CANARY";
function fail(code: string): never { throw Error(`${prefix}_${code}`); }
function sha(bytes: Uint8Array | string) { return createHash("sha256").update(bytes).digest("hex"); }
const uuid = z.string().uuid();
const stateSchema = z.object({
  version: z.literal(1), companionId: uuid,
  skillName: z.string().regex(/^chat-install-[a-f0-9]{16}$/),
  marker: z.string().regex(/^CHAT_SKILL_[a-f0-9]{32}$/),
  installMessageId: uuid, useMessageId: uuid, uploadFileId: uuid,
  installRunId: uuid.optional(), useRunId: uuid.optional(),
  challenge: uuid.optional(), installedAt: z.string().optional(), passedAt: z.string().optional(),
});
const exportSchema = z.object({ version: z.literal(1), skills: z.array(z.object({
  name: z.string(), files: z.array(z.object({ path: z.string(), data: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
})) });

try {
  if (!config.boxKey || !config.boxTemplate || config.testMode) fail("LIVE_CONFIGURATION_REQUIRED");
  let companionId = process.env.SKILL_INSTALL_COMPANION_ID;
  if (!companionId) {
    const source = await Bun.file(process.env.BOX_CANARY_STATE_FILE ?? ".local/box-canary-v2.json").json();
    companionId = source.companionId ?? source.parentId;
  }
  companionId = uuid.parse(companionId);
  const cookie = (await Bun.file(process.env.SKILL_INSTALL_SESSION_FILE ?? ".local/session-cookie").text()).trim();
  if (!cookie) fail("SESSION_REQUIRED");
  const apiBase = `http://127.0.0.1:${process.env.API_PORT ?? Number(process.env.WEB_PORT ?? 4310) + 1}/api`;
  const journalPath = process.env.SKILL_INSTALL_CANARY_STATE_FILE ?? ".local/live-skill-install-canary.json";
  const journalFile = Bun.file(journalPath);
  const state: z.infer<typeof stateSchema> = await journalFile.exists() ? stateSchema.parse(await journalFile.json()) : {
    version: 1, companionId, skillName: `chat-install-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    marker: `CHAT_SKILL_${crypto.randomUUID().replaceAll("-", "")}`,
    installMessageId: crypto.randomUUID(), useMessageId: crypto.randomUUID(), uploadFileId: crypto.randomUUID(),
  };
  if (state.companionId !== companionId) fail("JOURNAL_COMPANION_MISMATCH");
  if (state.useRunId && (!state.challenge || !state.installedAt)) fail("JOURNAL_PHASE_MISMATCH");
  function save() {
    mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
    const temporary = `${journalPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, journalPath); chmodSync(journalPath, 0o600);
  }
  save();
  async function api(path: string, body?: unknown) {
    const multipart = body instanceof FormData;
    const response = await fetch(`${apiBase}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: multipart ? { cookie } : { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) fail(`API_${response.status}`);
    return response.json() as Promise<any>;
  }
  const companionPath = `/companions/${companionId}`;
  async function authorizedDetail() {
    const detail = await api(companionPath);
    if (detail.companion.provider !== "box" || detail.companion.retiredAt) fail("LIVE_COMPANION_REQUIRED");
    if (detail.companion.desktopTaken || detail.companion.desktopPausedAt) fail("DESKTOP_TAKEN");
    return detail;
  }
  async function agent() {
    // Establish authenticated ownership before reading the transport reference. Never log it.
    await authorizedDetail();
    const [row] = await db`SELECT endpoint_secret,agent_secret FROM companions WHERE id=${companionId} AND retired_at IS NULL`;
    if (!row?.endpoint_secret || !row.agent_secret) fail("AGENT_UNAVAILABLE");
    return { endpoint: decrypt(row.endpoint_secret), token: decrypt(row.agent_secret) };
  }
  async function completed(runId: string, phase: string) {
    const deadline = Date.now() + 300_000;
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
  // A POST may have committed before its response or journal save was lost. Recover its
  // existing run before checking for unrelated work; never manufacture replacement IDs.
  const acceptedRuns = await db`SELECT id,client_message_id FROM runs WHERE companion_id=${companionId}
    AND client_message_id IN (${state.installMessageId},${state.useMessageId})`;
  for (const run of acceptedRuns) {
    if (run.client_message_id === state.installMessageId) state.installRunId ??= uuid.parse(run.id);
    if (run.client_message_id === state.useMessageId) state.useRunId ??= uuid.parse(run.id);
  }
  if (state.useRunId && (!state.challenge || !state.installedAt)) fail("JOURNAL_PHASE_MISMATCH");
  save();
  if (detail.runs.some((run: any) => !["succeeded", "failed", "interrupted", "cancelled"].includes(run.status)
    && run.id !== state.installRunId && run.id !== state.useRunId)) fail("COMPANION_BUSY");

  // The marker is independently generated by the canary, never supplied in the use prompt.
  const description = `Compute a chat-install proof for a fresh challenge when ${state.skillName} is requested. Fixture ${state.marker}.`;
  const skillText = `---\nname: ${state.skillName}\ndescription: ${description}\n---\n\n# Chat installation proof\n\nWhen explicitly asked to use this skill with a challenge, read this installed SKILL.md with a file tool.\nUse bash to compute the SHA-256 hexadecimal digest of the UTF-8 string formed by concatenating\nfixture marker ${state.marker}, a colon, and the exact challenge (no newline or spaces).\nReturn only the lowercase 64-character digest. Do not modify this skill or use external services.\n`;
  const installPrompt = `Install the attached SKILL.md as your native Pi skill named ${state.skillName}. Use your ordinary read/write/bash tools to inspect the attachment and preserve its exact bytes. The destination is pi/skills/${state.skillName}/SKILL.md inside your agent state directory (AGENT_STATE_DIR, or the parent of your workspace working directory). Create only this new skill directory. If it already exists, compare the bytes and leave an identical file unchanged; stop if they differ. Do not use a skill import endpoint, Skills Hub, or plugins. Verify the installed file before replying with exactly SKILL_INSTALL_READY. Do not execute the skill yet.`;
  if (!state.installRunId) {
    const accepted = await api(`${companionPath}/messages`, { clientMessageId: state.installMessageId, content: installPrompt, attachmentCount: 1 });
    state.installRunId = uuid.parse(accepted.runId); save();
  }
  if (!state.installedAt) {
    const form = new FormData();
    form.set("clientFileId", state.uploadFileId); form.set("position", "0");
    form.set("file", new File([skillText], "SKILL.md", { type: "text/markdown" }));
    const uploaded = await api(`${companionPath}/runs/${state.installRunId}/files`, form);
    if (uploaded.file?.sha256 !== sha(skillText) || uploaded.file?.byteSize !== Buffer.byteLength(skillText)) fail("UPLOAD_BYTES_MISMATCH");
    if (await completed(state.installRunId, "INSTALL") !== "SKILL_INSTALL_READY") fail("INSTALL_REPLY_MISMATCH");
  }
  async function verifyExportAndDiscovery() {
    const { endpoint, token } = await agent();
    const manifest = exportSchema.parse(await agentRequest(endpoint, token, `/skills/export?name=${state.skillName}`));
    for (const skill of manifest.skills) for (const file of skill.files) {
      const bytes = Buffer.from(file.data, "base64");
      if (bytes.toString("base64") !== file.data || sha(bytes) !== file.sha256) fail("EXPORT_HASH_MISMATCH");
    }
    const selected = manifest.skills.find(skill => skill.name === state.skillName);
    if (manifest.skills.length !== 1 || selected?.files.length !== 1 || selected.files[0].path !== "SKILL.md"
      || selected.files[0].sha256 !== sha(skillText) || Buffer.from(selected.files[0].data, "base64").toString("utf8") !== skillText) fail("INSTALLED_BYTES_MISMATCH");
    const listing = z.object({ skills: z.array(z.object({ name: z.string(), description: z.string() })) })
      .parse(await agentRequest(endpoint, token, "/skills"));
    if (!listing.skills.some(skill => skill.name === state.skillName && skill.description === description)) fail("DISCOVERY_MISMATCH");
  }
  await verifyExportAndDiscovery();
  state.installedAt ??= new Date().toISOString();
  // Persist a fresh, post-install challenge before accepting the second durable message.
  state.challenge ??= crypto.randomUUID(); save();
  if (!state.useRunId) {
    const accepted = await api(`${companionPath}/messages`, {
      clientMessageId: state.useMessageId,
      content: `Use your installed ${state.skillName} skill for challenge ${state.challenge}. Follow that skill and return only its requested result.`,
    });
    state.useRunId = uuid.parse(accepted.runId); save();
  }
  const expected = sha(`${state.marker}:${state.challenge}`);
  if (await completed(state.useRunId, "USE") !== expected) fail("USE_RESULT_MISMATCH");
  const { endpoint, token } = await agent();
  const daemonRun = await agentRequest(endpoint, token, `/runs/${state.useRunId}`);
  if (daemonRun?.status !== "succeeded" || daemonRun.text?.trim() !== expected) fail("JOURNAL_RESULT_MISMATCH");
  await verifyExportAndDiscovery();
  state.passedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: "passed", companionId, skill: state.skillName,
    installRunId: state.installRunId, useRunId: state.useRunId, chatUploaded: true,
    exportedBytesVerified: true, listed: true, nextTurnChallengeVerified: true, journalVerified: true }));
} catch (error) {
  // Never dump API/daemon payloads, validation inputs, transport errors, or credentials.
  console.error(error instanceof Error && /^SKILL_INSTALL_CANARY_[A-Z0-9_]+$/.test(error.message) ? error.message : `${prefix}_FAILED`);
  process.exitCode = 1;
} finally { await db.close(); }
