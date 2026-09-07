import { beforeAll, expect, test } from "bun:test";
import { db, migrate } from "../src/store";
import { createCompanion } from "../src/store";
import {
  activateSoftwareBase,
  enqueueTemplateSoftware,
  getSoftwareBuild,
  pinSoftwareHelperRequestDigest,
  recordResolvedSoftwareManifest,
  registerSoftwareBase,
  SoftwareConflict,
  SoftwareUnavailable,
  templateSoftwareStatus,
  type PortableSoftwareManifest,
} from "../src/software";
import { adoptTemplate, allowTemplate, listTemplateRevisions, recordTemplateRevision, rollbackTemplate, saveTemplate } from "../src/templates";
import { resolvedSoftwareSnapshot } from "../src/software-readiness";
import { spawnChild } from "../src/delegation";
import { applyControl } from "../src/control";
import "../src/control-product";
import { handler } from "../src/api";
import { setMagicLinkDeliveryForTests } from "../src/auth";

const baseId = `ubuntu-noble-${crypto.randomUUID().slice(0, 8)}`;
const distributionDigest = "a".repeat(64);
const resolverConfigDigest = "b".repeat(64);
const base = {
  id: baseId,
  providerSnapshotName: `software-base-${crypto.randomUUID().slice(0, 8)}`,
  distributionDigest,
  resolverConfigDigest,
  distro: { family: "ubuntu", suite: "noble", architecture: "amd64" },
};

beforeAll(async () => {
  await migrate();
  await registerSoftwareBase(base);
  await activateSoftwareBase(baseId);
});

async function owner(label = "Software owner") {
  const id = crypto.randomUUID();
  await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${id},${label},${`${id}@example.test`},true)`;
  return id;
}

async function template(ownerId: string, name = "Prepared teammate") {
  return saveTemplate(ownerId, { name, instructions: "Use the prepared tools", avatar: { shape: 1, color: 2, face: 3 } });
}

const roots = {
  apt: [{ name: "jq", version: "1.7.1-3ubuntu0.24.04.1" }],
  npm: [{ name: "tsx", version: "4.20.6" }],
};

function resolvedManifest(overrides: Partial<PortableSoftwareManifest> = {}): PortableSoftwareManifest {
  const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
  return {
    version: 1,
    base: { id: baseId, distributionDigest, distro: base.distro },
    apt: {
      roots: ["jq:amd64=1.7.1-3ubuntu0.24.04.1"],
      packages: [{
        id: "jq:amd64=1.7.1-3ubuntu0.24.04.1", name: "jq", version: "1.7.1-3ubuntu0.24.04.1",
        architecture: "amd64", sha256: "c".repeat(64), dependencies: [],
      }],
    },
    npm: {
      roots: ["tsx@4.20.6"],
      packages: [{ id: "tsx@4.20.6", name: "tsx", version: "4.20.6", integrity, dependencies: [], lifecycle: false }],
    },
    ...overrides,
  };
}

async function expectDatabaseRejection(query: PromiseLike<unknown>) {
  let rejected = false;
  try { await query; } catch { rejected = true; }
  expect(rejected).toBe(true);
}

async function markBuildReady(ownerId: string, buildId: string) {
  const manifestId = crypto.randomUUID();
  const manifestDigest = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  await db`INSERT INTO portable_software_manifests(id,owner_id,base_id,digest,manifest)
    VALUES(${manifestId},${ownerId},${baseId},${manifestDigest},${{ version: 1 }})`;
  await db`UPDATE portable_software_builds SET status='ready',helper_request_digest=${"d".repeat(64)},manifest_id=${manifestId},
    resolved_manifest_digest=${manifestDigest},snapshot_started_at=now(),finished_at=now(),updated_at=now() WHERE id=${buildId} AND owner_id=${ownerId}`;
}

async function signIn(email: string) {
  let link = "";
  setMagicLinkDeliveryForTests(message => { link = message.url; });
  const sent = await handler(new Request("http://127.0.0.1:4310/api/auth/sign-in/magic-link", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:4310" }, body: JSON.stringify({ email, callbackURL: "/" }),
  }));
  expect(sent.status).toBe(200);
  const verified = await handler(new Request(link, { redirect: "manual" }));
  return { cookie: verified.headers.get("set-cookie")!.split(";")[0], user: (await (await handler(new Request("http://127.0.0.1:4310/api/me", { headers: { cookie: verified.headers.get("set-cookie")!.split(";")[0] } }))).json() as any).user };
}

test("preparation is explicitly unavailable until an operator selects a trusted base", async () => {
  await db`DELETE FROM portable_software_base_selection`;
  const ownerId = await owner();
  const saved = await template(ownerId);
  await expect(enqueueTemplateSoftware(ownerId, crypto.randomUUID(), { templateId: saved.id, expectedRevision: 1, ...roots }))
    .rejects.toBeInstanceOf(SoftwareUnavailable);
  expect((await db`SELECT revision,software_build_id FROM agent_templates WHERE id=${saved.id}`)[0])
    .toMatchObject({ revision: 1, software_build_id: null });
  await activateSoftwareBase(baseId);
});

test("owner enqueue pins an immutable base and roots before provider work and deduplicates the command", async () => {
  const ownerId = await owner();
  const saved = await template(ownerId);
  const commandId = crypto.randomUUID();
  const request = {
    templateId: saved.id,
    expectedRevision: 1,
    apt: [...roots.apt, { name: "curl", version: "8.5.0-2ubuntu10.6" }],
    npm: roots.npm,
  };
  const build = await enqueueTemplateSoftware(ownerId, commandId, request);
  expect(build).toMatchObject({
    id: commandId, ownerId, templateId: saved.id, expectedRevision: 1, templateRevision: 2,
    baseId, status: "queued", helperRequestDigest: null, manifestId: null,
    providerSnapshotName: `companions-software-${commandId}`,
    roots: { apt: [{ name: "curl", version: "8.5.0-2ubuntu10.6" }, ...roots.apt], npm: roots.npm },
  });
  expect(build.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(build.createKey).toMatch(/^[a-f0-9-]{36}$/);
  expect((await enqueueTemplateSoftware(ownerId, commandId, request)).id).toBe(commandId);
  await expect(enqueueTemplateSoftware(ownerId, commandId, { ...request, npm: [{ name: "tsx", version: "4.20.5" }] }))
    .rejects.toBeInstanceOf(SoftwareConflict);

  expect((await db`SELECT revision,software_build_id,snapshot_name,source_companion_id FROM agent_templates WHERE id=${saved.id}`)[0])
    .toMatchObject({ revision: 2, software_build_id: commandId, snapshot_name: null, source_companion_id: null });
  expect((await listTemplateRevisions(ownerId, saved.id)).map((revision: any) => [revision.revision, revision.softwareBuildId]))
    .toEqual([[2, commandId], [1, null]]);
  expect((await db`SELECT count(*)::int AS count FROM portable_software_builds WHERE template_id=${saved.id}`)[0].count).toBe(1);
});

test("software build reads and command identifiers remain owner scoped", async () => {
  const ownerId = await owner("First owner");
  const otherId = await owner("Second owner");
  const first = await template(ownerId, "First template");
  const second = await template(otherId, "Second template");
  const commandId = crypto.randomUUID();
  await enqueueTemplateSoftware(ownerId, commandId, { templateId: first.id, expectedRevision: 1, ...roots });

  expect(await getSoftwareBuild(otherId, commandId)).toBeNull();
  await expect(enqueueTemplateSoftware(otherId, crypto.randomUUID(), { templateId: first.id, expectedRevision: 1, ...roots }))
    .rejects.toBeInstanceOf(SoftwareConflict);
  await expect(enqueueTemplateSoftware(otherId, commandId, { templateId: second.id, expectedRevision: 1, ...roots }))
    .rejects.toBeInstanceOf(SoftwareConflict);
  expect((await db`SELECT revision FROM agent_templates WHERE id=${second.id}`)[0].revision).toBe(1);
});

test("concurrent preparation at one expected revision publishes exactly one revision", async () => {
  const ownerId = await owner();
  const saved = await template(ownerId);
  const results = await Promise.allSettled([
    enqueueTemplateSoftware(ownerId, crypto.randomUUID(), { templateId: saved.id, expectedRevision: 1, ...roots }),
    enqueueTemplateSoftware(ownerId, crypto.randomUUID(), { templateId: saved.id, expectedRevision: 1, ...roots }),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(SoftwareConflict);
  expect((await db`SELECT revision FROM agent_templates WHERE id=${saved.id}`)[0].revision).toBe(2);
  expect((await db`SELECT count(*)::int AS count FROM portable_software_builds WHERE template_id=${saved.id}`)[0].count).toBe(1);
  expect((await listTemplateRevisions(ownerId, saved.id)).map((revision: any) => revision.revision)).toEqual([2, 1]);
});

test("simultaneous retries of one command converge on the same durable build", async () => {
  const ownerId = await owner();
  const saved = await template(ownerId);
  const commandId = crypto.randomUUID();
  const request = { templateId: saved.id, expectedRevision: 1, ...roots };
  const results = await Promise.all([
    enqueueTemplateSoftware(ownerId, commandId, request),
    enqueueTemplateSoftware(ownerId, commandId, request),
  ]);
  expect(results.map(result => result.id)).toEqual([commandId, commandId]);
  expect((await db`SELECT count(*)::int AS count FROM portable_software_builds WHERE id=${commandId}`)[0].count).toBe(1);
  expect((await db`SELECT revision FROM agent_templates WHERE id=${saved.id}`)[0].revision).toBe(2);
});

test("ordinary edits and rollback preserve or restore the pinned software build", async () => {
  const ownerId = await owner();
  const saved = await template(ownerId);
  const build = await enqueueTemplateSoftware(ownerId, crypto.randomUUID(), { templateId: saved.id, expectedRevision: 1, ...roots });
  await saveTemplate(ownerId, {
    id: saved.id, expectedRevision: 2, name: "Renamed", instructions: "Keep prepared tools", avatar: { shape: 2, color: 3, face: 4 },
  });
  expect((await db`SELECT software_build_id FROM agent_templates WHERE id=${saved.id}`)[0].software_build_id).toBe(build.id);

  await rollbackTemplate(ownerId, saved.id, { targetRevision: 1, expectedRevision: 3 });
  expect((await db`SELECT revision,software_build_id FROM agent_templates WHERE id=${saved.id}`)[0])
    .toMatchObject({ revision: 4, software_build_id: null });
  await rollbackTemplate(ownerId, saved.id, { targetRevision: 2, expectedRevision: 4 });
  expect((await db`SELECT revision,software_build_id FROM agent_templates WHERE id=${saved.id}`)[0])
    .toMatchObject({ revision: 5, software_build_id: build.id });
});

test("runtime checkpoints bind the helper digest and immutable exact-root manifest", async () => {
  const ownerId = await owner();
  const otherId = await owner();
  const saved = await template(ownerId);
  const otherTemplate = await template(otherId, "Other owner template");
  const build = await enqueueTemplateSoftware(ownerId, crypto.randomUUID(), { templateId: saved.id, expectedRevision: 1, ...roots });
  const helperDigest = "d".repeat(64);
  expect(await pinSoftwareHelperRequestDigest(ownerId, build.id, helperDigest)).toEqual({ digest: helperDigest });
  expect(await pinSoftwareHelperRequestDigest(ownerId, build.id, helperDigest)).toEqual({ digest: helperDigest });
  await expect(pinSoftwareHelperRequestDigest(ownerId, build.id, "e".repeat(64))).rejects.toBeInstanceOf(SoftwareConflict);
  await expect(pinSoftwareHelperRequestDigest(otherId, build.id, helperDigest)).rejects.toBeInstanceOf(SoftwareConflict);

  const manifest = resolvedManifest();
  const recorded = await recordResolvedSoftwareManifest(ownerId, build.id, manifest);
  expect(await recordResolvedSoftwareManifest(ownerId, build.id, manifest)).toEqual(recorded);
  expect((await getSoftwareBuild(ownerId, build.id))?.resolvedManifestDigest).toBe(recorded.digest);
  await expect(recordResolvedSoftwareManifest(otherId, build.id, manifest)).rejects.toBeInstanceOf(SoftwareConflict);
  await expect(recordResolvedSoftwareManifest(ownerId, build.id, resolvedManifest({
    npm: { roots: [], packages: [] },
  }))).rejects.toBeInstanceOf(SoftwareConflict);

  await expectDatabaseRejection(db`UPDATE portable_software_manifests SET digest=${"f".repeat(64)} WHERE id=${recorded.manifestId}`);
  await expectDatabaseRejection(db`DELETE FROM portable_software_manifests WHERE id=${recorded.manifestId}`);
  await expectDatabaseRejection(db`UPDATE portable_software_bases SET distribution_digest=${"f".repeat(64)} WHERE id=${baseId}`);
  await expectDatabaseRejection(db`UPDATE agent_templates SET software_build_id=${build.id} WHERE id=${otherTemplate.id}`);
});

test("a nominal ready status without every verification checkpoint remains unusable", async () => {
  const ownerId = await owner();
  const saved = await template(ownerId);
  const build = await enqueueTemplateSoftware(ownerId, crypto.randomUUID(), { templateId: saved.id, expectedRevision: 1, ...roots });
  await db`UPDATE portable_software_builds SET status='ready' WHERE id=${build.id}`;
  expect((await templateSoftwareStatus(ownerId, saved.id, build.id)).build).toMatchObject({ status: "ready", verified: false });
  await expect(resolvedSoftwareSnapshot(ownerId, build.id, db)).rejects.toMatchObject({ code: "software_verification_incomplete" });
  await expect(createCompanion(ownerId, { name: "Unverified", provider: "box", templateId: saved.id })).rejects.toThrow("not verified");
});

test("creation rejects pending and failed software, then pins only a fully verified clean snapshot", async () => {
  const ownerId = await owner();
  const saved = await template(ownerId);
  const pending = await enqueueTemplateSoftware(ownerId, crypto.randomUUID(), { templateId: saved.id, expectedRevision: 1, ...roots });
  const before = (await db`SELECT count(*)::int AS count FROM companions WHERE owner_id=${ownerId}`)[0].count;
  await expect(createCompanion(ownerId, { name: "Too early", provider: "box", templateId: saved.id })).rejects.toThrow("still being prepared");
  expect((await db`SELECT count(*)::int AS count FROM companions WHERE owner_id=${ownerId}`)[0].count).toBe(before);
  await db`UPDATE portable_software_builds SET status='failed',error_code='resolver_failed',finished_at=now() WHERE id=${pending.id}`;
  await expect(createCompanion(ownerId, { name: "Failed", provider: "box", templateId: saved.id, templateRevision: 2 })).rejects.toThrow("could not be completed");

  const ready = await enqueueTemplateSoftware(ownerId, crypto.randomUUID(), { templateId: saved.id, expectedRevision: 2, ...roots });
  await markBuildReady(ownerId, ready.id);
  expect((await resolvedSoftwareSnapshot(ownerId, ready.id, db)).snapshotName).toBe(ready.providerSnapshotName);
  const clean = await createCompanion(ownerId, { name: "Clean", provider: "box", templateId: saved.id, templateRevision: 3 });
  expect(clean).toMatchObject({ softwareBuildId: ready.id });
  expect((await db`SELECT snapshot_name,software_build_id,prepare_requested FROM companions WHERE id=${clean.id}`)[0])
    .toMatchObject({ snapshot_name: ready.providerSnapshotName, software_build_id: ready.id, prepare_requested: false });
  await expect(createCompanion(ownerId, { name: "Wrong provider", provider: "local", templateId: saved.id })).rejects.toThrow("requires Box");

  await db.begin(async tx => {
    await tx`UPDATE agent_templates SET snapshot_name='same-owner-private-capture',revision=revision+1 WHERE id=${saved.id}`;
    await recordTemplateRevision(tx, saved.id);
  });
  const privateCapture = await createCompanion(ownerId, { name: "Private capture", provider: "box", templateId: saved.id });
  expect((await db`SELECT snapshot_name,software_build_id FROM companions WHERE id=${privateCapture.id}`)[0])
    .toMatchObject({ snapshot_name: "same-owner-private-capture", software_build_id: ready.id });
});

test("delegation refuses unavailable software and pins a ready build before child preparation", async () => {
  const ownerId = await owner();
  const parent = await createCompanion(ownerId, { name: "Parent", provider: "box" });
  const saved = await template(ownerId);
  await allowTemplate(ownerId, parent.id, { templateId: saved.id, maxChildren: 2 });
  const pending = await enqueueTemplateSoftware(ownerId, crypto.randomUUID(), { templateId: saved.id, expectedRevision: 1, ...roots });
  await expect(spawnChild(ownerId, parent.id, null, crypto.randomUUID(), { templateId: saved.id, prompt: "Use jq" })).rejects.toThrow("still being prepared");
  expect(await db`SELECT id FROM companions WHERE parent_id=${parent.id}`).toHaveLength(0);
  await db`UPDATE portable_software_builds SET status='failed',error_code='install_failed',finished_at=now() WHERE id=${pending.id}`;
  await expect(spawnChild(ownerId, parent.id, null, crypto.randomUUID(), { templateId: saved.id, prompt: "Use jq" })).rejects.toThrow("could not be completed");

  const ready = await enqueueTemplateSoftware(ownerId, crypto.randomUUID(), { templateId: saved.id, expectedRevision: 2, ...roots });
  await markBuildReady(ownerId, ready.id);
  const spawned = await spawnChild(ownerId, parent.id, null, crypto.randomUUID(), { templateId: saved.id, prompt: "Use jq" });
  expect((await db`SELECT snapshot_name,software_build_id,prepare_requested FROM companions WHERE id=${spawned.companionId}`)[0])
    .toMatchObject({ snapshot_name: ready.providerSnapshotName, software_build_id: ready.id, prepare_requested: true });
});

test("template capture cannot race or replace its prepared software with an older child", async () => {
  const ownerId = await owner();
  const parent = await createCompanion(ownerId, { name: "Capture parent", provider: "box" });
  const saved = await template(ownerId);
  await allowTemplate(ownerId, parent.id, { templateId: saved.id, maxChildren: 3 });
  const oldChild = await spawnChild(ownerId, parent.id, null, crypto.randomUUID(), { templateId: saved.id, prompt: "Baseline" });
  const pending = await enqueueTemplateSoftware(ownerId, crypto.randomUUID(), { templateId: saved.id, expectedRevision: 1, ...roots });
  await expect(adoptTemplate(ownerId, parent.id, crypto.randomUUID(), { templateId: saved.id, childId: oldChild.companionId, expectedRevision: 2 }))
    .rejects.toThrow("does not use this template software revision");
  expect(await db`SELECT id FROM template_candidates WHERE template_id=${saved.id}`).toHaveLength(0);

  await markBuildReady(ownerId, pending.id);
  const preparedChild = await spawnChild(ownerId, parent.id, null, crypto.randomUUID(), { templateId: saved.id, prompt: "Prepared" });
  const candidateId = crypto.randomUUID();
  expect(await adoptTemplate(ownerId, parent.id, candidateId, { templateId: saved.id, childId: preparedChild.companionId, expectedRevision: 2 }))
    .toEqual({ candidateId });

  const second = await template(ownerId, "Capture first");
  await allowTemplate(ownerId, parent.id, { templateId: second.id, maxChildren: 1 });
  const child = await spawnChild(ownerId, parent.id, null, crypto.randomUUID(), { templateId: second.id, prompt: "Capture" });
  await adoptTemplate(ownerId, parent.id, crypto.randomUUID(), { templateId: second.id, childId: child.companionId, expectedRevision: 1 });
  await expect(enqueueTemplateSoftware(ownerId, crypto.randomUUID(), { templateId: second.id, expectedRevision: 1, ...roots }))
    .rejects.toThrow("Finish the current template capture");
  expect(await db`SELECT id FROM portable_software_builds WHERE template_id=${second.id}`).toHaveLength(0);
});

test("software API is strict, asynchronous, and owner scoped", async () => {
  const alice = await signIn(`software-alice-${crypto.randomUUID()}@example.test`);
  const bob = await signIn(`software-bob-${crypto.randomUUID()}@example.test`);
  const saved = await template(alice.user.id);
  const commandId = crypto.randomUUID();
  const headers = { cookie: alice.cookie, "content-type": "application/json" };
  const prepare = (body: unknown) => handler(new Request(`http://127.0.0.1:4310/api/templates/${saved.id}/software/prepare`, { method: "POST", headers, body: JSON.stringify(body) }));
  const response = await prepare({ clientCommandId: commandId, expectedRevision: 1, ...roots });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ templateId: saved.id, templateRevision: 2, build: { id: commandId, status: "queued", verified: false } });
  expect((await prepare({ clientCommandId: crypto.randomUUID(), expectedRevision: 2, ...roots, baseId })).status).toBe(400);
  const ownStatus = await handler(new Request(`http://127.0.0.1:4310/api/templates/${saved.id}/software/status?buildId=${commandId}`, { headers }));
  expect(ownStatus.status).toBe(200);
  expect((await ownStatus.json() as any).build.id).toBe(commandId);
  const foreignStatus = await handler(new Request(`http://127.0.0.1:4310/api/templates/${saved.id}/software/status`, { headers: { cookie: bob.cookie } }));
  expect(foreignStatus.status).toBe(409);
  expect(JSON.stringify(await foreignStatus.json())).not.toContain(commandId);
});

test("control MCP prepares software for permanent Companions and denies temporary children", async () => {
  const ownerId = await owner();
  const parent = await createCompanion(ownerId, { name: "Controller", provider: "box" });
  const saved = await template(ownerId);
  const parentRun = crypto.randomUUID();
  await db`INSERT INTO runs(id,companion_id,client_message_id,content,status,dispatched,started_at) VALUES(${parentRun},${parent.id},${crypto.randomUUID()},'Prepare template','running',true,now())`;
  const commandId = crypto.randomUUID();
  const result = await applyControl(parent.id, { id: commandId, runId: parentRun, operation: "software_prepare", input: { templateId: saved.id, expectedRevision: 1, ...roots } }) as any;
  expect(result).toMatchObject({ build: { id: commandId, status: "queued" } });

  const childId = crypto.randomUUID(), childRun = crypto.randomUUID();
  await db`INSERT INTO companions(id,owner_id,name,instructions,provider,create_key,agent_secret,parent_id,temporary,prepare_requested)
    VALUES(${childId},${ownerId},'Temporary','', 'box',${crypto.randomUUID()},'secret',${parent.id},true,false)`;
  await db`INSERT INTO runs(id,companion_id,client_message_id,content,status,dispatched,started_at) VALUES(${childRun},${childId},${crypto.randomUUID()},'Try preparation','running',true,now())`;
  const childCommand = crypto.randomUUID();
  expect(await applyControl(childId, { id: childCommand, runId: childRun, operation: "software_status", input: { templateId: saved.id } }))
    .toEqual({ error: "Ask your parent to manage templates and additional agents." });
  expect(await db`SELECT id FROM control_commands WHERE id=${childCommand} AND status='done'`).toHaveLength(1);
});
