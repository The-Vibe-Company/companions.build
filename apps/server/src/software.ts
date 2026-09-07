import { createHash } from "node:crypto";
import valid from "semver/functions/valid";
import { z } from "zod";
import { canonicalSoftwareManifest, softwareManifestDigest, validatePortableSoftwareManifest, type PortableSoftwareManifest } from "../../../packages/control/software";
import { db } from "./store";
import { recordTemplateRevision } from "./templates";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._+-]*$/);
const snapshotName = z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9-]*$/);
const aptName = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9+.-]*$/);
const aptVersion = z.string().min(1).max(192).regex(/^[A-Za-z0-9][A-Za-z0-9.+:~\-]*$/);
const npmName = z.string().min(1).max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/);
const exactNpmVersion = z.string().min(1).max(128).refine(value => valid(value) === value, "An exact npm version is required");

export const softwareRootsSchema = z.object({
  apt: z.array(z.object({ name: aptName, version: aptVersion }).strict()).max(32).default([]),
  npm: z.array(z.object({ name: npmName, version: exactNpmVersion }).strict()).max(32).default([]),
}).strict().refine(value => value.apt.length + value.npm.length > 0, "At least one package is required");

export type SoftwareRoots = z.infer<typeof softwareRootsSchema>;
export type SoftwareBaseRegistration = {
  id: string;
  providerSnapshotName: string;
  distributionDigest: string;
  resolverConfigDigest: string;
  distro: { family: string; suite: string; architecture: string };
};
export type SoftwareBuildStatus = "queued" | "creating" | "resolving" | "installing" | "verifying" | "capturing" | "ready" | "failed";
export type SoftwareBuildRecord = {
  id: string; ownerId: string; templateId: string; expectedRevision: number; templateRevision: number;
  baseId: string; roots: SoftwareRoots; requestFingerprint: string; helperRequestDigest: string | null;
  createKey: string; boxId: string | null; manifestId: string | null; resolvedManifestDigest: string | null;
  providerSnapshotName: string; status: SoftwareBuildStatus; cleanupStatus: "pending" | "complete" | "error"; errorCode: string | null;
};

export class SoftwareConflict extends Error {}
export class SoftwareUnavailable extends Error {}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const compare = (a: { name: string; version: string }, b: { name: string; version: string }) => compareText(a.name, b.name) || compareText(a.version, b.version);

export function canonicalSoftwareRoots(input: unknown): SoftwareRoots {
  const roots = softwareRootsSchema.parse(input);
  for (const values of [roots.apt, roots.npm]) {
    if (new Set(values.map(value => value.name)).size !== values.length) throw new SoftwareConflict("Each package may be requested only once.");
  }
  return { apt: [...roots.apt].sort(compare), npm: [...roots.npm].sort(compare) };
}

function validateBase(input: SoftwareBaseRegistration) {
  const base = validatePortableSoftwareManifest({
    version: 1,
    base: { id: identifier.parse(input.id), distributionDigest: sha256.parse(input.distributionDigest), distro: input.distro },
    apt: { roots: [], packages: [] }, npm: { roots: [], packages: [] },
  }).base;
  return {
    ...base,
    providerSnapshotName: snapshotName.parse(input.providerSnapshotName),
    resolverConfigDigest: sha256.parse(input.resolverConfigDigest),
  };
}

/** Internal operator surface. No authenticated tenant route calls this function. */
export async function registerSoftwareBase(input: SoftwareBaseRegistration, sql: any = db) {
  const value = validateBase(input);
  const inserted = await sql`INSERT INTO portable_software_bases(id,provider_snapshot_name,distribution_digest,resolver_config_digest,distro_family,distro_suite,distro_architecture)
    VALUES(${value.id},${value.providerSnapshotName},${value.distributionDigest},${value.resolverConfigDigest},${value.distro.family},${value.distro.suite},${value.distro.architecture})
    ON CONFLICT DO NOTHING RETURNING id`;
  const [row] = await sql`SELECT id,provider_snapshot_name,distribution_digest,resolver_config_digest,distro_family,distro_suite,distro_architecture FROM portable_software_bases WHERE id=${value.id}`;
  if (!row || row.provider_snapshot_name !== value.providerSnapshotName || row.distribution_digest !== value.distributionDigest
    || row.resolver_config_digest !== value.resolverConfigDigest || row.distro_family !== value.distro.family
    || row.distro_suite !== value.distro.suite || row.distro_architecture !== value.distro.architecture) {
    throw new SoftwareConflict("The software base identifier is already registered with different details.");
  }
  return { id: row.id, registered: inserted.length === 1 };
}

/** Internal operator surface. Selection is mutable; registered base rows remain immutable. */
export async function activateSoftwareBase(baseId: string, sql: any = db) {
  const id = identifier.parse(baseId);
  const rows = await sql`INSERT INTO portable_software_base_selection(singleton,base_id,selected_at)
    SELECT true,id,now() FROM portable_software_bases WHERE id=${id}
    ON CONFLICT(singleton) DO UPDATE SET base_id=EXCLUDED.base_id,selected_at=EXCLUDED.selected_at RETURNING base_id AS id`;
  if (!rows.length) throw new SoftwareConflict("Software base not found.");
  return rows[0];
}

function userFingerprint(templateId: string, expectedRevision: number, baseId: string, roots: SoftwareRoots) {
  return digest(JSON.stringify({ version: 1, templateId, expectedRevision, baseId, roots }));
}

const prepareSchema = z.object({ templateId: z.string().uuid(), expectedRevision: z.number().int().positive() }).extend(softwareRootsSchema.shape).strict();

/** Owner mutation: persist a complete intent and revision before any runtime/provider effect. */
export async function enqueueTemplateSoftware(ownerId: string, commandId: string, input: unknown, sql: any = db) {
  const id = z.string().uuid().parse(commandId);
  const parsed = prepareSchema.parse(input);
  const roots = canonicalSoftwareRoots({ apt: parsed.apt, npm: parsed.npm });
  return sql.begin(async (tx: any) => {
    const [owned] = await tx`SELECT id FROM agent_templates WHERE id=${parsed.templateId} AND owner_id=${ownerId}`;
    if (!owned) throw new SoftwareConflict("Template unavailable.");

    const [prior] = await tx`SELECT b.*,s.distribution_digest,s.resolver_config_digest FROM portable_software_builds b
      JOIN portable_software_bases s ON s.id=b.base_id WHERE b.id=${id} AND b.owner_id=${ownerId}`;
    if (prior) {
      const expected = userFingerprint(parsed.templateId, parsed.expectedRevision, prior.base_id, roots);
      if (prior.request_fingerprint !== expected) throw new SoftwareConflict("This request identifier was already used with different details.");
      return buildResult(prior);
    }

    const [base] = await tx`SELECT b.* FROM portable_software_base_selection selected JOIN portable_software_bases b ON b.id=selected.base_id WHERE selected.singleton=true`;
    if (!base) throw new SoftwareUnavailable("Portable software preparation is unavailable.");
    const [template] = await tx`SELECT id,revision FROM agent_templates WHERE id=${parsed.templateId} AND owner_id=${ownerId} AND revision=${parsed.expectedRevision} FOR UPDATE`;
    if (!template) {
      // A simultaneous retry can observe no command row before waiting on the
      // template lock. Re-read after the lock holder commits so it converges on
      // that durable result instead of reporting an ambiguous conflict.
      const [committed] = await tx`SELECT b.*,s.distribution_digest,s.resolver_config_digest FROM portable_software_builds b
        JOIN portable_software_bases s ON s.id=b.base_id WHERE b.id=${id} AND b.owner_id=${ownerId}`;
      if (committed) {
        const expected = userFingerprint(parsed.templateId, parsed.expectedRevision, committed.base_id, roots);
        if (committed.request_fingerprint !== expected) throw new SoftwareConflict("This request identifier was already used with different details.");
        return buildResult(committed);
      }
      throw new SoftwareConflict("Template missing or changed.");
    }
    const [capture] = await tx`SELECT id FROM template_candidates WHERE template_id=${parsed.templateId}
      AND status IN ('queued','capturing','ready') LIMIT 1`;
    if (capture) throw new SoftwareConflict("Finish the current template capture before preparing software.");

    const requestFingerprint = userFingerprint(parsed.templateId, parsed.expectedRevision, base.id, roots);
    const nextRevision = parsed.expectedRevision + 1;
    const inserted = await tx`INSERT INTO portable_software_builds(id,owner_id,template_id,expected_revision,template_revision,base_id,requested_roots,request_fingerprint,create_key,provider_snapshot_name)
      VALUES(${id},${ownerId},${parsed.templateId},${parsed.expectedRevision},${nextRevision},${base.id},${roots},${requestFingerprint},${crypto.randomUUID()},${`companions-software-${id}`})
      ON CONFLICT(id) DO NOTHING RETURNING id`;
    if (!inserted.length) throw new SoftwareConflict("Template or request unavailable.");
    const [updated] = await tx`UPDATE agent_templates SET software_build_id=${id},software_result_id=null,snapshot_name=null,source_companion_id=null,revision=${nextRevision},updated_at=now()
      WHERE id=${parsed.templateId} AND owner_id=${ownerId} AND revision=${parsed.expectedRevision} RETURNING id`;
    if (!updated) throw new SoftwareConflict("Template missing or changed.");
    await recordTemplateRevision(tx, parsed.templateId);
    const [build] = await tx`SELECT * FROM portable_software_builds WHERE id=${id}`;
    return buildResult(build);
  });
}

export async function getSoftwareBuild(ownerId: string, buildId: string, sql: any = db): Promise<SoftwareBuildRecord | null> {
  const [row] = await sql`SELECT * FROM portable_software_builds WHERE id=${z.string().uuid().parse(buildId)} AND owner_id=${ownerId}`;
  return row ? buildResult(row) : null;
}

export async function templateSoftwareStatus(ownerId: string, templateId: string, buildId?: string, sql: any = db) {
  const id = z.string().uuid().parse(templateId);
  const [template] = await sql`SELECT revision,software_build_id,software_result_id FROM agent_templates WHERE id=${id} AND owner_id=${ownerId}`;
  if (!template) throw new SoftwareConflict("Template unavailable.");
  if (template.software_build_id && template.software_result_id) throw new SoftwareConflict("Software provenance is ambiguous.");
  const selected = buildId ? z.string().uuid().parse(buildId) : template.software_build_id;
  if (!selected) {
    if (!template.software_result_id) return { templateId: id, templateRevision: template.revision as number, build: null, result: null };
    const [result] = await sql`SELECT r.id,r.base_id,r.manifest_digest,r.created_at FROM portable_software_results r
      JOIN portable_software_result_grants g ON g.result_id=r.id AND g.owner_id=${ownerId}
      WHERE r.id=${template.software_result_id}`;
    if (!result) throw new SoftwareConflict("Software result unavailable.");
    return { templateId: id, templateRevision: template.revision as number, build: null,
      result: { id: result.id as string, baseId: result.base_id as string, manifestDigest: result.manifest_digest as string, verified: true, createdAt: result.created_at } };
  }
  const [build] = await sql`SELECT id,template_revision,base_id,requested_roots,status,error_code,created_at,updated_at,finished_at,
      helper_request_digest IS NOT NULL AND manifest_id IS NOT NULL AND resolved_manifest_digest IS NOT NULL
        AND snapshot_started_at IS NOT NULL AND finished_at IS NOT NULL AND status='ready' AND result_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM portable_software_results r JOIN portable_software_result_grants g ON g.result_id=r.id AND g.owner_id=${ownerId}
          WHERE r.id=portable_software_builds.result_id AND r.source_build_id=portable_software_builds.id
            AND r.provider_snapshot_name=portable_software_builds.provider_snapshot_name AND r.manifest_digest=portable_software_builds.resolved_manifest_digest) AS verified
    FROM portable_software_builds WHERE id=${selected} AND template_id=${id} AND owner_id=${ownerId}`;
  if (!build) throw new SoftwareConflict("Software build unavailable.");
  return {
    templateId: id,
    templateRevision: template.revision as number,
    build: {
      id: build.id as string,
      templateRevision: build.template_revision as number,
      baseId: build.base_id as string,
      roots: softwareRootsSchema.parse(build.requested_roots),
      status: build.status as SoftwareBuildStatus,
      errorCode: build.error_code ?? null,
      verified: !!build.verified,
      createdAt: build.created_at,
      updatedAt: build.updated_at,
      finishedAt: build.finished_at ?? null,
    },
    result: null,
  };
}

export async function prepareTemplateSoftware(ownerId: string, commandId: string, input: unknown, sql: any = db) {
  const build = await enqueueTemplateSoftware(ownerId, commandId, input, sql);
  return templateSoftwareStatus(ownerId, build.templateId, build.id, sql);
}

/** Runtime checkpoint supplied by the portable software helper after it binds operator configuration. */
export async function pinSoftwareHelperRequestDigest(ownerId: string, buildId: string, rawDigest: string, sql: any = db) {
  const helperDigest = sha256.parse(rawDigest);
  const [row] = await sql`UPDATE portable_software_builds SET helper_request_digest=${helperDigest},updated_at=now()
    WHERE id=${z.string().uuid().parse(buildId)} AND owner_id=${ownerId}
      AND (helper_request_digest IS NULL OR helper_request_digest=${helperDigest})
    RETURNING helper_request_digest AS digest`;
  if (!row) throw new SoftwareConflict("Software build unavailable or helper request changed across retries.");
  return row as { digest: string };
}

function assertManifestRoots(build: any, manifest: PortableSoftwareManifest) {
  const requested = softwareRootsSchema.parse(build.requested_roots);
  const expectedApt = requested.apt.map(root => `${root.name}:${manifest.base.distro.architecture}=${root.version}`).sort(compareText);
  const expectedNpm = requested.npm.map(root => `${root.name}@${root.version}`).sort(compareText);
  if (JSON.stringify(manifest.apt.roots) !== JSON.stringify(expectedApt)
    || JSON.stringify(manifest.npm.roots) !== JSON.stringify(expectedNpm)) {
    throw new SoftwareConflict("Resolved software roots do not match the pinned request.");
  }
}

/** Internal runtime checkpoint. It validates base identity before pinning immutable manifest bytes. */
export async function recordResolvedSoftwareManifest(ownerId: string, buildId: string, rawManifest: unknown, sql: any = db) {
  return sql.begin((tx: any) => recordResolvedSoftwareManifestInTransaction(tx, ownerId, buildId, rawManifest));
}

/** Caller owns the transaction and its execution fence. */
export async function recordResolvedSoftwareManifestInTransaction(tx: any, ownerId: string, buildId: string, rawManifest: unknown) {
  const manifest = validatePortableSoftwareManifest(rawManifest);
  const canonical = canonicalSoftwareManifest(manifest);
  const manifestDigest = softwareManifestDigest(manifest);
    const [build] = await tx`SELECT b.*,s.distribution_digest,s.distro_family,s.distro_suite,s.distro_architecture FROM portable_software_builds b
      JOIN portable_software_bases s ON s.id=b.base_id WHERE b.id=${z.string().uuid().parse(buildId)} AND b.owner_id=${ownerId} FOR UPDATE OF b`;
    if (!build) throw new SoftwareConflict("Software build unavailable.");
    if (manifest.base.id !== build.base_id || manifest.base.distributionDigest !== build.distribution_digest
      || manifest.base.distro.family !== build.distro_family || manifest.base.distro.suite !== build.distro_suite
      || manifest.base.distro.architecture !== build.distro_architecture) throw new SoftwareConflict("Resolved software base does not match the pinned build.");
    assertManifestRoots(build, manifest);
    if (build.resolved_manifest_digest && build.resolved_manifest_digest !== manifestDigest) throw new SoftwareConflict("Resolved software manifest changed across retries.");
    let [stored] = await tx`SELECT id,manifest FROM portable_software_manifests WHERE owner_id=${ownerId} AND digest=${manifestDigest}`;
    if (stored && canonicalSoftwareManifest(stored.manifest) !== canonical) throw new SoftwareConflict("Resolved software manifest digest conflict.");
    if (!stored) {
      [stored] = await tx`INSERT INTO portable_software_manifests(id,owner_id,base_id,digest,manifest)
        VALUES(${crypto.randomUUID()},${ownerId},${build.base_id},${manifestDigest},${manifest})
        ON CONFLICT(owner_id,digest) DO NOTHING RETURNING id,manifest`;
      if (!stored) [stored] = await tx`SELECT id,manifest FROM portable_software_manifests WHERE owner_id=${ownerId} AND digest=${manifestDigest}`;
    }
    await tx`UPDATE portable_software_builds SET manifest_id=${stored.id},resolved_manifest_digest=${manifestDigest},updated_at=now()
      WHERE id=${build.id} AND owner_id=${ownerId} AND (manifest_id IS NULL OR manifest_id=${stored.id})`;
    return { manifestId: stored.id as string, digest: manifestDigest };
}

function buildResult(row: any): SoftwareBuildRecord {
  return {
    id: row.id, ownerId: row.owner_id, templateId: row.template_id, expectedRevision: row.expected_revision,
    templateRevision: row.template_revision, baseId: row.base_id, roots: softwareRootsSchema.parse(row.requested_roots),
    requestFingerprint: row.request_fingerprint, helperRequestDigest: row.helper_request_digest ?? null, createKey: row.create_key,
    boxId: row.box_id ?? null, manifestId: row.manifest_id ?? null, resolvedManifestDigest: row.resolved_manifest_digest ?? null,
    providerSnapshotName: row.provider_snapshot_name, status: row.status, cleanupStatus: row.cleanup_status, errorCode: row.error_code ?? null,
  };
}

export type { PortableSoftwareManifest };
