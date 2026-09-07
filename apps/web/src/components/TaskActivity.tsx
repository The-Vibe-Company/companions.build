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

function mergeTaskRows(...groups: TaskSummary[][]) {
  const byId = new Map<string, TaskSummary>();
  for (const group of groups) for (const task of group) byId.set(task.id, task);
  return [...byId.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id));
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
  const [refreshing, setRefreshing] = useState(false);
  const hasOlderPages = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const detailEpoch = useRef(0);
  const listOperation = useRef<"refresh" | "older" | null>(null);
  const refreshQueued = useRef(false);
  const taskMutationEpochs = useRef(new Map<string, number>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function drainRefreshQueue() {
    if (listOperation.current) return;
    listOperation.current = "refresh";
    setRefreshing(true);
    while (refreshQueued.current && mounted.current) {
      refreshQueued.current = false;
      const selected = selectedIdRef.current;
      const epoch = detailEpoch.current;
      const mutationEpochs = new Map(taskMutationEpochs.current);
      setListError("");
      const [pageResult, detailResult] = await Promise.allSettled([
        api.taskHistory(companion.id),
        selected ? api.taskDetail(companion.id, selected) : Promise.resolve(null),
      ]);
      if (!mounted.current) break;
      if (pageResult.status === "fulfilled") {
        const page = pageResult.value;
        setTasks(current => {
          const safePage = page.tasks.filter(task => (taskMutationEpochs.current.get(task.id) ?? 0) === (mutationEpochs.get(task.id) ?? 0));
          if (hasOlderPages.current) return mergeTaskRows(current, safePage);
          const protectedRows = current.filter(task => page.tasks.some(fresh => fresh.id === task.id) && !safePage.some(fresh => fresh.id === task.id));
          return mergeTaskRows(protectedRows, safePage);
        });
        // Restart traversal from the refreshed head. This may revisit known rows,
        // which are deduplicated, and cannot skip tasks inserted since pagination began.
        setNextCursor(page.nextCursor);
        setListError("");
      } else {
        setListError(pageResult.reason instanceof Error ? pageResult.reason.message : "Could not load activity.");
      }
      if (selected && selectedIdRef.current === selected && detailEpoch.current === epoch) {
        if (detailResult.status === "fulfilled" && detailResult.value) {
          const refreshed = detailResult.value;
          setDetail(refreshed.task); setDetailFiles(refreshed.files); setDetailError("");
          setTasks(current => current.map(task => task.id === refreshed.task.id ? { ...task, ...refreshed.task } : task));
        } else if (detailResult.status === "rejected") {
          setDetailError(detailResult.reason instanceof Error ? detailResult.reason.message : "Could not refresh this task.");
        }
      }
    }
    listOperation.current = null;
    if (mounted.current) { setRefreshing(false); setListLoading(false); }
  }

  function requestRefresh() {
    refreshQueued.current = true;
    if (!listOperation.current) void drainRefreshQueue();
  }

  useEffect(() => { requestRefresh(); }, [companion.id, refreshVersion]);

  async function loadOlder() {
    if (!nextCursor || listOperation.current) return;
    listOperation.current = "older";
    setOlderLoading(true); setOlderError("");
    try {
      const page = await api.taskHistory(companion.id, nextCursor);
      if (!mounted.current) return;
      setTasks(current => mergeTaskRows(current, page.tasks));
      hasOlderPages.current = true;
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (mounted.current) setOlderError(cause instanceof Error ? cause.message : "Could not load older activity.");
    } finally {
      listOperation.current = null;
      if (mounted.current) setOlderLoading(false);
      if (refreshQueued.current) void drainRefreshQueue();
    }
  }

  async function openTask(taskId: string) {
    selectedIdRef.current = taskId;
    const epoch = ++detailEpoch.current;
    setSelectedId(taskId); setDetail(null); setDetailFiles([]); setDetailLoading(true); setDetailError(""); setCancelError("");
    try {
      const result = await api.taskDetail(companion.id, taskId);
      if (!mounted.current || selectedIdRef.current !== taskId || detailEpoch.current !== epoch) return;
      setDetail(result.task); setDetailFiles(result.files);
    } catch (cause) {
      if (!mounted.current || selectedIdRef.current !== taskId || detailEpoch.current !== epoch) return;
      setDetailError(cause instanceof Error ? cause.message : "Could not load this task.");
    } finally { if (mounted.current && selectedIdRef.current === taskId && detailEpoch.current === epoch) setDetailLoading(false); }
  }

  async function cancelTask() {
    if (!detail || cancelling) return;
    const taskId = detail.id;
    const epoch = ++detailEpoch.current;
    taskMutationEpochs.current.set(taskId, (taskMutationEpochs.current.get(taskId) ?? 0) + 1);
    setCancelling(true); setCancelError("");
    try {
      const result = await api.cancelTask(companion.id, taskId);
      if (!mounted.current) return;
      taskMutationEpochs.current.set(taskId, (taskMutationEpochs.current.get(taskId) ?? 0) + 1);
      setTasks(current => current.map(task => task.id === result.task.id ? { ...task, status: result.task.status, finishedAt: result.task.finishedAt } : task));
      if (selectedIdRef.current !== taskId || detailEpoch.current !== epoch) return;
      setDetail(result.task);
    } catch (cause) {
      if (!mounted.current) return;
      const message = cause instanceof Error ? cause.message : "Could not cancel this task.";
      if (selectedIdRef.current === taskId && detailEpoch.current === epoch) setCancelError(message);
      else setListError(message);
    } finally { if (mounted.current && selectedIdRef.current === taskId && detailEpoch.current === epoch) setCancelling(false); }
  }

  function closeTask() {
    selectedIdRef.current = null;
    detailEpoch.current += 1;
    setSelectedId(null); setDetail(null); setDetailFiles([]); setDetailError(""); setDetailLoading(false); setCancelling(false);
  }

  if (selectedId) {
    const delegated = specialists.filter(item => item.parentRunId === selectedId);
    return <div className="task-activity task-activity--detail">
      <button className="task-back" type="button" onClick={closeTask}><ArrowLeft />All activity</button>
      {detailLoading ? <div className="task-detail-skeleton" role="status" aria-label="Loading task"><span/><span/><span/></div> : detailError ? <div className="task-state" role="alert"><CircleAlert/><h2>Couldn’t open this task</h2><p>{detailError}</p><Button variant="outline" onClick={() => void openTask(selectedId)}>Try again</Button></div> : detail ? <article className="task-detail">
        <header>
          <div><span className={`task-status task-status--${detail.status}`}>{statusLabel(detail.status)}</span><span>{sourceLabel(detail.source)}</span></div>
          <h2>{detail.title}</h2>
          <p>Requested {readableTime(detail.createdAt)}{detail.startedAt ? ` · Started ${readableTime(detail.startedAt)}` : ""}{detail.finishedAt ? ` · Finished ${readableTime(detail.finishedAt)}` : ""}</p>
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
      <span className="task-row-copy"><strong>{task.title}</strong><small>{sourceLabel(task.source)}</small></span>
      <span className="task-row-meta"><span>{statusLabel(task.status)}</span><time dateTime={task.createdAt}>{readableTime(task.createdAt)}</time></span>
      <ChevronRight aria-hidden="true"/>
    </button>)}</div>}
    {listError && <div className="task-list-error" role="alert"><span>{listError}</span><Button variant="outline" size="sm" onClick={requestRefresh}>Try again</Button></div>}
    {olderError && <div className="task-list-error" role="alert"><span>{olderError}</span><Button variant="outline" size="sm" onClick={() => void loadOlder()}>Try again</Button></div>}
    {nextCursor && <Button className="task-load-older" variant="outline" disabled={olderLoading || refreshing} onClick={() => void loadOlder()}>{olderLoading && <LoaderCircle className="spin"/>}{olderLoading ? "Loading…" : "Load older"}</Button>}
  </div>;
}
