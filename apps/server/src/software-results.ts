import { z } from "zod";
import { canonicalSoftwareManifest, softwareManifestDigest, validatePortableSoftwareManifest } from "../../../packages/control/software";
import { SoftwareConflict } from "./software";

const id = z.string().uuid();

/** DB-only callback: the fenced runtime has already observed the named snapshot ready. */
export async function createVerifiedSoftwareResult(tx: any, input: { id: string; owner_id?: string; ownerId?: string }) {
  const ownerId = input.owner_id ?? input.ownerId;
  const [build] = await tx`SELECT b.*,m.manifest,m.digest FROM portable_software_builds b
    JOIN portable_software_manifests m ON m.id=b.manifest_id AND m.owner_id=b.owner_id
    WHERE b.id=${id.parse(input.id)} AND b.owner_id=${ownerId}
      AND b.status IN ('capturing','ready') AND b.snapshot_started_at IS NOT NULL
      AND b.helper_request_digest IS NOT NULL FOR UPDATE OF b`;
  if (!build) throw new SoftwareConflict("Verified software build unavailable.");
  const manifest = validatePortableSoftwareManifest(build.manifest);
  if (softwareManifestDigest(manifest) !== build.resolved_manifest_digest || build.digest !== build.resolved_manifest_digest) {
    throw new SoftwareConflict("Verified software manifest changed.");
  }
  await tx`INSERT INTO portable_software_results(id,source_build_id,base_id,manifest_digest,manifest,provider_snapshot_name)
    VALUES(${build.id},${build.id},${build.base_id},${build.digest},${manifest},${build.provider_snapshot_name})
    ON CONFLICT(source_build_id) DO NOTHING`;
  const [result] = await tx`SELECT * FROM portable_software_results WHERE source_build_id=${build.id}`;
  if (result.id !== build.id || result.provider_snapshot_name !== build.provider_snapshot_name
    || result.manifest_digest !== build.digest || canonicalSoftwareManifest(result.manifest) !== canonicalSoftwareManifest(manifest)) {
    throw new SoftwareConflict("Verified software result changed.");
  }
  await tx`INSERT INTO portable_software_result_grants(result_id,owner_id) VALUES(${result.id},${ownerId}) ON CONFLICT DO NOTHING`;
  await tx`UPDATE portable_software_builds SET result_id=${result.id} WHERE id=${build.id} AND owner_id=${ownerId}`;
  return result.id as string;
}

export async function grantedSoftwareSnapshot(tx: any, ownerId: string, resultId: string): Promise<string> {
  const [result] = await tx`SELECT r.provider_snapshot_name FROM portable_software_results r
    JOIN portable_software_result_grants g ON g.result_id=r.id
    WHERE r.id=${id.parse(resultId)} AND g.owner_id=${ownerId}`;
  if (!result) throw new SoftwareConflict("Prepared software is unavailable.");
  return result.provider_snapshot_name;
}

type DeliverySoftwarePin = {
  key: string; softwareBuildId?: string | null; softwareResultId?: string | null; templateRevision?: number | null;
};

export async function pinDeliverySoftware(tx: any, deliveryId: string, ownerId: string, pins: DeliverySoftwarePin[]) {
  for (const pin of pins) {
    if (!pin.softwareBuildId && !pin.softwareResultId) continue;
    if (pin.softwareBuildId && pin.softwareResultId) throw new SoftwareConflict("Software provenance is ambiguous.");
    const key = pin.key === "main" ? "main" : id.parse(pin.key);
    await tx`INSERT INTO delivery_software_targets(delivery_id,target_key,source_owner_id,source_template_revision,source_build_id,source_result_id)
      VALUES(${id.parse(deliveryId)},${key},${ownerId},${pin.templateRevision ?? null},${pin.softwareBuildId ?? null},${pin.softwareResultId ?? null})`;
  }
  return refreshDeliverySoftware(tx, deliveryId);
}

/** Status derives only from pinned revisions/results; later template edits cannot affect it. */
export async function refreshDeliverySoftware(tx: any, deliveryId: string) {
  const targets = await tx`SELECT t.target_key,b.status,b.result_id,t.source_result_id FROM delivery_software_targets t
    LEFT JOIN portable_software_builds b ON b.id=t.source_build_id AND b.owner_id=t.source_owner_id
    WHERE t.delivery_id=${id.parse(deliveryId)}`;
  const failed = targets.some((target: any) => !target.source_result_id && target.status === "failed");
  const pending = targets.some((target: any) => !target.source_result_id && (target.status !== "ready" || !target.result_id));
  const status = failed ? "error" : pending ? "pending" : "ready";
  const error = failed ? "Prepared software could not be built." : null;
  await tx`UPDATE companion_deliveries SET software_status=${status},software_error=${error}
    WHERE id=${deliveryId} AND status='pending'`;
  return { softwareStatus: status, softwareError: error };
}

/** Called within acceptance: an independent client gains the immutable clean image only. */
export async function grantDeliverySoftware(tx: any, deliveryId: string, recipientId: string): Promise<Map<string, { id: string; snapshot: string }>> {
  const [consent] = await tx`SELECT d.id FROM companion_deliveries d JOIN "user" u
    ON lower(u.email)=d.recipient_email AND u.id=${recipientId} AND u."emailVerified"=true
    WHERE d.id=${id.parse(deliveryId)} AND d.status='pending' AND d.expires_at>now()`;
  if (!consent) throw new SoftwareConflict("Delivery software is unavailable.");
  const state = await refreshDeliverySoftware(tx, deliveryId);
  if (state.softwareStatus !== "ready") throw new SoftwareConflict("Prepared software is not ready.");
  const targets = await tx`SELECT t.target_key,r.id,r.provider_snapshot_name FROM delivery_software_targets t
    LEFT JOIN portable_software_builds b ON b.id=t.source_build_id AND b.owner_id=t.source_owner_id
    JOIN portable_software_results r ON r.id=COALESCE(t.source_result_id,b.result_id)
    JOIN portable_software_result_grants g ON g.result_id=r.id AND g.owner_id=t.source_owner_id
    WHERE t.delivery_id=${deliveryId}`;
  const [{ count }] = await tx`SELECT count(*)::int AS count FROM delivery_software_targets WHERE delivery_id=${deliveryId}`;
  if (targets.length !== count) throw new SoftwareConflict("Prepared software result is missing.");
  const results = new Map<string, { id: string; snapshot: string }>();
  for (const target of targets) {
    await tx`INSERT INTO portable_software_result_grants(result_id,owner_id,delivery_id)
      VALUES(${target.id},${recipientId},${deliveryId}) ON CONFLICT DO NOTHING`;
    results.set(target.target_key, { id: target.id, snapshot: target.provider_snapshot_name });
  }
  return results;
}
