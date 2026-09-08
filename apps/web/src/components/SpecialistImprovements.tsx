import { useCallback, useEffect, useRef, useState } from "react";
import { Lightbulb, LoaderCircle, RotateCw } from "lucide-react";
import { workspaceApi, type SpecialistImprovement } from "@/api";
import { Button } from "@/components/ui/button";
import "./SpecialistImprovements.css";

export function SpecialistImprovements({ companionId, onOpenCompanion }: { companionId: string; onOpenCompanion?: (id: string) => void }) {
  const [items, setItems] = useState<SpecialistImprovement[]>([]);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [draftCompanions, setDraftCompanions] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  const load = useCallback(async () => {
    setError("");
    try { const result = await workspaceApi.specialistImprovements(companionId); if (mounted.current) setItems(result.improvements); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not load specialist improvements."); }
  }, [companionId]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  useEffect(() => { const timer = window.setInterval(() => void load(), 8_000); return () => window.clearInterval(timer); }, [load]);

  async function act(item: SpecialistImprovement, action: "apply" | "reject") {
    if (pending) return;
    setPending(item.id); setError("");
    try {
      const result = action === "apply" ? await workspaceApi.applySpecialistImprovement(item.id) : await workspaceApi.rejectSpecialistImprovement(item.id);
      const draftCompanionId = "companionId" in result && typeof result.companionId === "string" ? result.companionId : null;
      if (mounted.current && action === "apply" && draftCompanionId) setDraftCompanions(current => ({ ...current, [item.id]: draftCompanionId }));
      await load();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not update this proposal."); }
    finally { if (mounted.current) setPending(""); }
  }

  const visible = items.filter(item => item.status === "proposed" || item.status === "unavailable" || (item.status === "applied" && draftCompanions[item.id]));
  if (!visible.length && !error) return null;
  return <section className="specialist-improvements" aria-label="Specialist improvements">{visible.map(item => <article key={item.id}><Lightbulb aria-hidden="true"/><div><strong>Suggested specialist improvement</strong><p>{item.summary}</p>{item.recipe && <details><summary>What would change</summary><pre>{item.recipe}</pre></details>}<small>Based on version {item.baseRevision}{item.status === "unavailable" ? " · source unavailable" : item.status === "applied" ? " · preparation started" : ""}</small>{item.status === "proposed" && <div><Button size="sm" disabled={Boolean(pending)} onClick={() => void act(item, "apply")}>{pending === item.id ? <LoaderCircle className="spin"/> : null}Prepare improvement</Button><Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => void act(item, "reject")}>Dismiss</Button></div>}{item.status === "applied" && draftCompanions[item.id] && <div><Button size="sm" variant="outline" onClick={() => onOpenCompanion?.(draftCompanions[item.id])}>Open draft</Button></div>}</div></article>)}{error && <div className="specialist-improvements__error"><span>{error}</span><Button size="sm" variant="ghost" onClick={() => void load()}><RotateCw/>Retry</Button></div>}</section>;
}
