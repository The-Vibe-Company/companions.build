import { ChevronRight, CircleAlert, FileText, LoaderCircle, UserRound } from "lucide-react";
import { type ReactNode, memo, useCallback, useEffect, useRef, useState } from "react";
import { type CompanionDetail, type Companion, type RunStatus, isActiveRun } from "@/api";
import { ConversationEmptyState } from "./ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "./ai-elements/message";
import { CompanionAvatar } from "./CompanionAvatar";
import { Question } from "./Question";
import { RoutineActivityRow, RoutineProvenance, RoutineRunSheet, withRoutineActivity } from "./RoutineChat";
import { SpecialistImprovements } from "./SpecialistImprovements";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { ChatViewport } from "./ChatViewport";
import { ChatHistory, type HistoryState } from "@/lib/chat-history";
import { readingKey, readPosition } from "@/lib/chat-reading";
import { Button } from "./ui/button";
import { PluginCalls } from "./PluginCalls";
import { cn } from "@/lib/utils";

function readableDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function statusLabel(status: Companion["status"] | RunStatus) {
  if (status === "archived") return "Sleeping";
  return status.replace("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function StatusDot({ status }: { status: Companion["status"] }) {
  return <span className={cn("status-dot", `status-dot--${status}`)} aria-hidden="true" />;
}

function SpecialistsForRun({ detail, runId, onOpen }: { detail: CompanionDetail; runId: string; onOpen: (id: string) => void }) {
  const specialists = detail.specialists?.filter(item => item.parentRunId === runId) ?? [];
  if (!specialists.length) return null;
  return <div className="task-specialists" aria-label="Specialists for this task">
    {specialists.map(({ delegationId, companion }) => {
      const finished = Boolean(companion.retiredAt);
      const status = finished ? "archived" : companion.status;
      return <button type="button" key={delegationId} className="task-specialist" onClick={() => onOpen(companion.id)} aria-label={`Open ${companion.name}'s chat`}>
        <CompanionAvatar name={companion.name} avatar={companion.avatar} size={28} />
        <span><strong>{companion.name}</strong><small><StatusDot status={status} />{finished ? "Finished" : statusLabel(status)}</small></span>
        <ChevronRight />
      </button>;
    })}
  </div>;
}

type ChatProps = { accountId: string; onOpenRoutine?: (id: string) => void; detail: CompanionDetail; onRefresh: () => Promise<void>; onUnauthorized: () => void; onOpenCompanion: (id: string) => void; specialistTemplateId?: string | null; specialistCards?: ReactNode; specialistHistory?: Array<{id:string;runId?:string;createdAt:string;content:ReactNode}>; readOnly?: boolean };
export function Chat(props: ChatProps) {
  const storageKey = readingKey(props.accountId, props.detail.companion.id);
  const history = useRef<ChatHistory | null>(null);
  const initial = useRef(props.detail);
  const [state, setState] = useState<HistoryState>({ detail: props.detail, loading: false, restoring: Boolean(props.detail.chat), error: '', gaps: [], older: null });
  useEffect(() => {
    const controller = new ChatHistory(props.detail);
    history.current = controller;
    initial.current = props.detail;
    const unsubscribe = controller.subscribe(() => setState(controller.state));
    void controller.initialize(readPosition(storageKey));
    return () => { unsubscribe(); controller.dispose(); };
  }, [storageKey]);
  useEffect(() => {
    if (initial.current !== props.detail) void history.current?.refresh(props.detail);
  }, [props.detail]);
  const older = useCallback(() => { void history.current?.older(); }, []);
  const fillGap = useCallback((after: string) => { void history.current?.fillGap(after); }, []);
  const retry = useCallback(() => { void history.current?.retry(); }, []);
  return <ChatTimeline {...props} detail={state.detail} storageKey={storageKey} historyState={state} onOlder={older} onGap={fillGap} onRetry={retry}/>;
}

const EMPTY_SPECIALIST_HISTORY: NonNullable<ChatProps['specialistHistory']> = [];
export const ChatTimeline = memo(function ChatTimeline({ detail, onRefresh, onUnauthorized, onOpenCompanion, specialistTemplateId, specialistCards, specialistHistory = EMPTY_SPECIALIST_HISTORY, readOnly = false, onOpenRoutine, storageKey, historyState, onOlder, onGap, onRetry }: ChatProps & {
  storageKey: string; historyState: HistoryState; onOlder: () => void; onGap: (after: string) => void; onRetry: () => void;
}) {
  const composerRef = useRef<ChatComposerHandle>(null);
  const [routineRunIds, setRoutineRunIds] = useState<string[]>([]);
  const routineRuns = detail.runs.filter(run => routineRunIds.includes(run.id));
  const runsById = new Map(detail.runs.map(run => [run.id, run]));
  const lastAssistantByRun = new Map(detail.messages.filter(message => message.role === "assistant").map(message => [message.runId, message.id]));
  const activeRun = detail.runs.find(run => run.lane !== "background" && isActiveRun(run.status));
  const activePreview = activeRun
    && activeRun.messageVersion == null
    && (activeRun.status === "running" || activeRun.status === "needs_input")
    && activeRun.previewText
    && !(detail.questions ?? []).some(question => question.contextText === activeRun.previewText)
    && !detail.messages.some((message) => message.role === "assistant" && message.runId === activeRun.id)
      ? activeRun.previewText
      : null;

  const timestamp = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  const latestConversationAt = Math.max(0,...detail.messages.map(message=>timestamp(message.createdAt)),...specialistHistory.filter(item=>!activeRun||item.runId!==activeRun.id).map(item=>timestamp(item.createdAt)),...(detail.questions??[]).filter(question=>question.answer!=null).map(question=>timestamp(question.createdAt)));
  const pendingQuestion = activeRun ? (detail.questions??[]).find(question=>question.runId===activeRun.id && question.answer==null) : undefined;
  // A resumed turn may retain an older question/run timestamp; new output stays after prior chat.
  const streamingAt = Math.max(latestConversationAt+2,timestamp(activeRun?.createdAt)+2,timestamp(pendingQuestion?.createdAt)-1);
  const pageEntries = detail.chat ? new Map(detail.chat.entries.map(entry => [entry.id, entry])) : null;
  const historyQuestions = (detail.questions ?? []).filter(question => !pageEntries || pageEntries.has(question.id));
  const liveQuestions = (detail.questions ?? []).filter(question => pageEntries && !pageEntries.has(question.id));
  const timeline = withRoutineActivity([
    ...detail.messages.map(message => ({ id: message.id, createdAt: message.createdAt, message, content: null as ReactNode })),
    ...specialistHistory.map(item => ({ ...item, createdAt: detail.runs.some(run => run.id === item.runId && run.messageVersion != null) ? item.createdAt : new Date(Math.max(timestamp(item.createdAt),
      ...(item.runId ? detail.messages.filter(message=>message.runId===item.runId && message.role==='assistant').map(message=>timestamp(message.createdAt)+1) : []),
      item.runId && item.runId===activeRun?.id ? streamingAt+1 : 0)).toISOString(), message: null })),
    ...detail.runs.filter(run => run.thinkingText && run.lane !== 'background').map(run => ({ id: 'thinking-' + run.id, createdAt: new Date(isActiveRun(run.status) ? streamingAt-1 : Math.max(timestamp(run.createdAt), ...detail.messages.filter(message=>message.role==='assistant' && message.runId===run.id).map(message=>timestamp(message.createdAt)-1))).toISOString(), message: null, content: <details className="thinking-panel" ><summary>{isActiveRun(run.status) ? 'Thinking' : 'Thought process'}</summary><div><MessageResponse>{run.thinkingText!}</MessageResponse></div></details> })),
    ...detail.runs.filter(run => (run.pluginCalls?.length || run.error?.startsWith('PLUGIN_')) && !lastAssistantByRun.has(run.id)).map(run => ({ id: 'plugins-' + run.id, createdAt: new Date(Math.max(timestamp(run.createdAt)+1, isActiveRun(run.status) ? streamingAt : 0)).toISOString(), message: null, content: <PluginCalls calls={run.pluginCalls} runError={run.error}/> })),
    ...(activePreview && activeRun ? [{ id: 'preview-' + activeRun.id, message: null, createdAt: new Date(streamingAt).toISOString(), content: <Message from="assistant" className="thread-message message-preview">
              <div className="thread-avatar" aria-hidden="true"><CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={32} /></div>
              <div className="thread-message-body"><div className="message-meta"><span className="message-author">{detail.companion.name}</span></div>
              <MessageContent className="thread-content"><MessageResponse>{activePreview}</MessageResponse></MessageContent></div>
            </Message> }] : []),
    ...historyQuestions.map(question => ({ id: question.id, createdAt: question.createdAt ?? detail.runs.find(run => run.id === question.runId)?.createdAt ?? '', message: null, content: <>
      {question.contextText && !detail.messages.some(message => message.runId === question.runId && message.content === question.contextText) && <div className="question-context"><MessageResponse>{question.contextText}</MessageResponse></div>}
      <RoutineProvenance run={runsById.get(question.runId)} onOpen={setRoutineRunIds}/>
      <Question companionId={detail.companion.id} question={question} onAnswered={onRefresh}/>
    </> })),
  ], { ...detail, runs: detail.runs.filter(run => !pageEntries || pageEntries.has(`routine-${run.id}`)) }, detail.chat?.entries, new Set(historyState.gaps.map(gap => gap.beforeId)));

  return (
    <section className="chat-column">
      {detail.companion.status === "preparing" && (
        <div className="state-banner state-banner--progress" role="status">
          <LoaderCircle className="spin" />
          <span><strong>Preparing {detail.companion.name}</strong><small>The chat is ready. Messages will wait safely while the computer starts.</small></span>
        </div>
      )}
      {detail.companion.status === "error" && (
        <div className="state-banner state-banner--error" role="alert">
          <CircleAlert />
          <span><strong>Preparation failed</strong><small>{detail.companion.error || "The Companion could not be prepared."}</small></span>
        </div>
      )}
      <ChatViewport key={historyState.resetReading ? 'reset' : 'saved'} resetReading={historyState.resetReading} storageKey={storageKey} entries={[...(detail.chat?.entries ?? []), ...liveQuestions.filter(question => question.cursor).map(question => ({ id: question.id, kind: 'question' as const, runId: question.runId, sequence: 0, cursor: question.cursor!, createdAt: question.createdAt! }))]} ready={!historyState.restoring} loading={historyState.loading} older={Boolean(historyState.older)} onOlder={onOlder} error={historyState.error} onRetry={onRetry} latestId={detail.messages.at(-1)?.id}>
          {timeline.length === 0 ? (
            <ConversationEmptyState className="chat-empty">
              <CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={72} />
              <h2>{specialistTemplateId ? "What should this specialist do?" : "A little less on your mind."}</h2>
              <p>{specialistTemplateId ? "Describe its role, then prepare its tools together." : `Make room for what matters. ${detail.companion.name} can help.`}</p>
              {!readOnly && !specialistTemplateId && <div className="chat-suggestions">{(specialistTemplateId ? ['Set up GitHub & Linear', 'Prepare my repositories', 'Help me test this specialist'] : ['Plan my day', 'Help with a project', 'Set up a routine']).map(prompt=><button type="button" key={prompt} onClick={()=>{composerRef.current?.suggest(prompt);}}>{prompt}<ChevronRight/></button>)}</div>}
            </ConversationEmptyState>
          ) : timeline.map(({id, message, content, routineRuns}) => <div className="chat-history-entry" key={id}>
            {historyState.gaps.filter(gap => gap.beforeId === id || routineRuns?.some(run => `routine-${run.id}` === gap.beforeId)).map(gap => <div className="chat-page-control" key={gap.after}><Button variant="outline" disabled={historyState.loading} onClick={() => onGap(gap.after)}>Load messages between these entries</Button></div>)}
            <div data-chat-id={id}>
            {routineRuns?.slice(1).map(run => <span key={run.id} data-chat-id={`routine-${run.id}`}/>)}
            {routineRuns ? <RoutineActivityRow key={id} runs={routineRuns} onOpen={setRoutineRunIds}/> : message ? (
            <Message from={message.role} key={message.id} className="thread-message">
              <div className="thread-avatar" aria-hidden="true">{message.role === "assistant" ? <CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={32} /> : <span className="user-avatar"><UserRound /></span>}</div>
              <div className="thread-message-body"><div className="message-meta"><span className="message-author">{message.role === "assistant" ? detail.companion.name : "You"}</span><time className="message-time" dateTime={message.createdAt}>{readableDate(message.createdAt)}</time>{message.complete === false && detail.runs.some(run => run.id === message.runId && !isActiveRun(run.status)) && <span className="message-time">Incomplete response</span>}</div>
              {message.role === "assistant" && <RoutineProvenance run={runsById.get(message.runId)} onOpen={setRoutineRunIds}/>}
              <MessageContent className="thread-content"><MessageResponse>{message.content}</MessageResponse></MessageContent>
              {message.role === "assistant" && lastAssistantByRun.get(message.runId) === message.id && <PluginCalls calls={runsById.get(message.runId)?.pluginCalls} runError={runsById.get(message.runId)?.error}/>}
              {message.files?.length ? <div className="message-files">{message.files.map((file) => <a key={file.id} href={file.url} target="_blank" rel="noreferrer"><FileText /><span>{file.name}</span></a>)}</div> : null}
              {message.role === "user" && <SpecialistsForRun detail={detail} runId={message.runId} onOpen={onOpenCompanion} />}
              </div>
            </Message>
          ) : <div className="conversation-action" key={id}>{content}</div>}</div></div>)}
          {[...new Map([...(detail.retainedRuns ?? []), ...(detail.live?.runs ?? [])].map(run => [run.id, run])).values()].filter(run => run.source === 'routine' && !run.hasPublishedMessage && !pageEntries?.has(`routine-${run.id}`)).map(run => <RoutineActivityRow key={`live-${run.id}`} runs={[run]} onOpen={setRoutineRunIds}/>)}
          {liveQuestions.map(question => <div key={question.id} data-chat-id={question.id}><Question companionId={detail.companion.id} question={question} onAnswered={onRefresh}/></div>)}
          {activeRun && !pendingQuestion && (
            <div className="working-row" role="status">
              <span className="working-dots"><i /><i /><i /></span>
              {activeRun.status === "queued" ? "Queued" : activeRun.status === "preparing" ? "Preparing" : activeRun.status === "needs_input" ? "Waiting for your answer" : activeRun.thinkingText && !activePreview ? "Thinking…" : `${detail.companion.name} is working`}
            </div>
          )}
          {specialistCards}
          {!readOnly && <SpecialistImprovements companionId={detail.companion.id} onOpenCompanion={onOpenCompanion}/>}
      </ChatViewport>
      {!!routineRuns.length && <RoutineRunSheet key={routineRunIds.join(":")} companionId={detail.companion.id} runs={routineRuns} onClose={() => setRoutineRunIds([])} onOpenRoutine={onOpenRoutine ? id => { setRoutineRunIds([]); onOpenRoutine(id); } : undefined}/>}
      {!readOnly && <ChatComposer ref={composerRef} detail={detail} onRefresh={onRefresh} onUnauthorized={onUnauthorized}/>}
    </section>
  );
});
