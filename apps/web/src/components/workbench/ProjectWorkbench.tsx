import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type CompanionDetail } from "@/api";
import { Archive, Check, ChevronDown, Folder, MessageSquare, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DesignProject } from "../../../../../packages/workbench/projects";
import { composeModules } from "../../../../../packages/workbench/profiles";
import { ModularWorkbench } from "./CompanionWorkbench";
import { ProjectContext } from "./ProjectContext";
import { useDesktopWorkbench } from "./useDesktopWorkbench";

type CreationIntent = {id:string;name:string;brief:string;submitted?:boolean};
const creationKey = (id:string) => `companions.design.creation:${id}`;
function savedCreation(id:string):CreationIntent|null { try { const value=JSON.parse(sessionStorage.getItem(creationKey(id)) ?? "null"); return value && typeof value.id === "string" && typeof value.name === "string" && typeof value.brief === "string" ? {...value,submitted:value.submitted!==false} : null; } catch { return null; } }
const selectionKey = (id: string) => `companions.design.project:${id}`;
function savedSelection(id: string): string | null { try { return sessionStorage.getItem(selectionKey(id)); } catch { return null; } }

export function ProjectWorkbench({ detail, refreshVersion, children }: { detail:CompanionDetail;refreshVersion:number;children:ReactNode }) {
  const companionId = detail.companion.id;
  const desktop = useDesktopWorkbench();
  const intent = useRef<CreationIntent | null>(savedCreation(companionId));
  const [selected, setSelected] = useState<string | null>(() => savedSelection(companionId));
  const [project, setProject] = useState<DesignProject | null>(null);
  const [projects, setProjects] = useState<DesignProject[]>([]);
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(Boolean(intent.current));
  const [listLoading, setListLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(selected));
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(Boolean(intent.current));
  const [name, setName] = useState(intent.current?.name ?? "");
  const [brief, setBrief] = useState(intent.current?.brief ?? "");
  const listGeneration = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!desktop) return;
    const generation = ++listGeneration.current;
    setListLoading(true);
    const timer = setTimeout(() => {
      api.designProjects(companionId, query).then(value => {
        if (generation !== listGeneration.current) return;
        setProjects(value.projects); setCursor(value.nextCursor); setError("");
      }).catch(() => { if (generation === listGeneration.current) setError("Projects could not be loaded. Try again."); })
        .finally(() => { if (generation === listGeneration.current) setListLoading(false); });
    }, query ? 200 : 0);
    return () => { clearTimeout(timer); listGeneration.current++; };
  }, [companionId, query, refreshVersion, reload, desktop]);
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
  useEffect(() => {
    if (!browsing || !desktop) return;
    const frame=requestAnimationFrame(()=>{(creating?nameInput.current:searchInput.current)?.focus();});
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();closeDrawer();}};
    document.addEventListener('keydown',escape);
    return ()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',escape);};
  }, [browsing,creating,desktop]);
  function rememberIntent(value:CreationIntent|null) {
    intent.current=value;
    try {if(value)sessionStorage.setItem(creationKey(companionId),JSON.stringify(value));else sessionStorage.removeItem(creationKey(companionId));} catch { /* In-memory intent still protects this page. */ }
  }
  function openProjects(element:HTMLElement) {opener.current=element;setCreating(false);setBrowsing(true);}
  function startCreate(element?:HTMLElement) {
    if(element)opener.current=element;
    const value=intent.current??{id:crypto.randomUUID(),name,brief,submitted:false};rememberIntent(value);
    setName(value.name);setBrief(value.brief);setCreating(true);setBrowsing(true);
  }
  function closeDrawer() {setBrowsing(false);requestAnimationFrame(()=>{if(opener.current?.isConnected)opener.current.focus();});}
  function select(id: string | null) {
    closeDrawer(); setSelected(id); setProject(null); setLoading(Boolean(id)); setError("");
    try { if (id) sessionStorage.setItem(selectionKey(companionId),id); else sessionStorage.removeItem(selectionKey(companionId)); } catch { /* Selection remains usable in memory. */ }
  }
  async function create() {
    if (busy || !name.trim()) return;
    setBusy(true); setError("");
    const frozen = {...(intent.current??{id:crypto.randomUUID()}),name:name.trim(),brief,submitted:true};
    rememberIntent(frozen);
    try {
      const value = await api.createDesignProject(companionId,{id:frozen.id,name:frozen.name,brief:frozen.brief});
      rememberIntent(null); setCreating(false); setName(""); setBrief(""); select(value.project.id); setProject(value.project); setLoading(false); setReload(value => value + 1);
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
  const visibleProjects = activeProject ? [activeProject,...projects.filter(item=>item.id!==activeProject.id)] : projects;
  const controls = <div className="design-project-controls">
    {error && !browsing && <div className="project-error" role="alert"><p>{error}</p><Button variant="outline" size="sm" onClick={()=>setReload(value=>value+1)}>Retry projects</Button></div>}
    <button type="button" className="design-project-switch" aria-label={`Switch project: ${activeProject?.name ?? "General conversation"}`} aria-haspopup="dialog" aria-expanded={browsing} onClick={event => openProjects(event.currentTarget)}>
      <Folder aria-hidden="true"/><span><strong>{activeProject?.name ?? (loading ? "Loading project…" : "General conversation")}</strong></span>
      {activeProject?.archived && <span className="project-archive-label">Archived</span>}<ChevronDown aria-hidden="true"/>
    </button>
    <Button variant="ghost" size="icon" aria-label="New project" title="New project" onClick={event => startCreate(event.currentTarget)}><Plus aria-hidden="true"/></Button>
    {browsing && <section className="studio-project-drawer" role="dialog" aria-label="Projects">
      <header><h2>{creating ? "New project" : "Projects"}</h2><Button variant="ghost" size="icon" aria-label="Close projects" onClick={closeDrawer}><X aria-hidden="true"/></Button></header>
      {creating ? <>
        <p className="workbench-caption">Give this idea a home. You can refine its brief as you go.</p>
        <form className="design-project-form" onSubmit={event => { event.preventDefault(); void create(); }}>
          <label>Project name<input ref={nameInput} value={name} maxLength={160} disabled={intent.current?.submitted===true} onChange={event => {const value=event.target.value;setName(value);rememberIntent({...intent.current!,name:value});}} placeholder="Summer collection" required/></label>
          <label>Brief<Textarea value={brief} maxLength={20_000} disabled={intent.current?.submitted===true} onChange={event => {const value=event.target.value;setBrief(value);rememberIntent({...intent.current!,brief:value});}} placeholder="Who is it for? What should it feel like?" rows={4}/></label>
          {error && <p role="alert">{error}</p>}
          <div className="project-dialog-footer"><Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button disabled={busy || !name.trim()} type="submit">{busy ? "Saving project…" : intent.current?.submitted ? "Retry project creation" : "Create project"}</Button></div>
        </form>
      </> : <>
        <p className="workbench-caption">Separate briefs and designs. One continuous conversation.</p>
        <div className="project-search-row"><label className="project-search"><Search aria-hidden="true"/><input ref={searchInput} aria-label="Search projects" placeholder="Search names and briefs…" maxLength={200} value={query} onChange={event => setQuery(event.target.value)}/></label><Button onClick={() => startCreate()}><Plus aria-hidden="true"/>New</Button></div>
        <div className="project-list" aria-label="Projects" aria-busy={listLoading}>
          <button type="button" className="project-list-item" aria-pressed={!selected} onClick={() => select(null)}><MessageSquare aria-hidden="true"/><span><strong>General conversation</strong><small>Talk beyond a single project</small></span>{!selected && <Check aria-hidden="true"/>}</button>
          {listLoading ? <p role="status" className="project-list-status">Loading projects…</p> : <>
            {visibleProjects.map(item => <button type="button" key={item.id} className="project-list-item" aria-label={`Open project ${item.name}`} aria-pressed={selected === item.id} onClick={() => select(item.id)}>
              {item.archived ? <Archive aria-hidden="true"/> : <Folder aria-hidden="true"/>}<span><strong>{item.name}</strong><small>{item.archived ? "Archived · " : ""}{item.brief || "No brief yet"}</small></span>{selected === item.id && <Check aria-hidden="true"/>}
            </button>)}
            {!visibleProjects.length && <p className="project-list-status">{query ? "No projects match this search." : "Your next idea can start here. Create your first project."}</p>}
          </>}
          {cursor && !listLoading && <Button variant="ghost" disabled={busy} onClick={loadMore}>Load more projects</Button>}
        </div>
        {error && <div role="alert"><p>{error}</p><Button variant="outline" size="sm" onClick={() => setReload(value => value + 1)}>Retry projects</Button></div>}
      </>}
    </section>}
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
    <p className="workbench-caption">Brief revision {project.revision} · Changes apply to your next message.</p>
    <label>Project name<input value={name} maxLength={160} onChange={event => setName(event.target.value)} required/></label>
    <label>Design brief<Textarea value={brief} maxLength={20_000} rows={9} onChange={event => setBrief(event.target.value)}/></label>
    <Button type="submit" disabled={busy || !name.trim() || !dirty}>Save brief</Button>
    {error && <div role="alert"><p>{error}</p><Button type="button" variant="outline" onClick={async () => { try { const value=await api.designProject(companionId,project.id); setName(value.project.name);setBrief(value.project.brief);setBaseline(value.project);onChange(value.project);setError(""); } catch { setError("Saved project could not be loaded. Your draft is kept."); } }}>Reload saved version</Button></div>}
    <Button type="button" variant="ghost" disabled={busy || dirty} onClick={() => void save(!project.archived)}>{project.archived ? "Restore project" : "Archive project"}</Button>
  </form>;
}
