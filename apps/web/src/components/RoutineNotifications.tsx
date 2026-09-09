import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Bell, Check, ChevronDown, CircleAlert, FileText, X } from "lucide-react";
import { api, type RoutineNotification, type TaskDetail, type ThreadFile } from "@/api";
import { Button } from "@/components/ui/button";
import { Question } from "@/components/Question";
import { MessageResponse } from "@/components/ai-elements/message";
import "./RoutineNotifications.css";

const date = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const kindLabel = { result: "Result", question: "Needs you", failure: "Failed" } as const;

type NotificationGroup = { id: string; items: RoutineNotification[] };

export function groupRoutineNotifications(notifications: RoutineNotification[]): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>();
  for (const notification of notifications) {
    const key = notification.kind === "failure" ? `${notification.routineId ?? notification.routineName}:${notification.groupDate}` : notification.id;
    const group = groups.get(key);
    if (group) group.items.push(notification); else groups.set(key, { id:key, items:[notification] });
  }
  return [...groups.values()];
}

export function RoutineNotifications({ companionId, companionName, questions = [], open, refreshVersion, onOpen, onClose, onChanged }: {
  companionId: string;
  companionName: string;
  open: boolean;
  refreshVersion: number;
  onOpen: () => void;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  questions?:NonNullable<import("@/api").CompanionDetail["questions"]>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const initialized = useRef(false);
  const known = useRef(new Set<string>());
  const request = useRef(0);
  const loadedPages = useRef(1);
  const notificationsRef = useRef<RoutineNotification[]>([]);
  const titleId = useId();
  const [notifications, setNotifications] = useState<RoutineNotification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<RoutineNotification | null>(null);
  notificationsRef.current=notifications;

  const refreshLoaded = useCallback(async () => {
    const sequence=++request.current;
    const priorOldestId=notificationsRef.current.at(-1)?.id;
    const targetPages=loadedPages.current;
    setLoading(true);setLoadingMore(false);
    try {
      const refreshed:RoutineNotification[]=[];
      let pageCursor:string|undefined;
      let nextCursor:string|null=null;
      let pages=0;
      let firstPage:RoutineNotification[]=[];
      do{
        const result=await api.getNotifications(companionId,pageCursor);
        if(sequence!==request.current)return;
        if(!Array.isArray(result.notifications))throw new Error("Could not load notifications.");
        if(pages===0)firstPage=result.notifications;
        refreshed.push(...result.notifications.filter(item=>!refreshed.some(existing=>existing.id===item.id)));
        nextCursor=result.nextCursor;
        pageCursor=nextCursor??undefined;
        pages+=1;
      }while(nextCursor && (pages<targetPages || Boolean(priorOldestId&&!refreshed.some(item=>item.id===priorOldestId))));
      if(sequence!==request.current)return;
      const unseen = firstPage.filter(item => !known.current.has(item.id));
      if (initialized.current && unseen.length && !open) setPreview(unseen[0]!);
      refreshed.forEach(item => known.current.add(item.id));
      initialized.current = true;
      loadedPages.current=pages;
      setNotifications(refreshed);
      setCursor(nextCursor);
      setError("");
    } catch (cause) {
      if(sequence!==request.current)return;
      setError(cause instanceof Error ? cause.message : "Could not load notifications.");
    } finally {
      if(sequence===request.current)setLoading(false);
    }
  },[companionId,open]);

  const loadMore = useCallback(async (pageCursor:string) => {
    const sequence=++request.current;
    setLoadingMore(true);setLoading(false);
    try{
      const result=await api.getNotifications(companionId,pageCursor);
      if(sequence!==request.current)return;
      if(!Array.isArray(result.notifications))throw new Error("Could not load notifications.");
      result.notifications.forEach(item=>known.current.add(item.id));
      setNotifications(current=>[...current,...result.notifications.filter(item=>!current.some(existing=>existing.id===item.id))]);
      loadedPages.current+=1;
      setCursor(result.nextCursor);setError("");
    }catch(cause){if(sequence===request.current)setError(cause instanceof Error?cause.message:"Could not load notifications.");}
    finally{if(sequence===request.current)setLoadingMore(false);}
  },[companionId]);

  useEffect(() => { request.current+=1; initialized.current = false; known.current.clear(); loadedPages.current=1; setNotifications([]); setCursor(null); setPreview(null); void refreshLoaded(); return()=>{request.current+=1;}; }, [companionId]);
  useEffect(() => { if (initialized.current) void refreshLoaded(); }, [refreshVersion]);
  useEffect(() => { const timer = window.setInterval(() => void refreshLoaded(), 8_000); return () => window.clearInterval(timer); },[refreshLoaded]);
  useEffect(()=>{if(!preview)return;const timer=window.setTimeout(()=>setPreview(current=>current?.id===preview.id?null:current),5_000);return()=>window.clearTimeout(timer);},[preview]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!element.open) { if (element.showModal) element.showModal(); else element.setAttribute("open", ""); }
      element.querySelector<HTMLButtonElement>("button")?.focus();
      setPreview(null);
    } else if (element.open) {
      if (element.close) element.close(); else element.removeAttribute("open");
      if (opener.current?.isConnected) opener.current.focus();
    }
  }, [open]);

  async function markRead(notification: RoutineNotification) {
    if (notification.readAt) return;
    try {
      await api.readNotification(companionId, notification.id);
      setNotifications(current=>current.map(item=>item.id===notification.id?{...item,readAt:item.readAt??new Date().toISOString()}:item));
      await refreshLoaded();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not mark this notification as read.");
    }
  }

  const groups = useMemo(() => groupRoutineNotifications(notifications), [notifications]);
  return <>
    {preview && <div className="notification-preview" role="status">
      <button type="button" onClick={() => { setPreview(null); onOpen(); }}><Bell aria-hidden="true"/><span><strong>{preview.routineName}</strong><small>{preview.text}</small></span></button>
      <button type="button" aria-label="Dismiss notification preview" onClick={() => setPreview(null)}><X/></button>
    </div>}
    <dialog ref={dialog} className="notifications-sheet" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="notifications-surface">
        <header><div><span><Bell/>Routine updates</span><h2 id={titleId}>Notifications</h2></div><Button variant="ghost" size="icon" aria-label="Close notifications" onClick={onClose}><X/></Button></header>
        <div className="notifications-body">
          {loading && notifications.length === 0 ? <div className="notifications-loading" role="status" aria-label="Loading notifications"><span/><span/><span/></div>
          : error && notifications.length === 0 ? <div className="notifications-empty" role="alert"><CircleAlert/><p>{error}</p><Button variant="outline" onClick={() => void refreshLoaded()}>Try again</Button></div>
          : notifications.length === 0 ? <div className="notifications-empty"><Bell/><h3>You’re all caught up</h3><p>Routine results, questions, and failures will appear here.</p></div>
          : <div className="notification-list">{groups.map(group => <NotificationEntry key={group.id} group={group} companionId={companionId} questions={questions} onRead={markRead} onAnswered={async () => { await refreshLoaded(); await onChanged(); }}/>)}</div>}
          {error && notifications.length > 0 && <div className="notifications-inline-error" role="alert"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => void refreshLoaded()}>Try again</Button></div>}
          {cursor && <Button className="notifications-more" variant="outline" disabled={loadingMore} onClick={() => void loadMore(cursor)}>{loadingMore ? "Loading…" : "Load older"}</Button>}
        </div>
        <footer>Updates from {companionName}’s routines</footer>
      </div>
    </dialog>
  </>;
}

function NotificationEntry({ group, companionId, questions, onRead, onAnswered }: { group: NotificationGroup; companionId: string; questions:NonNullable<import("@/api").CompanionDetail["questions"]>; onRead: (notification: RoutineNotification) => Promise<void>; onAnswered: () => Promise<void> }) {
  const latest = group.items[0]!;
  const grouped = group.items.length > 1;
  const unread = group.items.filter(item => !item.readAt).length;
  return <article className={`notification-entry${unread ? " notification-entry--unread" : ""}`}>
    <div className="notification-entry-heading"><span className={`notification-kind notification-kind--${latest.kind}`}>{latest.kind === "failure" ? <CircleAlert/> : latest.kind === "question" ? <Bell/> : <Check/>}</span><div><strong>{latest.routineName}</strong><span>{grouped ? `${group.items.length} failures` : latest.kind==="failure"&&latest.runStatus==="interrupted" ? "Interrupted" : kindLabel[latest.kind]} · <time dateTime={latest.createdAt}>{date(latest.createdAt)}</time></span></div></div>
    {grouped ? <details><summary><span>{latest.text}</span><ChevronDown/></summary><div className="notification-occurrences">{group.items.map(item => <NotificationDisclosure key={item.id} notification={item} question={questions.find(question=>question.id===item.questionId)} companionId={companionId} onRead={onRead} onAnswered={onAnswered}/>)}</div></details>
    : <NotificationDisclosure notification={latest} question={questions.find(question=>question.id===latest.questionId)} companionId={companionId} onRead={onRead} onAnswered={onAnswered}/>}
  </article>;
}

function NotificationDisclosure({notification,question:detailQuestion,companionId,onRead,onAnswered}:{notification:RoutineNotification;question?:NonNullable<import("@/api").CompanionDetail["questions"]>[number];companionId:string;onRead:(notification:RoutineNotification)=>Promise<void>;onAnswered:()=>Promise<void>}){
  const [expanded,setExpanded]=useState(false);
  const [detail,setDetail]=useState<{task:TaskDetail;files:ThreadFile[]}|null>(null);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  async function open(){
    if(!notification.readAt)void onRead(notification);
    if(detail||loading)return;
    setLoading(true);setError("");
    try{setDetail(await api.taskDetail(companionId,notification.runId));}
    catch(cause){setError(cause instanceof Error?cause.message:"Could not load execution details.");}
    finally{setLoading(false);}
  }
  const notificationQuestion=notification.question??detailQuestion;
  const question=notificationQuestion?{...notificationQuestion,runStatus:notification.actionable?notificationQuestion.runStatus:"cancelled"}:null;
  return <details className="notification-disclosure" onToggle={event=>{const next=event.currentTarget.open;setExpanded(next);if(next)void open();}}><summary><span>{notification.text}</span><small>{date(notification.createdAt)}</small><ChevronDown/></summary>{expanded&&<div className="notification-detail">
    {question&&<Question companionId={companionId} question={question} onAnswered={onAnswered}/>}
    {loading&&<p role="status">Loading execution…</p>}
    {error&&<p role="alert" className="field-error">{error}</p>}
    {detail?.task.resultText&&<section><h4>Result</h4><MessageResponse>{detail.task.resultText}</MessageResponse></section>}
    {detail?.task.error&&<section><h4>What happened</h4><p>{detail.task.error}</p></section>}
    {!!detail?.files.length&&<section><h4>Files</h4><div className="notification-files">{detail.files.map(file=><a key={file.id} href={file.url} target="_blank" rel="noreferrer"><FileText/><span>{file.name}</span></a>)}</div></section>}
  </div>}</details>;
}
