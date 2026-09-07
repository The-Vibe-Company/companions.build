import { useCallback, useEffect, useRef, useState } from "react";
import { Lightbulb, LoaderCircle, RotateCw } from "lucide-react";
import { workspaceApi, type SpecialistImprovement } from "@/api";
import { Button } from "@/components/ui/button";
import "./SpecialistImprovements.css";

export function SpecialistImprovements({ companionId }: { companionId: string }) {
  const [items, setItems] = useState<SpecialistImprovement[]>([]);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const load = useCallback(async () => {
    setError("");
    try { const result = await workspaceApi.specialistImprovements(companionId); if (mounted.current) setItems(result.improvements); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not load specialist improvements."); }
  }, [companionId]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);

  async function act(item: SpecialistImprovement, action: "apply" | "reject") {
    if (pending) return;
    setPending(item.id); setError("");
    try {
      const result = action === "apply" ? await workspaceApi.applySpecialistImprovement(item.id) : await workspaceApi.rejectSpecialistImprovement(item.id);
      if (mounted.current) setItems(current => current.map(value => value.id === result.improvement.id ? result.improvement : value));
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not update this proposal."); }
    finally { if (mounted.current) setPending(""); }
  }

  const visible = items.filter(item => item.status === "pending" || item.status === "unavailable");
  if (!visible.length && !error) return null;
  return <section className="specialist-improvements" aria-label="Specialist improvements">{visible.map(item => <article key={item.id}><Lightbulb aria-hidden="true"/><div><strong>Suggested specialist improvement</strong><p>{item.summary}</p>{item.recipe && <details><summary>What would change</summary><pre>{item.recipe}</pre></details>}<small>Based on version {item.baseRevision}{item.status === "unavailable" ? " · source unavailable" : ""}</small>{item.status === "pending" && <div><Button size="sm" disabled={Boolean(pending)} onClick={() => void act(item, "apply")}>{pending === item.id ? <LoaderCircle className="spin"/> : null}Prepare improvement</Button><Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => void act(item, "reject")}>Dismiss</Button></div>}</div></article>)}{error && <div className="specialist-improvements__error"><span>{error}</span><Button size="sm" variant="ghost" onClick={() => void load()}><RotateCw/>Retry</Button></div>}</section>;
}
