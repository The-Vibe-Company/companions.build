import { z } from "zod";

export type ResolvedSoftwareSnapshot = {
  buildId: string | null;
  resultId: string;
  snapshotName: string;
  manifestDigest: string;
  helperRequestDigest: string | null;
};

export class SoftwareReadinessError extends Error {
  constructor(readonly code: "software_build_unavailable" | "software_preparing" | "software_failed" | "software_verification_incomplete", message: string) {
    super(message);
  }
}

/** Resolve only a fully verified result granted to this owner. This function never contacts Box. */
export async function resolvedSoftwareSnapshot(ownerId: string, buildId: string | null, resultId: string | null, sql: any): Promise<ResolvedSoftwareSnapshot> {
  if (buildId && resultId) throw new SoftwareReadinessError("software_verification_incomplete", "Prepared software provenance is ambiguous.");
  if (resultId) {
    const id = z.string().uuid().parse(resultId);
    const [result] = await sql`SELECT r.id,r.provider_snapshot_name,r.manifest_digest
      FROM portable_software_results r JOIN portable_software_result_grants g ON g.result_id=r.id AND g.owner_id=${ownerId}
      WHERE r.id=${id}`;
    if (!result) throw new SoftwareReadinessError("software_build_unavailable", "Prepared software is unavailable.");
    return { buildId: null, resultId: result.id, snapshotName: result.provider_snapshot_name, manifestDigest: result.manifest_digest, helperRequestDigest: null };
  }
  if (!buildId) throw new SoftwareReadinessError("software_build_unavailable", "Prepared software is unavailable.");
  const id = z.string().uuid().parse(buildId);
  const [build] = await sql`SELECT id,status,error_code,helper_request_digest,manifest_id,resolved_manifest_digest,
      provider_snapshot_name,snapshot_started_at,finished_at,result_id
    FROM portable_software_builds WHERE id=${id} AND owner_id=${ownerId}`;
  if (!build) throw new SoftwareReadinessError("software_build_unavailable", "Prepared software is unavailable.");
  if (build.status === "failed") throw new SoftwareReadinessError("software_failed", "Prepared software could not be completed.");
  if (build.status !== "ready") throw new SoftwareReadinessError("software_preparing", "Prepared software is still being prepared.");
  if (!build.helper_request_digest || !build.manifest_id || !build.resolved_manifest_digest || !build.snapshot_started_at || !build.finished_at || !build.result_id) {
    throw new SoftwareReadinessError("software_verification_incomplete", "Prepared software is not verified for use.");
  }
  const [result] = await sql`SELECT r.id,r.provider_snapshot_name,r.manifest_digest FROM portable_software_results r
    JOIN portable_software_result_grants g ON g.result_id=r.id AND g.owner_id=${ownerId}
    WHERE r.id=${build.result_id} AND r.source_build_id=${build.id} AND r.provider_snapshot_name=${build.provider_snapshot_name}
      AND r.manifest_digest=${build.resolved_manifest_digest}`;
  if (!result) throw new SoftwareReadinessError("software_verification_incomplete", "Prepared software is not verified for use.");
  return {
    buildId: build.id,
    resultId: result.id,
    snapshotName: result.provider_snapshot_name,
    manifestDigest: result.manifest_digest,
    helperRequestDigest: build.helper_request_digest,
  };
}

/** A same-owner private capture may include more state, but never bypasses software readiness. */
export async function requireSoftwareReady(ownerId: string, softwareBuildId: string | null, softwareResultId: string | null, privateSnapshot: string | null, sql: any) {
  if (!softwareBuildId && !softwareResultId) return privateSnapshot;
  const clean = await resolvedSoftwareSnapshot(ownerId, softwareBuildId, softwareResultId, sql);
  return privateSnapshot ?? clean.snapshotName;
}
