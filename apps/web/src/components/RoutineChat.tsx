import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, CircleAlert, FileText, Repeat2, X } from "lucide-react";
import { api, type ChatMessage, type CompanionDetail, type Run, type RunStatus, type TaskDetail, type ThreadFile } from "@/api";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import "./RoutineChat.css";

export type ChatTimelineItem = { id: string; createdAt: string; message: ChatMessage | null; content: ReactNode; routineRuns?: Run[] };
const timestamp = (value: string) => Date.parse(value) || 0;
const date = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const time = (value: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
export const routineRunName = (run: Pick<Run, "routineName">) => run.routineName || "Routine";
const statuses: Record<RunStatus, string> = { queued: "Queued", preparing: "Preparing", running: "Running", needs_input: "Needs you", succeeded: "Completed", failed: "Failed", interrupted: "Interrupted", cancelled: "Cancelled" };
export function routineRunLabel(run: Pick<Run, "status" | "publishToChat">) {
  return run.status === "succeeded" ? run.publishToChat ? "Notification sent" : "Completed · No notification" : statuses[run.status];
}

// Messages, questions and other conversation entries are grouping boundaries. Only
// successful silent runs of the same routine and local day can collapse together.
export function withRoutineActivity(items: ChatTimelineItem[], detail: Pick<CompanionDetail, "runs" | "messages" | "questions">): ChatTimelineItem[] {
  const published = new Set(detail.messages.filter(message => message.role === "assistant").map(message => message.runId));
  const questioned = new Set(detail.questions?.map(question => question.runId));
  const all: ChatTimelineItem[] = [...items, ...detail.runs.filter(run => run.source === "routine" && !published.has(run.id)).map(run => ({
    id: `routine-${run.id}`, createdAt: run.createdAt, message: null, content: null, routineRuns: [run],
  }))];
  all.sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt) || (a.message && b.message && a.message.runId === b.message.runId ? (a.message.sequence ?? 0) - (b.message.sequence ?? 0) : 0) || a.id.localeCompare(b.id));
  const result: ChatTimelineItem[] = [];
  const quiet = (run: Run) => run.status === "succeeded" && !run.publishToChat && !questioned.has(run.id);
  for (const item of all) {
    const previous = result.at(-1);
    const prior = previous?.routineRuns?.at(-1);
    const current = item.routineRuns?.[0];
    if (prior && current && quiet(prior) && quiet(current) && current.routineId && prior.routineId === current.routineId
      && prior.routineName === current.routineName && new Date(prior.createdAt).toDateString() === new Date(current.createdAt).toDateString()) {
      previous!.routineRuns = [...previous!.routineRuns!, current];
    } else result.push(item);
  }
  return result;
}

export function RoutineActivityRow({ runs, onOpen }: { runs: Run[]; onOpen: (ids: string[]) => void }) {
  const first = runs[0]!;
  const last = runs.at(-1)!;
  const grouped = runs.length > 1;
  const attention = ["failed", "interrupted", "needs_input"].includes(last.status);
  return <button type="button" className={`routine-trace${attention ? " routine-trace--attention" : ""}`} onClick={() => onOpen(runs.map(run => run.id))} aria-label={`View ${routineRunName(first)}: ${grouped ? `${runs.length} runs without a message` : routineRunLabel(first)}`}>
    {attention ? <CircleAlert aria-hidden="true" /> : <Repeat2 aria-hidden="true" />}
    <span className="routine-trace-copy"><span><strong>{routineRunName(first)}</strong><span className="routine-trace-state">{grouped ? `${runs.length} runs without a message` : routineRunLabel(first)}</span></span>
      {grouped && <small>{time(first.createdAt)}–{time(last.finishedAt || last.createdAt)} · All completed</small>}
    </span>
    <time dateTime={last.createdAt} title={date(last.createdAt)}>{time(last.createdAt)}</time><ChevronRight aria-hidden="true" />
  </button>;
}

export function RoutineProvenance({ run, onOpen }: { run?: Run; onOpen: (ids: string[]) => void }) {
  if (run?.source !== "routine") return null;
  return <button type="button" className="routine-provenance" onClick={() => onOpen([run.id])} aria-label={`View execution of ${routineRunName(run)}`}><Repeat2 aria-hidden="true"/>{routineRunName(run)}<ChevronRight aria-hidden="true"/></button>;
}

export function RoutineRunSheet({ companionId, runs, onClose, onOpenRoutine }: { companionId: string; runs: Run[]; onClose: () => void; onOpenRoutine?: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(runs.length === 1 ? runs[0]!.id : null);
  const [result, setResult] = useState<{ task: TaskDetail; files: ThreadFile[] } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const selected = runs.find(run => run.id === selectedId);
  useEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element.showModal) element.showModal(); else element.setAttribute("open", "");
    element.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (element.close) element.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    if (!selectedId) return;
    let current = true;
    setLoading(true); setError(""); setResult(null);
    api.taskDetail(companionId, selectedId).then(value => { if (current) setResult(value); }, cause => { if (current) setError(cause instanceof Error ? cause.message : "Could not load this execution."); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [companionId, selectedId, selected?.status, selected?.finishedAt, retry]);
  const task = result?.task;
  const first = runs[0]!;
  const duration = task?.startedAt && task.finishedAt ? Math.max(0, Math.round((timestamp(task.finishedAt) - timestamp(task.startedAt)) / 1000)) : null;
  return <dialog ref={dialog} className="routine-sheet" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="routine-sheet-surface">
      <header className="routine-sheet-heading"><div><span><Repeat2 aria-hidden="true"/>Routine execution</span><h2 id={titleId}>{routineRunName(first)}</h2></div><Button variant="ghost" size="icon" aria-label="Close execution details" onClick={onClose}><X/></Button></header>
      <div className="routine-sheet-body">
        {selectedId && runs.length > 1 && <button type="button" className="routine-sheet-back" onClick={() => setSelectedId(null)}><ArrowLeft/>All {runs.length} executions</button>}
        {!selectedId ? <div className="routine-sheet-list">{[...runs].reverse().map(run => <button type="button" key={run.id} onClick={() => setSelectedId(run.id)}><span><time dateTime={run.createdAt}>{date(run.createdAt)}</time><small>{routineRunLabel(run)}</small></span><ChevronRight/></button>)}</div>
          : loading ? <div className="routine-sheet-loading" role="status" aria-label="Loading execution"><span/><span/><span/></div>
          : error ? <div className="routine-sheet-error" role="alert"><CircleAlert/><p>{error}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>Try again</Button></div>
          : task ? <>
            <div className={`routine-sheet-outcome${["failed", "interrupted", "needs_input"].includes(task.status) ? " routine-sheet-outcome--attention" : ""}`}>{routineRunLabel(task)}</div>
            <dl className="routine-sheet-facts"><div><dt>Requested</dt><dd>{date(task.createdAt)}</dd></div>{task.scheduledFor && <div><dt>Scheduled for</dt><dd>{date(task.scheduledFor)}</dd></div>}{task.startedAt && <div><dt>Started</dt><dd>{date(task.startedAt)}</dd></div>}{task.finishedAt && <div><dt>Finished</dt><dd>{date(task.finishedAt)}</dd></div>}{duration != null && <div><dt>Duration</dt><dd>{duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`}</dd></div>}</dl>
            {task.status === "needs_input" && <div className="routine-sheet-next"><p>Your companion needs an answer in notifications.</p></div>}
            {task.error && <section className="routine-sheet-error"><h3>What happened</h3><p>{task.error}</p></section>}
            {task.resultText && <section><h3>Result</h3><MessageResponse>{task.resultText}</MessageResponse></section>}
            {!!result.files.length && <section><h3>Files</h3><div className="routine-sheet-files">{result.files.map(file => <a key={file.id} href={file.url} target="_blank" rel="noreferrer"><FileText/><span>{file.name}</span></a>)}</div></section>}
            <section><h3>Instructions for this execution</h3><MessageResponse>{task.content}</MessageResponse></section>
          </> : null}
      </div>
      {first.routineId && onOpenRoutine && <footer><Button variant="outline" onClick={() => onOpenRoutine(first.routineId!)}>Open routine<ChevronRight/></Button></footer>}
    </div>
  </dialog>;
}
