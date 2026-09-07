import { z } from "zod";

export type ResolvedSoftwareSnapshot = {
  buildId: string;
  snapshotName: string;
  manifestId: string;
  manifestDigest: string;
  helperRequestDigest: string;
};

export class SoftwareReadinessError extends Error {
  constructor(readonly code: "software_build_unavailable" | "software_preparing" | "software_failed" | "software_verification_incomplete", message: string) {
    super(message);
  }
}

/** Resolve only a fully verified, captured owner build. This function never contacts Box. */
export async function resolvedSoftwareSnapshot(ownerId: string, buildId: string, sql: any): Promise<ResolvedSoftwareSnapshot> {
  const id = z.string().uuid().parse(buildId);
  const [build] = await sql`SELECT id,status,error_code,helper_request_digest,manifest_id,resolved_manifest_digest,
      provider_snapshot_name,snapshot_started_at,finished_at
    FROM portable_software_builds WHERE id=${id} AND owner_id=${ownerId}`;
  if (!build) throw new SoftwareReadinessError("software_build_unavailable", "Prepared software is unavailable.");
  if (build.status === "failed") throw new SoftwareReadinessError("software_failed", "Prepared software could not be completed.");
  if (build.status !== "ready") throw new SoftwareReadinessError("software_preparing", "Prepared software is still being prepared.");
  if (!build.helper_request_digest || !build.manifest_id || !build.resolved_manifest_digest || !build.snapshot_started_at || !build.finished_at) {
    throw new SoftwareReadinessError("software_verification_incomplete", "Prepared software is not verified for use.");
  }
  return {
    buildId: build.id,
    snapshotName: build.provider_snapshot_name,
    manifestId: build.manifest_id,
    manifestDigest: build.resolved_manifest_digest,
    helperRequestDigest: build.helper_request_digest,
  };
}

/** A same-owner private capture may include more state, but never bypasses software readiness. */
export async function requireSoftwareReady(ownerId: string, softwareBuildId: string | null, privateSnapshot: string | null, sql: any) {
  if (!softwareBuildId) return privateSnapshot;
  const clean = await resolvedSoftwareSnapshot(ownerId, softwareBuildId, sql);
  return privateSnapshot ?? clean.snapshotName;
}
