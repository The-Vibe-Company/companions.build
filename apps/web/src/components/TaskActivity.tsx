import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, CircleAlert, CircleStop, FileText, LoaderCircle, MessageCircle } from "lucide-react";
import { api, type Companion, type CompanionDetail, type TaskDetail, type TaskSummary } from "@/api";
import { MessageResponse } from "@/components/ai-elements/message";
import { CompanionAvatar } from "@/components/CompanionAvatar";
import { Button } from "@/components/ui/button";
import "./TaskActivity.css";

type Props = {
  companion: Companion;
  refreshVersion?: number;
  onOpenCompanion?: (id: string) => void;
  specialists?: CompanionDetail["specialists"];
  onOpenDiscussion: () => void;
};

const cancellable = new Set(["queued", "preparing", "running", "needs_input"]);

function readableTime(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase());
}

function sourceLabel(source: string) {
  if (source === "routine") return "Routine";
  if (source === "trigger" || source === "webhook") return "Event";
  if (source === "delegation") return "Delegated";
  return source === "chat" ? "Discussion" : statusLabel(source);
}

export function TaskActivity({ companion, refreshVersion = 0, onOpenCompanion, specialists = [], onOpenDiscussion }: Props) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailFiles, setDetailFiles] = useState<Awaited<ReturnType<typeof api.taskDetail>>["files"]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [olderLoading, setOlderLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [olderError, setOlderError] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const refreshSequence = useRef(0);
  const hasOlderPages = useRef(false);

  async function loadFirstPage() {
    const sequence = ++refreshSequence.current;
    setListLoading(tasks.length === 0);
    setListError("");
    try {
      const [page, refreshedDetail] = await Promise.all([
        api.taskHistory(companion.id),
        selectedId ? api.taskDetail(companion.id, selectedId) : Promise.resolve(null),
      ]);
      if (sequence !== refreshSequence.current) return;
      setTasks(current => {
        const refreshed = new Set(page.tasks.map(task => task.id));
        return [...page.tasks, ...current.filter(task => !refreshed.has(task.id))];
      });
      if (!hasOlderPages.current) setNextCursor(page.nextCursor);
      if (refreshedDetail) { setDetail(refreshedDetail.task); setDetailFiles(refreshedDetail.files); }
    } catch (cause) {
      if (sequence !== refreshSequence.current) return;
      setListError(cause instanceof Error ? cause.message : "Could not load activity.");
    } finally {
      if (sequence === refreshSequence.current) setListLoading(false);
    }
  }

  useEffect(() => { void loadFirstPage(); }, [companion.id, refreshVersion]);

  async function loadOlder() {
    if (!nextCursor || olderLoading) return;
    setOlderLoading(true); setOlderError("");
    try {
      const page = await api.taskHistory(companion.id, nextCursor);
      setTasks(current => {
        const known = new Set(current.map(task => task.id));
        return [...current, ...page.tasks.filter(task => !known.has(task.id))];
      });
      hasOlderPages.current = true;
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setOlderError(cause instanceof Error ? cause.message : "Could not load older activity.");
    } finally { setOlderLoading(false); }
  }

  async function openTask(taskId: string) {
    setSelectedId(taskId); setDetail(null); setDetailFiles([]); setDetailLoading(true); setDetailError(""); setCancelError("");
    try {
      const result = await api.taskDetail(companion.id, taskId);
      setDetail(result.task); setDetailFiles(result.files);
    } catch (cause) {
      setDetailError(cause instanceof Error ? cause.message : "Could not load this task.");
    } finally { setDetailLoading(false); }
  }

  async function cancelTask() {
    if (!detail || cancelling) return;
    setCancelling(true); setCancelError("");
    try {
      const result = await api.cancelTask(companion.id, detail.id);
      setDetail(result.task);
      setTasks(current => current.map(task => task.id === result.task.id ? { ...task, status: result.task.status, finishedAt: result.task.finishedAt } : task));
    } catch (cause) {
      setCancelError(cause instanceof Error ? cause.message : "Could not cancel this task.");
    } finally { setCancelling(false); }
  }

  if (selectedId) {
    const delegated = specialists.filter(item => item.parentRunId === selectedId);
    return <div className="task-activity task-activity--detail">
      <button className="task-back" type="button" onClick={() => { setSelectedId(null); setDetail(null); setDetailFiles([]); setDetailError(""); }}><ArrowLeft />All activity</button>
      {detailLoading ? <div className="task-detail-skeleton" role="status" aria-label="Loading task"><span/><span/><span/></div> : detailError ? <div className="task-state" role="alert"><CircleAlert/><h2>Couldn’t open this task</h2><p>{detailError}</p><Button variant="outline" onClick={() => void openTask(selectedId)}>Try again</Button></div> : detail ? <article className="task-detail">
        <header>
          <div><span className={`task-status task-status--${detail.status}`}>{statusLabel(detail.status)}</span><span>{sourceLabel(detail.source)} · {detail.lane === "background" ? "Background" : "Main"}</span></div>
          <h2>{detail.title}</h2>
          <p>Started {readableTime(detail.startedAt ?? detail.createdAt)}{detail.finishedAt ? ` · Finished ${readableTime(detail.finishedAt)}` : ""}</p>
        </header>
        <section><h3>Original request</h3><MessageResponse>{detail.content}</MessageResponse></section>
        {detail.resultText && <section><h3>Result</h3><MessageResponse>{detail.resultText}</MessageResponse></section>}
        {detail.error && <section className="task-error" role="alert"><h3>What happened</h3><p>{detail.error}</p></section>}
        {!!delegated.length && <section><h3>Specialists</h3><div className="task-specialists">{delegated.map(item => <button type="button" disabled={!onOpenCompanion} onClick={() => onOpenCompanion?.(item.companion.id)} key={item.delegationId} aria-label={`Open ${item.companion.name}'s discussion`}><CompanionAvatar name={item.companion.name} avatar={item.companion.avatar} size={36}/><span><strong>{item.companion.name}</strong><small>{item.companion.retiredAt ? "Finished" : statusLabel(item.companion.status)}</small></span><ChevronRight/></button>)}</div></section>}
        {!!detailFiles.length && <section><h3>Files</h3><div className="task-files">{detailFiles.map(file => <a href={file.url} target="_blank" rel="noreferrer" key={file.id}><FileText/><span>{file.name}</span></a>)}</div></section>}
        {detail.status === "needs_input" && <div className="task-next"><p>{companion.name} needs your answer before continuing.</p><Button onClick={onOpenDiscussion}><MessageCircle/>Open Discussion</Button></div>}
        {cancelError && <p className="task-action-error" role="alert">{cancelError}</p>}
        {!companion.retiredAt && detail.lane === "background" && cancellable.has(detail.status) && <div className="task-actions"><Button variant="outline" disabled={cancelling || detail.cancelRequested} onClick={() => void cancelTask()}>{cancelling ? <LoaderCircle className="spin"/> : <CircleStop/>}{cancelling ? "Cancelling…" : detail.cancelRequested ? "Cancellation requested" : "Cancel task"}</Button></div>}
      </article> : null}
    </div>;
  }

  return <div className="task-activity">
    <header className="task-activity-heading"><h2>Activity</h2><p>Tasks your companion has accepted, from request to result.</p></header>
    {listLoading ? <div className="task-list-skeleton" role="status" aria-label="Loading activity">{Array.from({ length: 5 }, (_, index) => <span key={index}/>)}</div> : tasks.length === 0 && !listError ? <div className="task-empty"><h3>No tasks yet</h3><p>Tasks from Discussion, routines, events, and delegation will appear here.</p></div> : <div className="task-list">{tasks.map(task => <button type="button" className="task-row" onClick={() => void openTask(task.id)} key={task.id}>
      <span className={`task-status-dot task-status-dot--${task.status}`} aria-hidden="true"/>
      <span className="task-row-copy"><strong>{task.title}</strong><small>{sourceLabel(task.source)} · {task.lane === "background" ? "Background" : "Main"}</small></span>
      <span className="task-row-meta"><span>{statusLabel(task.status)}</span><time dateTime={task.createdAt}>{readableTime(task.createdAt)}</time></span>
      <ChevronRight aria-hidden="true"/>
    </button>)}</div>}
    {listError && <div className="task-list-error" role="alert"><span>{listError}</span><Button variant="outline" size="sm" onClick={() => void loadFirstPage()}>Try again</Button></div>}
    {olderError && <div className="task-list-error" role="alert"><span>{olderError}</span><Button variant="outline" size="sm" onClick={() => void loadOlder()}>Try again</Button></div>}
    {nextCursor && <Button className="task-load-older" variant="outline" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading && <LoaderCircle className="spin"/>}{olderLoading ? "Loading…" : "Load older"}</Button>}
  </div>;
}
