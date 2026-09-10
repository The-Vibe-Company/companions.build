import { type ComponentType, type ReactNode, useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, Monitor, PanelRight } from "lucide-react";
import { api, type CompanionDetail } from "@/api";
import { composeModules, resolveProfile, type ModuleId } from "../../../../../packages/workbench/profiles";
import { parseWorkbenchEvent, type AnyArtifactRevision as ArtifactRevision, type AnyWorkbenchEvent as WorkbenchEvent, type WorkbenchSnapshot } from "../../../../../packages/workbench/artifacts";
import { ArtifactPreview } from "./ArtifactPreview";
import "./Workbench.css";
import { useDesktopWorkbench } from "./useDesktopWorkbench";
import type { DesignProject } from "../../../../../packages/workbench/projects";
import { ProjectWorkbench, ProjectBrief } from "./ProjectWorkbench";

type ModuleProps = { project?: DesignProject | null; projectMode?: boolean; onProjectChange?: (project:DesignProject)=>void; detail: CompanionDetail; revisions: ArtifactRevision[]; selected: string | null; onSelect: (id: string) => void; stageActions?: ReactNode; historyHasMore?: boolean; historyBusy?: boolean; onMoreHistory?: () => void };
function PreviewModule({ detail, revisions, selected, onSelect, projectMode, project, stageActions, historyHasMore, historyBusy, onMoreHistory }: ModuleProps) {
  const revision = revisions.find(item => item.revisionId === selected) ?? revisions[0];
  const designs = [...new Map([...revisions].reverse().map(item => [item.artifactId,item])).values()];
  const history = revision ? revisions.filter(item => item.artifactId === revision.artifactId).sort((a,b) => a.revision-b.revision) : [];
  const latest = history.at(-1);
  return revision ? <ArtifactPreview key={revision.artifactId} companionId={detail.companion.id} revision={revision} actions={stageActions}
    navigation={projectMode ? <div className="studio-design-navigation"><span className="studio-project-label" title={project?.name}>{project?.name}</span><nav className="studio-design-tabs" aria-label="Designs">{designs.map(item => <button type="button" key={item.artifactId} title={item.title} aria-pressed={item.artifactId===revision.artifactId} onClick={()=>onSelect(item.revisionId)}>{item.title}</button>)}</nav></div> : undefined}
    footer={<div className="studio-revision-bar"><nav className="studio-revision-strip" aria-label="Design revisions">{history.map(item => <button type="button" key={item.revisionId} title={`Revision ${item.revision} · ${item.status} · ${new Date(item.createdAt).toLocaleString()}`} aria-label={`View revision ${item.revision}${item.status==='failed'?' (failed)':''}`} aria-pressed={item.revisionId===revision.revisionId} className={item.status==='failed'?'revision-failed':''} onClick={()=>onSelect(item.revisionId)}><span>{item.revision}</span></button>)}</nav>{latest && latest.revisionId!==revision.revisionId && <button type="button" className="studio-latest" onClick={()=>onSelect(latest.revisionId)}>Back to latest</button>}{historyHasMore && <button type="button" disabled={historyBusy} className="studio-more" onClick={onMoreHistory}>Load older designs and revisions</button>}</div>}/>
    : <><div className="studio-empty-toolbar"><span>{project?.name ?? "Design studio"}</span>{stageActions}</div><div className="workbench-empty"><Monitor className="workbench-empty-icon" aria-hidden="true"/><h3>A place to see your design</h3><p>{projectMode ? (project ? "Describe your design in chat. Published revisions will appear here for this project." : "Create or select a project to start a design. Your conversation stays here.") : "Published designs will appear here. Artifact publishing is not connected yet; you can work with files in chat."}</p></div></>;
}
function HistoryModule({ revisions, onSelect, selected }: ModuleProps) {
  return revisions.length ? <ol className="artifact-history">{revisions.map(revision => <li key={revision.revisionId} data-selected={selected===revision.revisionId}>
    <button type="button" onClick={() => onSelect(revision.revisionId)}><strong>{revision.title}</strong><span>Revision {revision.revision} · {revision.status === "ready" ? "Published" : "Failed"}</span></button>
    <time dateTime={revision.createdAt}>{new Date(revision.createdAt).toLocaleString()}</time>
    <details><summary>Provenance</summary><dl><dt>Run</dt><dd>{revision.provenance.runId}</dd><dt>Conversation</dt><dd>{revision.provenance.conversation.kind} · {revision.provenance.conversation.id}</dd><dt>Skill</dt><dd>{revision.provenance.skill.id}@{revision.provenance.skill.version}</dd><dt>Profile</dt><dd>{revision.provenance.profileId}</dd><dt>Workspace file</dt><dd>{revision.source.workspacePath}</dd><dt>Revision ID</dt><dd>{revision.revisionId}</dd></dl></details>
  </li>)}</ol> : <div className="workbench-empty"><h3>No published revisions yet</h3><p>History will retain each published revision and failed attempt with its source run.</p></div>;
}
function AssetsModule({ detail, project, projectMode }: ModuleProps) {
  const projectRuns = new Set(detail.runs.filter(run => (run as unknown as {projectId?:string}).projectId === project?.id).map(run => run.id));
  const files = [...new Map([...(detail.files ?? []), ...(detail.chat?.files ?? [])].filter(file => !projectMode || (project && projectRuns.has(file.runId))).map(file => [file.id, file])).values()];
  return <><p className="workbench-caption">{projectMode ? "Attachments from this project in the loaded conversation. Share files while this project is selected." : "Files from the loaded conversation. Share files through chat to add context."}</p>{files.length ? <ul className="workbench-assets">{files.map(file => <li key={file.id}><a href={file.url} target="_blank" rel="noreferrer">{file.name}</a><span>{file.kind === "user_upload" ? "Shared by you" : "Companion output"}</span></li>)}</ul> : <p>No files in this conversation view.</p>}</>;
}
function BriefModule({ detail, projectMode, project, onProjectChange }: ModuleProps) {
  if (projectMode) return project ? <ProjectBrief key={project.id} companionId={detail.companion.id} project={project} onChange={onProjectChange!}/> : <p>Create or select a project to save its brief.</p>;
  return <><p className="workbench-caption">The Companion’s saved role is the initial design brief. Edit it in Settings.</p><div className="design-brief-text">{detail.companion.instructions || "No brief has been saved yet."}</div></>;
}

/** The host owns components; profile/agent data can only select a registered module ID. */
const sideModuleComponents: Record<Exclude<ModuleId, "chat">, ComponentType<ModuleProps>> = {
  "artifact-preview": PreviewModule, "artifact-history": HistoryModule, assets: AssetsModule, "design-brief": BriefModule,
};

export function CompanionWorkbench({ detail, refreshVersion, children }: { detail: CompanionDetail; refreshVersion: number; children: ReactNode }) {
  if (resolveProfile(detail.companion.profileId).capabilities.includes("design-projects")) return <ProjectWorkbench key={detail.companion.id} detail={detail} refreshVersion={refreshVersion}>{children}</ProjectWorkbench>;
  const modules = composeModules(detail.companion.profileId).filter(module => module.placement === "side");
  // Preserve the existing default chat layout and avoid a new data request for legacy Companions.
  return modules.length ? <ModularWorkbench key={detail.companion.id} detail={detail} refreshVersion={refreshVersion} modules={modules}>{children}</ModularWorkbench> : <>{children}</>;
}
export function ModularWorkbench({ detail, refreshVersion, modules, children, projectMode = false, project, projectControls, onProjectChange }: { projectMode?:boolean; project?:DesignProject|null; projectControls?:ReactNode; onProjectChange?:(project:DesignProject)=>void; detail: CompanionDetail; refreshVersion: number; modules: ReturnType<typeof composeModules>; children: ReactNode }) {
  const desktop = useDesktopWorkbench();
  const inspectorModules = modules.filter(module => module.region === "inspector").sort((a,b)=>(a.order??0)-(b.order??0));
  const stageModule = modules.find(module => module.region === "stage");
  const [active, setActive] = useState<Exclude<ModuleId, "chat">>(inspectorModules[0]?.id as Exclude<ModuleId, "chat">);
  const [visible, setVisible] = useState(() => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.innerWidth >= 1280);
  const [chatWidth, setChatWidth] = useState(360);
  const [resizing, setResizing] = useState(false);
  const [maxChatWidth, setMaxChatWidth] = useState(560);
  const layout = useRef<HTMLDivElement>(null);
  const drag = useRef<{x:number;width:number}|null>(null);
  useEffect(() => {
    if (!desktop) { drag.current=null; setResizing(false); }
    if (!desktop || !layout.current) return;
    const observer = new ResizeObserver(() => {
      const max = Math.min(560, Math.max(280, layout.current!.clientWidth*.38));
      setMaxChatWidth(max); setChatWidth(width => Math.min(width,max));
    });
    observer.observe(layout.current);
    return () => observer.disconnect();
  }, [desktop]);
  const [selection, setSelection] = useState<{projectId:string|null;revision:ArtifactRevision} | null>(null);
  const [loaded, setLoaded] = useState<{projectId:string|null;snapshot:WorkbenchSnapshot} | null>(null);
  const projectId = project?.id ?? null;
  const selectedRevision = selection?.projectId === projectId ? selection.revision : null;
  const selected = selectedRevision?.revisionId ?? null;
  function selectRevision(revision: ArtifactRevision | null) { setSelection(revision ? {projectId, revision} : null); }
  const snapshot = loaded?.projectId === projectId ? loaded.snapshot : null;
  const [moreBusy,setMoreBusy] = useState(false);
  const requestScope = useRef(projectId); requestScope.current=projectId;
  const historyGeneration = useRef(0);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const seenEvents = useRef<Set<string> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let cancelled = false;
    historyGeneration.current++;
    if (!desktop) return;
    if (projectMode && !project) { setLoaded(null); return; }
    api.workbench(detail.companion.id, projectId ?? undefined).then(value => {
      if (cancelled) return;
      setLoaded({projectId,snapshot:value}); setError(false);
      const parsed = value.events.map(parseWorkbenchEvent).filter((event): event is WorkbenchEvent => event !== null && event.provenance.companionId === detail.companion.id && event.provenance.profileId === detail.companion.profileId);
      const newEvents = seenEvents.current ? parsed.filter(event => !seenEvents.current!.has(event.id)) : [];
      seenEvents.current = new Set(parsed.map(event => event.id));
      const open = newEvents.filter(event => event.type === "workbench.open" && modules.some(module => module.id === event.moduleId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
      if (open?.type === "workbench.open") { if (inspectorModules.some(module=>module.id===open.moduleId)) { setActive(open.moduleId); setVisible(true); } if (open.artifactId) selectRevision(value.revisions.find(revision => revision.artifactId === open.artifactId) ?? null); requestAnimationFrame(() => heading.current?.focus()); }
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [detail.companion.id, detail.companion.profileId, refreshVersion, retry, projectId, desktop]);
  useEffect(() => { selectRevision(null); setError(false); seenEvents.current=null; }, [projectId]);
  async function moreHistory() {
    if (!snapshot?.nextCursor || moreBusy) return;
    const scope=projectId, generation=historyGeneration.current;setMoreBusy(true);
    try { const value=await api.workbench(detail.companion.id,projectId ?? undefined,snapshot.nextCursor); if(requestScope.current===scope && generation===historyGeneration.current)setLoaded({projectId:scope,snapshot:{...value,revisions:[...new Map([...snapshot.revisions,...value.revisions].map(item=>[item.revisionId,item])).values()]}}); } catch { if(requestScope.current===scope && generation===historyGeneration.current)setError(true); } finally {setMoreBusy(false);}
  }
  const revisions = snapshot?.revisions ?? [];
  // Browsing an older revision survives invalidations of the latest history page.
  const previewRevisions = selectedRevision && !revisions.some(item => item.revisionId === selectedRevision.revisionId)
    ? [...revisions, selectedRevision] : revisions;
  const currentRevision = previewRevisions.find(item => item.revisionId === selected) ?? previewRevisions[0];
  const designs = [...new Map([...revisions].reverse().map(item => [item.artifactId,item])).values()];
  const Stage = stageModule ? sideModuleComponents[stageModule.id as Exclude<ModuleId,"chat">] : null;
  const stageActions = inspectorModules.length ? <button type="button" className="studio-inspector-toggle" aria-label={visible ? "Hide inspector" : "Show inspector"} title="Brief, assets and history" aria-expanded={visible} onClick={()=>setVisible(value=>!value)}><PanelRight aria-hidden="true"/></button> : null;
  function chooseRevision(id:string) { selectRevision(previewRevisions.find(item=>item.revisionId===id)??null); }
  function resizeChat(width:number) { setChatWidth(Math.min(maxChatWidth, Math.max(280, width))); }
  const common = {projectMode,project,onProjectChange,detail,selected:currentRevision?.revisionId??null,onSelect:chooseRevision};
  return <div ref={layout} className={`companion-workbench studio-workbench${visible ? "" : " studio-inspector-closed"}`} data-desktop={desktop} data-resizing={resizing} data-has-stage={Boolean(Stage)} style={{"--studio-chat-width":`${chatWidth}px`} as CSSProperties}>
    <div className="workbench-chat">
      {desktop && <header className="studio-chat-header"><span className="studio-chat-name">{detail.companion.name}</span>{projectControls}</header>}
      {children}
      {desktop && <div className="studio-resizer" role="separator" aria-label="Resize conversation" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={Math.round(maxChatWidth)} aria-valuenow={Math.round(chatWidth)} tabIndex={0}
        onPointerDown={event=>{drag.current={x:event.clientX,width:layout.current?.querySelector('.workbench-chat')?.getBoundingClientRect().width??chatWidth};setResizing(true);event.currentTarget.setPointerCapture(event.pointerId);}}
        onPointerMove={event=>{if(drag.current)resizeChat(drag.current.width+event.clientX-drag.current.x);}}
        onPointerUp={event=>{drag.current=null;setResizing(false);event.currentTarget.releasePointerCapture(event.pointerId);}}
        onPointerCancel={()=>{drag.current=null;setResizing(false);}}
        onLostPointerCapture={()=>{drag.current=null;setResizing(false);}}
        onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();resizeChat(event.key==='Home'?280:event.key==='End'?560:chatWidth+(event.key==='ArrowLeft'?-24:24));}}}/>}
    </div>
    {desktop && <>
      {Stage && <section className="studio-stage" aria-label="Design stage">
        {error && <div className="workbench-error" role="alert"><p>Workbench could not be refreshed. Previously loaded content is kept.</p><button type="button" onClick={()=>setRetry(value=>value+1)}>Retry workbench</button></div>}
        {!snapshot && !error && (!projectMode || project) && <p className="preview-status" role="status">Loading workbench…</p>}
        <Stage {...common} revisions={previewRevisions} stageActions={stageActions} historyHasMore={Boolean(snapshot?.nextCursor)} historyBusy={moreBusy} onMoreHistory={moreHistory}/>
      </section>}
      <aside className="workbench-side studio-inspector" aria-label="Companion workbench" hidden={!visible}>
        <header className="studio-inspector-header"><nav className="workbench-modules" aria-label="Workbench modules">{inspectorModules.map(module => <button key={module.id} type="button" aria-label={module.title} aria-pressed={active===module.id} onClick={()=>setActive(module.id as Exclude<ModuleId,"chat">)}>{module.shortTitle??module.title}</button>)}</nav><button type="button" aria-label="Close inspector" title="Close inspector" onClick={()=>setVisible(false)}><ChevronRight aria-hidden="true"/></button></header>
        <div className="workbench-content">
          <h2 ref={heading} tabIndex={-1} className="studio-sr-only">{inspectorModules.find(module=>module.id===active)?.title}</h2>
          {inspectorModules.map(module=>{
            const Module=sideModuleComponents[module.id as Exclude<ModuleId,"chat">];
            const scopedRevisions=module.id==='artifact-history' && currentRevision ? revisions.filter(item=>item.artifactId===currentRevision.artifactId) : revisions;
            return <div key={module.id} hidden={active!==module.id}>
              <Module {...common} revisions={scopedRevisions}/>
              {module.id==='design-brief' && project && designs.length>0 && <section className="studio-project-designs"><h3>Designs in this project</h3>{designs.map(item=><button type="button" key={item.artifactId} aria-pressed={item.artifactId===currentRevision?.artifactId} onClick={()=>chooseRevision(item.revisionId)}><Monitor aria-hidden="true"/><span>{item.title}</span><small>r{item.revision}</small></button>)}</section>}
              {module.id==='artifact-history' && snapshot?.nextCursor && <button className="workbench-load-more" type="button" disabled={moreBusy} onClick={moreHistory}>Load older revisions</button>}
            </div>;
          })}
        </div>
      </aside>
    </>}
  </div>;
}
