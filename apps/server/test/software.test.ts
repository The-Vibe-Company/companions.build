import { beforeAll, expect, test } from "bun:test";
import { db, migrate } from "../src/store";
import {
  activateSoftwareBase,
  enqueueTemplateSoftware,
  getSoftwareBuild,
  pinSoftwareHelperRequestDigest,
  recordResolvedSoftwareManifest,
  registerSoftwareBase,
  SoftwareConflict,
  SoftwareUnavailable,
  type PortableSoftwareManifest,
} from "../src/software";
import { listTemplateRevisions, rollbackTemplate, saveTemplate } from "../src/templates";

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
