import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type CompanionDetail } from "@/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DesignProject } from "../../../../../packages/workbench/projects";
import { composeModules } from "../../../../../packages/workbench/profiles";
import { ModularWorkbench } from "./CompanionWorkbench";
import { ProjectContext } from "./ProjectContext";

type CreationIntent = {id:string;name:string;brief:string};
const creationKey = (id:string) => `companions.design.creation:${id}`;
function savedCreation(id:string):CreationIntent|null { try { const value=JSON.parse(sessionStorage.getItem(creationKey(id)) ?? "null"); return value && typeof value.id === "string" && typeof value.name === "string" && typeof value.brief === "string" ? value : null; } catch { return null; } }
const selectionKey = (id: string) => `companions.design.project:${id}`;
function savedSelection(id: string): string | null { try { return sessionStorage.getItem(selectionKey(id)); } catch { return null; } }

export function ProjectWorkbench({ detail, refreshVersion, children }: { detail:CompanionDetail;refreshVersion:number;children:ReactNode }) {
  const companionId = detail.companion.id;
  const [selected, setSelected] = useState<string | null>(() => savedSelection(companionId));
  const [project, setProject] = useState<DesignProject | null>(null);
  const [projects, setProjects] = useState<DesignProject[]>([]);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(selected));
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const intent = useRef<CreationIntent | null>(savedCreation(companionId));
  const [creating, setCreating] = useState(Boolean(intent.current));
  const [name, setName] = useState(intent.current?.name ?? "");
  const [brief, setBrief] = useState(intent.current?.brief ?? "");
  const listGeneration = useRef(0);
  useEffect(() => {
    const generation = ++listGeneration.current;
    const timer = setTimeout(() => {
      api.designProjects(companionId, query).then(value => {
        if (generation !== listGeneration.current) return;
        setProjects(value.projects); setCursor(value.nextCursor); setError("");
      }).catch(() => { if (generation === listGeneration.current) setError("Projects could not be loaded. Try again."); });
    }, query ? 200 : 0);
    return () => { clearTimeout(timer); listGeneration.current++; };
  }, [companionId, query, refreshVersion, reload]);
  useEffect(() => {
    let cancelled = false;
    if (!selected) { setProject(null); setLoading(false); return; }
    setLoading(true);
    api.designProject(companionId, selected).then(value => {
      if (!cancelled) { setProject(value.project); setError(""); }
    }).catch(() => { if (!cancelled) setError("The selected project could not be loaded. Retry or choose another project."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companionId, selected, refreshVersion, reload]);
  function select(id: string | null) {
    setSelected(id); setProject(null); setLoading(Boolean(id)); setError("");
    try { if (id) sessionStorage.setItem(selectionKey(companionId),id); else sessionStorage.removeItem(selectionKey(companionId)); } catch { /* Selection remains usable in memory. */ }
  }
  async function create() {
    if (busy || !name.trim()) return;
    setBusy(true); setError("");
    const input = intent.current ?? {id:crypto.randomUUID(),name:name.trim(),brief};
    intent.current = input;
    try { sessionStorage.setItem(creationKey(companionId),JSON.stringify(input)); } catch { /* In-memory intent still protects this page. */ }
    try {
      const value = await api.createDesignProject(companionId,input);
      try {sessionStorage.removeItem(creationKey(companionId));} catch { /* Saved success is still reflected below. */ }
      intent.current = null; setCreating(false); setName(""); setBrief(""); select(value.project.id); setProject(value.project); setLoading(false); setReload(value => value + 1);
    } catch { setError("Project creation could not be confirmed. Retry to check the same request."); }
    finally { setBusy(false); }
  }
  async function loadMore() {
    if (!cursor || busy) return;
    const generation = listGeneration.current;
    setBusy(true);
    try {
      const value = await api.designProjects(companionId, query, cursor);
      if (generation === listGeneration.current) { setProjects(current => [...new Map([...current,...value.projects].map(project => [project.id,project])).values()]); setCursor(value.nextCursor); }
    } catch { setError("More projects could not be loaded. Try again."); }
    finally { setBusy(false); }
  }
  const activeProject = project?.id === selected ? project : null;
  const choices = activeProject && !projects.some(item => item.id === activeProject.id) ? [activeProject,...projects] : projects;
  const controls = <div className="design-project-controls">
    <div className="design-project-title"><strong>Projects</strong><Button variant="outline" size="sm" onClick={() => setCreating(value => !value)}>{creating ? "Close" : "New project"}</Button></div>
    <p>One conversation, separate briefs and designs.</p>
    <input aria-label="Search projects" placeholder="Find a project…" value={query} onChange={event => setQuery(event.target.value)}/>
    <label htmlFor={`project-${companionId}`}>Current project</label>
    <select id={`project-${companionId}`} value={selected ?? ""} onChange={event => select(event.target.value || null)}>
      <option value="">General conversation</option>
      {selected && !choices.some(item => item.id === selected) && <option value={selected}>Selected project — loading</option>}
      {choices.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? " (archived)" : ""}</option>)}
    </select>
    {cursor && <Button variant="ghost" disabled={busy} onClick={loadMore}>Load more projects</Button>}
    {creating && <form className="design-project-form" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label>Project name<input value={name} maxLength={160} disabled={Boolean(intent.current)} onChange={event => setName(event.target.value)} placeholder="Summer collection" required/></label>
      <label>Brief<Textarea value={brief} maxLength={20_000} disabled={Boolean(intent.current)} onChange={event => setBrief(event.target.value)} placeholder="Audience, goal, style and constraints" rows={4}/></label>
      <Button disabled={busy || !name.trim()} type="submit">{busy ? "Saving project…" : intent.current ? "Retry project creation" : "Create project"}</Button>
    </form>}
    {error && <div role="alert"><p>{error}</p><Button variant="outline" size="sm" onClick={() => setReload(value => value + 1)}>Retry projects</Button></div>}
  </div>;
  return <ProjectContext.Provider value={{project:activeProject,loading:loading || Boolean(selected && !activeProject)}}>
    <ModularWorkbench detail={detail} refreshVersion={refreshVersion} modules={composeModules(detail.companion.profileId).filter(module => module.placement === "side")} projectMode project={activeProject} projectControls={controls} onProjectChange={value => { setProject(value); setReload(current => current + 1); }}>{children}</ModularWorkbench>
  </ProjectContext.Provider>;
}

export function ProjectBrief({ companionId, project, onChange }: {companionId:string;project:DesignProject;onChange:(project:DesignProject)=>void}) {
  const [name,setName] = useState(project.name), [brief,setBrief] = useState(project.brief);
  const [busy,setBusy] = useState(false), [error,setError] = useState("");
  const [baseline,setBaseline] = useState(project);
  const version=baseline.revision;
  const dirty = name !== baseline.name || brief !== baseline.brief;
  useEffect(() => { if (!dirty) { setName(project.name); setBrief(project.brief); setBaseline(project); } }, [project.revision]);
  async function save(archived?:boolean) {
    setBusy(true); setError("");
    try {
      const value = await api.updateDesignProject(companionId,project.id,{expectedRevision:version,name:name.trim(),brief,...(archived===undefined?{}:{archived})});
      setName(value.project.name); setBrief(value.project.brief); setBaseline(value.project); onChange(value.project);
    } catch { setError("This brief could not be saved. Your draft is kept. Reload the saved version if another edit changed it."); }
    finally { setBusy(false); }
  }
  return <form className="design-project-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    <p className="workbench-caption">Brief revision {project.revision}. Accepted requests keep the brief they started with.</p>
    <label>Project name<input value={name} maxLength={160} onChange={event => setName(event.target.value)} required/></label>
    <label>Design brief<Textarea value={brief} maxLength={20_000} rows={9} onChange={event => setBrief(event.target.value)}/></label>
    <Button type="submit" disabled={busy || !name.trim() || !dirty}>Save brief</Button>
    {error && <div role="alert"><p>{error}</p><Button type="button" variant="outline" onClick={async () => { try { const value=await api.designProject(companionId,project.id); setName(value.project.name);setBrief(value.project.brief);setBaseline(value.project);onChange(value.project);setError(""); } catch { setError("Saved project could not be loaded. Your draft is kept."); } }}>Reload saved version</Button></div>}
    <Button type="button" variant="ghost" disabled={busy || dirty} onClick={() => void save(!project.archived)}>{project.archived ? "Restore project" : "Archive project"}</Button>
  </form>;
}
