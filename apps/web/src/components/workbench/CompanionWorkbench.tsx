import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import { api, type CompanionDetail } from "@/api";
import { composeModules, resolveProfile, type ModuleId } from "../../../../../packages/workbench/profiles";
import { parseWorkbenchEvent, type AnyArtifactRevision as ArtifactRevision, type AnyWorkbenchEvent as WorkbenchEvent, type WorkbenchSnapshot } from "../../../../../packages/workbench/artifacts";
import { ArtifactPreview } from "./ArtifactPreview";
import "./Workbench.css";
import type { DesignProject } from "../../../../../packages/workbench/projects";
import { ProjectWorkbench, ProjectBrief } from "./ProjectWorkbench";

type ModuleProps = { project?: DesignProject | null; projectMode?: boolean; onProjectChange?: (project:DesignProject)=>void; detail: CompanionDetail; revisions: ArtifactRevision[]; selected: string | null; onSelect: (id: string) => void };
function PreviewModule({ detail, revisions, selected, onSelect, projectMode, project }: ModuleProps) {
  const revision = revisions.find(item => item.revisionId === selected) ?? revisions[0];
  const designs = [...new Map([...revisions].reverse().map(item => [item.artifactId,item])).values()];
  return revision ? <>{projectMode && <label className="design-picker">Design<select value={revision.artifactId} onChange={event => { const chosen=designs.find(item=>item.artifactId===event.target.value);if(chosen)onSelect(chosen.revisionId); }}>{designs.map(item=><option key={item.artifactId} value={item.artifactId}>{item.title}</option>)}</select></label>}<ArtifactPreview key={revision.artifactId} companionId={detail.companion.id} revision={revision}/></> : <div className="workbench-empty"><h3>A place to see your design</h3><p>{projectMode ? (project ? "Describe your design in chat. Published revisions will appear here for this project." : "Create or select a project to start a design. Your conversation stays here.") : "Published designs will appear here. Artifact publishing is not connected yet; you can work with files in chat."}</p></div>;
}
function HistoryModule({ revisions, onSelect }: ModuleProps) {
  return revisions.length ? <ol className="artifact-history">{revisions.map(revision => <li key={revision.revisionId}>
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
  const [active, setActive] = useState<Exclude<ModuleId, "chat">>(modules[0].id as Exclude<ModuleId, "chat">);
  const [visible, setVisible] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{projectId:string|null;snapshot:WorkbenchSnapshot} | null>(null);
  const projectId = project?.id ?? null;
  const snapshot = loaded?.projectId === projectId ? loaded.snapshot : null;
  const [moreBusy,setMoreBusy] = useState(false);
  const requestScope = useRef(projectId); requestScope.current=projectId;
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const seenEvents = useRef<Set<string> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let cancelled = false;
    if (projectMode && !project) { setLoaded(null); return; }
    api.workbench(detail.companion.id, projectId ?? undefined).then(value => {
      if (cancelled) return;
      setLoaded({projectId,snapshot:value}); setError(false);
      const parsed = value.events.map(parseWorkbenchEvent).filter((event): event is WorkbenchEvent => event !== null && event.provenance.companionId === detail.companion.id && event.provenance.profileId === detail.companion.profileId);
      const newEvents = seenEvents.current ? parsed.filter(event => !seenEvents.current!.has(event.id)) : [];
      seenEvents.current = new Set(parsed.map(event => event.id));
      const open = newEvents.filter(event => event.type === "workbench.open" && modules.some(module => module.id === event.moduleId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
      if (open?.type === "workbench.open") { setActive(open.moduleId); setVisible(true); if (open.artifactId) setSelected(value.revisions.find(revision => revision.artifactId === open.artifactId)?.revisionId ?? null); requestAnimationFrame(() => heading.current?.focus()); }
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [detail.companion.id, detail.companion.profileId, refreshVersion, retry, projectId]);
  useEffect(() => { setSelected(null); setError(false); seenEvents.current=null; }, [projectId]);
  async function moreHistory() {
    if (!snapshot?.nextCursor || moreBusy) return;
    const scope=projectId;setMoreBusy(true);
    try { const value=await api.workbench(detail.companion.id,projectId ?? undefined,snapshot.nextCursor); if(requestScope.current===scope)setLoaded({projectId:scope,snapshot:{...value,revisions:[...new Map([...snapshot.revisions,...value.revisions].map(item=>[item.revisionId,item])).values()]}}); } catch { if(requestScope.current===scope)setError(true); } finally {setMoreBusy(false);}
  }
  const Module = sideModuleComponents[active];
  return <div className={`companion-workbench${visible ? "" : " workbench-collapsed"}`}>
    <div className="workbench-chat">{children}</div>
    <aside className="workbench-side" aria-label="Companion workbench">
      <div className="workbench-toolbar"><span>{resolveProfile(detail.companion.profileId).title} workbench</span><button type="button" aria-expanded={visible} aria-controls="workbench-panel" onClick={() => setVisible(value => !value)}>{visible ? "Hide" : "Open workbench"}</button></div>
      <div id="workbench-panel" hidden={!visible}>
        {projectControls}
        <nav className="workbench-modules" aria-label="Workbench modules">{modules.map(module => <button key={module.id} type="button" aria-pressed={active === module.id} onClick={() => setActive(module.id as Exclude<ModuleId, "chat">)}>{module.title}</button>)}</nav>
        <section className="workbench-content" aria-labelledby="workbench-module-title">
          <h2 id="workbench-module-title" ref={heading} tabIndex={-1}>{modules.find(module => module.id === active)?.title}</h2>
          {error && <div role="alert"><p>Workbench could not be refreshed. Previously loaded content is kept.</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry workbench</button></div>}
          {!snapshot && !error && (!projectMode || project) && <p role="status">Loading workbench…</p>}
          {(snapshot || projectMode || active === "assets" || active === "design-brief") && <Module projectMode={projectMode} project={project} onProjectChange={onProjectChange} detail={detail} revisions={snapshot?.revisions ?? []} selected={selected} onSelect={id => { setSelected(id); setActive("artifact-preview"); }}/>}
          {snapshot?.hasMore && active === "artifact-history" && (snapshot.nextCursor ? <button type="button" disabled={moreBusy} onClick={moreHistory}>Load older revisions</button> : <p>Showing the latest 100 revisions.</p>)}
        </section>
      </div>
    </aside>
  </div>;
}
