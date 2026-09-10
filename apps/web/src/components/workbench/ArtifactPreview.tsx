import { useEffect, useState } from "react";
import { api } from "@/api";
import type { ArtifactRevision } from "../../../../../packages/workbench/artifacts";
import { safePreviewDocument } from "./preview";

type Frame = { revisionId: string; document: string; label: string };
export function ArtifactPreview({ companionId, revision }: { companionId: string; revision: ArtifactRevision }) {
  const [valid, setValid] = useState<Frame | null>(null);
  const [candidate, setCandidate] = useState<Frame | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setCandidate(null);
    api.artifactPreview(companionId, revision.artifactId, revision.revisionId).then(preview => {
      if (cancelled) return;
      const document = safePreviewDocument(preview.html);
      const label = preview.revisionId === revision.revisionId ? `Published revision ${revision.revision}` : `Published at or before revision ${revision.revision}`;
      setCandidate({ revisionId: preview.revisionId, document, label });
    }).catch(() => { if (!cancelled) setError("Preview unavailable. Any last valid preview is kept below."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companionId, revision.artifactId, revision.revisionId, retry]);
  useEffect(() => {
    if (!candidate) return;
    const timeout = window.setTimeout(() => { setCandidate(null); setError("Preview could not be rendered. Any last valid preview is kept below."); }, 10_000);
    return () => window.clearTimeout(timeout);
  }, [candidate]);
  const frames = [valid, candidate?.revisionId === valid?.revisionId ? null : candidate].filter((frame): frame is Frame => frame !== null);
  // Re-reading the same persisted revision needs no new render or timeout.
  useEffect(() => { if (candidate?.revisionId === valid?.revisionId) setCandidate(null); }, [candidate, valid]);
  return <div className="artifact-preview">
    <h3>{revision.title}</h3>
    {revision.status === "failed" && <p role="status">Revision {revision.revision} failed. A previously loaded or published preview is kept when available.</p>}
    {loading && <p role="status">Loading preview…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
    {valid && <p className="workbench-caption">{valid.label} · Static preview</p>}
    <div className="artifact-preview-frames">
      {frames.map(frame => <iframe key={frame.revisionId} title={frame === valid ? "Design artifact preview" : "Preparing design preview"}
        sandbox="" referrerPolicy="no-referrer" srcDoc={frame.document}
        className={frame === valid ? "" : "preview-candidate"} aria-hidden={frame !== valid} tabIndex={frame === valid ? 0 : -1}
        onLoad={() => { if (candidate === frame) { setValid(frame); setCandidate(null); setError(""); } }}
        onError={() => { if (candidate === frame) { setCandidate(null); setError("Preview could not be rendered. Any last valid preview is kept below."); } }}/>) }
    </div>
  </div>;
}
