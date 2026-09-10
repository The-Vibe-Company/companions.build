import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import { api, type CompanionDetail } from "@/api";
import { composeModules, resolveProfile, type ModuleId } from "../../../../../packages/workbench/profiles";
import { parseWorkbenchEvent, type ArtifactRevision, type WorkbenchEvent, type WorkbenchSnapshot } from "../../../../../packages/workbench/artifacts";
import { ArtifactPreview } from "./ArtifactPreview";
import "./Workbench.css";

type ModuleProps = { detail: CompanionDetail; revisions: ArtifactRevision[]; selected: string | null; onSelect: (id: string) => void };
function PreviewModule({ detail, revisions, selected }: ModuleProps) {
  const revision = revisions.find(item => item.revisionId === selected) ?? revisions[0];
  return revision ? <ArtifactPreview key={revision.artifactId} companionId={detail.companion.id} revision={revision}/> : <div className="workbench-empty"><h3>A place to see your design</h3><p>Published designs will appear here. Artifact publishing is not connected yet; you can work with files in chat.</p></div>;
}
function HistoryModule({ revisions, onSelect }: ModuleProps) {
  return revisions.length ? <ol className="artifact-history">{revisions.map(revision => <li key={revision.revisionId}>
    <button type="button" onClick={() => onSelect(revision.revisionId)}><strong>{revision.title}</strong><span>Revision {revision.revision} · {revision.status === "ready" ? "Published" : "Failed"}</span></button>
    <time dateTime={revision.createdAt}>{new Date(revision.createdAt).toLocaleString()}</time>
    <details><summary>Provenance</summary><dl><dt>Run</dt><dd>{revision.provenance.runId}</dd><dt>Conversation</dt><dd>{revision.provenance.conversation.kind} · {revision.provenance.conversation.id}</dd><dt>Skill</dt><dd>{revision.provenance.skill.id}@{revision.provenance.skill.version}</dd><dt>Profile</dt><dd>{revision.provenance.profileId}</dd><dt>Workspace file</dt><dd>{revision.source.workspacePath}</dd><dt>Revision ID</dt><dd>{revision.revisionId}</dd></dl></details>
  </li>)}</ol> : <div className="workbench-empty"><h3>No published revisions yet</h3><p>History will retain each published revision and failed attempt with its source run.</p></div>;
}
function AssetsModule({ detail }: ModuleProps) {
  const files = [...new Map([...(detail.files ?? []), ...(detail.chat?.files ?? [])].map(file => [file.id, file])).values()];
  return <><p className="workbench-caption">Files from the loaded conversation. Share files through chat to add context.</p>{files.length ? <ul className="workbench-assets">{files.map(file => <li key={file.id}><a href={file.url} target="_blank" rel="noreferrer">{file.name}</a><span>{file.kind === "user_upload" ? "Shared by you" : "Companion output"}</span></li>)}</ul> : <p>No files in this conversation view.</p>}</>;
}
function BriefModule({ detail }: ModuleProps) {
  return <><p className="workbench-caption">The Companion’s saved role is the initial design brief. Edit it in Settings.</p><div className="design-brief-text">{detail.companion.instructions || "No brief has been saved yet."}</div></>;
}

/** The host owns components; profile/agent data can only select a registered module ID. */
const sideModuleComponents: Record<Exclude<ModuleId, "chat">, ComponentType<ModuleProps>> = {
  "artifact-preview": PreviewModule, "artifact-history": HistoryModule, assets: AssetsModule, "design-brief": BriefModule,
};

export function CompanionWorkbench({ detail, refreshVersion, children }: { detail: CompanionDetail; refreshVersion: number; children: ReactNode }) {
  const modules = composeModules(detail.companion.profileId).filter(module => module.placement === "side");
  // Preserve the existing default chat layout and avoid a new data request for legacy Companions.
  return modules.length ? <ModularWorkbench key={detail.companion.id} detail={detail} refreshVersion={refreshVersion} modules={modules}>{children}</ModularWorkbench> : <>{children}</>;
}
function ModularWorkbench({ detail, refreshVersion, modules, children }: { detail: CompanionDetail; refreshVersion: number; modules: ReturnType<typeof composeModules>; children: ReactNode }) {
  const [active, setActive] = useState<Exclude<ModuleId, "chat">>(modules[0].id as Exclude<ModuleId, "chat">);
  const [visible, setVisible] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const seenEvents = useRef<Set<string> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let cancelled = false;
    api.workbench(detail.companion.id).then(value => {
      if (cancelled) return;
      setSnapshot(value); setError(false);
      const parsed = value.events.map(parseWorkbenchEvent).filter((event): event is WorkbenchEvent => event !== null && event.provenance.companionId === detail.companion.id && event.provenance.profileId === detail.companion.profileId);
      const newEvents = seenEvents.current ? parsed.filter(event => !seenEvents.current!.has(event.id)) : [];
      seenEvents.current = new Set(parsed.map(event => event.id));
      const open = newEvents.filter(event => event.type === "workbench.open" && modules.some(module => module.id === event.moduleId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
      if (open?.type === "workbench.open") { setActive(open.moduleId); setVisible(true); if (open.artifactId) setSelected(value.revisions.find(revision => revision.artifactId === open.artifactId)?.revisionId ?? null); requestAnimationFrame(() => heading.current?.focus()); }
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [detail.companion.id, detail.companion.profileId, refreshVersion, retry]);
  const Module = sideModuleComponents[active];
  return <div className={`companion-workbench${visible ? "" : " workbench-collapsed"}`}>
    <div className="workbench-chat">{children}</div>
    <aside className="workbench-side" aria-label="Companion workbench">
      <div className="workbench-toolbar"><span>{resolveProfile(detail.companion.profileId).title} workbench</span><button type="button" aria-expanded={visible} aria-controls="workbench-panel" onClick={() => setVisible(value => !value)}>{visible ? "Hide" : "Open workbench"}</button></div>
      <div id="workbench-panel" hidden={!visible}>
        <nav className="workbench-modules" aria-label="Workbench modules">{modules.map(module => <button key={module.id} type="button" aria-pressed={active === module.id} onClick={() => setActive(module.id as Exclude<ModuleId, "chat">)}>{module.title}</button>)}</nav>
        <section className="workbench-content" aria-labelledby="workbench-module-title">
          <h2 id="workbench-module-title" ref={heading} tabIndex={-1}>{modules.find(module => module.id === active)?.title}</h2>
          {error && <div role="alert"><p>Workbench could not be refreshed. Previously loaded content is kept.</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry workbench</button></div>}
          {!snapshot && !error && <p role="status">Loading workbench…</p>}
          {(snapshot || active === "assets" || active === "design-brief") && <Module detail={detail} revisions={snapshot?.revisions ?? []} selected={selected} onSelect={id => { setSelected(id); setActive("artifact-preview"); }}/>}
          {snapshot?.hasMore && active === "artifact-history" && <p>Showing the latest 100 revisions.</p>}
        </section>
      </div>
    </aside>
  </div>;
}
