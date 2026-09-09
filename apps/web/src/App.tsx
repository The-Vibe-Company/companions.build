import {
  ArrowUp,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Computer,
  ExternalLink,
  FileText,
  LoaderCircle,
  Mail,
  Menu,
  PanelLeftClose,
  Paperclip,
  Plus,
  Trash2,
  UserRound,
  Waypoints,
  X,
} from "lucide-react";
import { DragEvent, FormEvent, type ReactNode, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { CompanionHeader, type CompanionSection } from "@/components/CompanionHeader";
import { ApplicationAccess } from "@/components/ApplicationAccess";
import { ConnectionCards } from "@/components/ConnectionCards";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  ApiError,
  type AppConfig,
  type AccountUser,
  type Companion,
  type CompanionDetail,
  type CompanionSkill,
  type CustomPluginInput,
  isActiveRun,
  type RunStatus,
  workspaceApi,
  type PluginAccount,
  type PluginServer,
} from "@/api";
import { Question } from "@/components/Question";
import { cn } from "@/lib/utils";
import { CompanionAvatar, DEFAULT_AVATAR, AVATAR_COLORS } from "@/components/CompanionAvatar";
import { AccountProduct, DesktopSheet } from "@/components/ProductPanels";
import { RoutineSettings, TriggerSettings } from "@/components/AutomationPanels";
import { RoutineActivityRow, RoutineProvenance, RoutineRunSheet, withRoutineActivity } from "@/components/RoutineChat";
const CreateCompanion = lazy(() => import("@/components/CreateCompanion").then(module => ({ default: module.CreateCompanion })));
const TaskActivity = lazy(() => import("@/components/TaskActivity").then(module => ({ default: module.TaskActivity })));
const SpecialistLibrary = lazy(() => import("@/components/SpecialistLibrary").then(module => ({ default: module.SpecialistLibrary })));
const SpecialistDraftPanel = lazy(() => import("@/components/SpecialistDraftPanel").then(module => ({ default: module.SpecialistDraftPanel })));
const TeamPanel = lazy(() => import("@/components/TeamPanel").then(module => ({ default: module.TeamPanel })));
const CreateTeamWizard = lazy(() => import("@/components/CreateTeamWizard").then(module => ({ default: module.CreateTeamWizard })));
import { ProviderMark } from "@/components/ProviderMark";
import { SettingsSheet, type SettingsSheetHandle } from "@/components/SettingsSheet";
import { SpecialistPreparation } from "@/components/SpecialistPreparation";
import { SpecialistImprovements } from "@/components/SpecialistImprovements";
import { LandingPage } from "@/components/LandingPage";
import { LegalPage, type LegalPageKind } from "@/components/LegalPage";

const LIST_INTERVAL = 8_000;
const MAX_CHAT_FILES = 5;
const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;

function selectedIdFromPath() {
  return window.location.pathname.match(/^\/companions\/([^/]+)$/)?.[1] ?? null;
}

function legalPageFromPath(pathname = window.location.pathname): LegalPageKind | null {
  if (/^\/privacy\/?$/.test(pathname)) return "privacy";
  if (/^\/terms\/?$/.test(pathname)) return "terms";
  return null;
}

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

function AccessGate() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const localInbox = useMemo(() => {
    if (!["127.0.0.1", "localhost"].includes(window.location.hostname)) return null;
    const port = Number(window.location.port || (window.location.protocol === "https:" ? 443 : 80));
    return `${window.location.protocol}//${window.location.hostname}:${port + 6}`;
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api.requestMagicLink(email.trim());
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="access-page">
      <form className="access-form" onSubmit={submit}>
        <div className="signin-mark" aria-hidden="true"><CompanionAvatar name="companions.build" avatar={{ shape: 6, color: 7, face: 1 }} size={76} /></div>
        <div className="wordmark wordmark--center">companions.build</div>
        {sent ? <div className="signin-sent" role="status">
          <h1>Check your inbox</h1>
          <p>We sent a sign-in link to <strong>{email.trim()}</strong>.</p>
          {localInbox && <a className="inbox-link" href={localInbox} target="_blank" rel="noreferrer"><Mail />Open local inbox</a>}
          <button type="button" className="text-button" onClick={() => setSent(false)}>Use another email</button>
        </div> : <>
          <div className="signin-copy"><h1>Your Companions,<br />ready when you are.</h1><p>Sign in with a private link. No password to remember.</p></div>
          <label htmlFor="signin-email">Email</label>
          <input id="signin-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" aria-describedby={error ? "access-error" : undefined} aria-invalid={Boolean(error)} autoFocus />
          {error && <p className="field-error" id="access-error">{error}</p>}
          <Button type="submit" disabled={!email.trim() || submitting}>{submitting ? <LoaderCircle className="spin" /> : <Mail />}Email me a sign-in link</Button>
        </>}
      </form>
    </main>
  );
}

function Sidebar({
  companions,
  selectedId,
  onSelect,
  onCreate,
  onCreateTeam,
  onNavigate,
  user,
  open,
  onClose,
  currentPath,
  locked = false,
}: {
  locked?: boolean;
  currentPath: string;
  companions: Companion[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onCreateTeam: () => void;
  onNavigate: (path: string) => void;
  user: AccountUser;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {open && <button className="sidebar-scrim" onClick={onClose} aria-label="Close navigation" />}
      <aside className={cn("sidebar", open && "sidebar--open")} aria-label="Companions" inert={locked || undefined}>
        <div className="sidebar-header">
          <button className="wordmark wordmark-button" aria-label="companions.build home" onClick={() => onNavigate("/")}>c.</button>
          <Button variant="ghost" size="icon" className="sidebar-close" onClick={onClose} aria-label="Close navigation"><PanelLeftClose /></Button>
        </div>
        <nav className="companion-list">
          {companions.map((companion) => (
            <button
              key={companion.id}
              className={cn("companion-link", selectedId === companion.id && "companion-link--active")}
              title={companion.name}
              aria-label={`${companion.name}, Companion · ${statusLabel(companion.status)}`}
              style={{ "--companion-color": AVATAR_COLORS[companion.avatar?.color ?? DEFAULT_AVATAR.color] } as React.CSSProperties}
              onClick={() => onSelect(companion.id)}
              aria-current={selectedId === companion.id ? "page" : undefined}
            >
              <span className="rail-character"><CompanionAvatar name={companion.name} avatar={companion.avatar} sleeping={companion.status === "archived"} size={36} /><StatusDot status={companion.status} /></span>
              <span className="companion-link-copy">
                <strong>{companion.name}</strong>
                <small>{statusLabel(companion.status)}</small>
              </span>
              <ChevronRight className="companion-chevron" />
            </button>
          ))}
        </nav>
        <div className="rail-create"><details className="create-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}><summary aria-label="Create"><Plus /></summary><div className="create-popover"><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onCreate(); }}>New Companion</button><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onCreateTeam(); }}>Create a team</button></div></details></div>
        <nav className="rail-library" aria-label="Workspace"><button aria-current={currentPath === "/specialists" ? "page" : undefined} onClick={() => onNavigate("/specialists")}><svg viewBox="0 0 60 44" className="rail-specialists-mark" aria-hidden="true"><path d="M18 4a14 14 0 1 0 0 28a14 14 0 1 0 0-28Z" fill="var(--background)" stroke="#242622" strokeWidth="3"/><path d="M30 8h22a6 6 0 0 1 6 6v18a6 6 0 0 1-6 6H30Z" fill="var(--background)" stroke="#242622" strokeWidth="3"/><g fill="#242622"><circle cx="14" cy="17" r="2.2"/><circle cx="22" cy="17" r="2.2"/><circle cx="39" cy="21" r="2.2"/><circle cx="49" cy="21" r="2.2"/></g></svg><span>Specialists</span></button><button aria-current={currentPath === "/connections" ? "page" : undefined} onClick={() => onNavigate("/connections")}><svg className="rail-apps-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg><span>Apps</span></button></nav>
        <details className="account-menu" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))event.currentTarget.open=false;}} onKeyDown={event=>{if(event.key==='Escape'){event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}>
          <summary aria-label="Your account"><span className="account-initial">{user.email.slice(0,1).toUpperCase()}</span><span className="sr-only">Your account</span></summary>
          <div className="account-popover"><p>{user.email}</p><button onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');onNavigate('/connections');}}><Waypoints/>Connections</button><button onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');onNavigate('/account');}}><UserRound/>Account & subscription</button></div>
        </details>
      </aside>
    </>
  );
}

function Chat({ detail, onRefresh, onUnauthorized, onOpenCompanion, specialistTemplateId, specialistCards, specialistHistory = [], readOnly = false, onOpenRoutine }: { onOpenRoutine?: (id: string) => void; detail: CompanionDetail; onRefresh: () => Promise<void>; onUnauthorized: () => void; onOpenCompanion: (id: string) => void; specialistTemplateId?: string | null; specialistCards?: ReactNode; specialistHistory?: Array<{id:string;runId?:string;createdAt:string;content:ReactNode}>; readOnly?: boolean }) {
  const [draft, setDraft] = useState("");
  const [routineRunIds, setRoutineRunIds] = useState<string[]>([]);
  const routineRuns = detail.runs.filter(run => routineRunIds.includes(run.id));
  const runsById = new Map(detail.runs.map(run => [run.id, run]));
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [fileNotice, setFileNotice] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [skills, setSkills] = useState<CompanionSkill[]>([]);
  const [skillCommandsEnabled, setSkillCommandsEnabled] = useState<boolean | null>(null);
  const [skillsUnavailable, setSkillsUnavailable] = useState(false);
  const [commandToken, setCommandToken] = useState<{ start: number; end: number; query: string } | null>(null);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suppressCommandDetection = useRef(false);
  const skillsCompanion = useRef<string | null>(null);
  const skillsRequest = useRef(0);
  const activeCommandStart = useRef<number | null>(null);
  const dragDepth = useRef(0);
  const activeRun = detail.runs.find((run) => run.lane !== "background" && isActiveRun(run.status));
  const visibleSkills = commandToken
    ? skills.filter(skill => skill.name.toLocaleLowerCase().includes(commandToken.query.toLocaleLowerCase().replace(/^skill:/, "")))
    : [];
  const paletteOpen = Boolean(commandToken && skillCommandsEnabled !== false);
  const activeSkill = visibleSkills[Math.min(activeSkillIndex, Math.max(visibleSkills.length - 1, 0))];

  useEffect(() => {
    if (!paletteOpen || !activeSkill) return;
    document.getElementById(`skill-option-${detail.companion.id}-${Math.min(activeSkillIndex, visibleSkills.length - 1)}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeSkill, activeSkillIndex, detail.companion.id, paletteOpen, visibleSkills.length]);

  useEffect(() => {
    skillsCompanion.current = null;
    skillsRequest.current += 1;
    activeCommandStart.current = null;
    setSkills([]);
    setSkillCommandsEnabled(null);
    setSkillsUnavailable(false);
  }, [detail.companion.id]);

  function discoverSkills() {
    const companionId = detail.companion.id;
    skillsCompanion.current = companionId;
    const request = ++skillsRequest.current;
    setSkills([]);
    setSkillsUnavailable(false);
    setSkillCommandsEnabled(null);
    void api.getCompanionSkills(companionId).then(result => {
      if (request !== skillsRequest.current || skillsCompanion.current !== companionId) return;
      setSkills(result.skills);
      setSkillCommandsEnabled(result.enabled);
    }).catch(() => {
      if (request !== skillsRequest.current || skillsCompanion.current !== companionId) return;
      setSkillsUnavailable(true);
      setSkillCommandsEnabled(true);
    });
  }

  function findCommandToken(value: string, caret: number | null) {
    if (caret == null) return null;
    const separator = /[\s,;!?()[\]{}<>"'`]/;
    let start = caret - 1;
    while (start >= 0 && !separator.test(value[start]) && value[start] !== "/") start -= 1;
    if (start < 0 || value[start] !== "/") return null;
    let end = caret;
    while (end < value.length && !separator.test(value[end])) end += 1;
    return { start, end, query: value.slice(start + 1, end) };
  }

  function updateCommandToken(value: string, caret: number | null) {
    const token = findCommandToken(value, caret);
    setCommandToken(token);
    if (token && activeCommandStart.current !== token.start) discoverSkills();
    activeCommandStart.current = token?.start ?? null;
    setActiveSkillIndex(0);
  }

  function insertSkill(skill: CompanionSkill) {
    if (!commandToken) return;
    const command = `/skill:${skill.name}`;
    const nextDraft = draft.slice(0, commandToken.start) + command + draft.slice(commandToken.end);
    const nextCaret = commandToken.start + command.length;
    setDraft(nextDraft);
    setCommandToken(null);
    activeCommandStart.current = null;
    suppressCommandDetection.current = true;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
      suppressCommandDetection.current = false;
    });
  }
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
  const timeline = withRoutineActivity([
    ...detail.messages.map(message => ({ id: message.id, createdAt: message.createdAt, message, content: null as ReactNode })),
    ...specialistHistory.map(item => ({ ...item, createdAt: detail.runs.some(run => run.id === item.runId && run.messageVersion != null) ? item.createdAt : new Date(Math.max(timestamp(item.createdAt),
      ...(item.runId ? detail.messages.filter(message=>message.runId===item.runId && message.role==='assistant').map(message=>timestamp(message.createdAt)+1) : []),
      item.runId && item.runId===activeRun?.id ? streamingAt+1 : 0)).toISOString(), message: null })),
    ...detail.runs.filter(run => run.thinkingText && run.lane !== 'background').map(run => ({ id: 'thinking-' + run.id, createdAt: new Date(isActiveRun(run.status) ? streamingAt-1 : Math.max(timestamp(run.createdAt), ...detail.messages.filter(message=>message.role==='assistant' && message.runId===run.id).map(message=>timestamp(message.createdAt)-1))).toISOString(), message: null, content: <details className="thinking-panel" ><summary>{isActiveRun(run.status) ? 'Thinking' : 'Thought process'}</summary><div><MessageResponse>{run.thinkingText!}</MessageResponse></div></details> })),
    ...(activePreview && activeRun ? [{ id: 'preview-' + activeRun.id, message: null, createdAt: new Date(streamingAt).toISOString(), content: <Message from="assistant" className="thread-message message-preview">
              <div className="thread-avatar" aria-hidden="true"><CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={32} /></div>
              <div className="thread-message-body"><div className="message-meta"><span className="message-author">{detail.companion.name}</span></div>
              <MessageContent className="thread-content"><MessageResponse>{activePreview}</MessageResponse></MessageContent></div>
            </Message> }] : []),
    ...(detail.questions ?? []).map(question => ({ id: question.id, createdAt: question.createdAt ?? detail.runs.find(run => run.id === question.runId)?.createdAt ?? '', message: null, content: <>
      {question.contextText && !detail.messages.some(message => message.runId === question.runId && message.content === question.contextText) && <div className="question-context"><MessageResponse>{question.contextText}</MessageResponse></div>}
      <RoutineProvenance run={runsById.get(question.runId)} onOpen={setRoutineRunIds}/>
      <Question companionId={detail.companion.id} question={question} onAnswered={onRefresh}/>
    </> })),
  ], detail);

  async function send(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setActionError("");
    try {
      await api.sendMessage(detail.companion.id, content, files);
      setDraft("");
      setCommandToken(null);
      activeCommandStart.current = null;
      setFiles([]);
      setFileNotice("");
      await onRefresh();
      textareaRef.current?.focus();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setActionError(cause instanceof Error ? cause.message : "Could not send message");
    } finally {
      setSending(false);
    }
  }

  function addFiles(incoming: File[]) {
    if (!incoming.length) return;
    if (files.length + incoming.length > MAX_CHAT_FILES) {
      setActionError(`A message accepts at most ${MAX_CHAT_FILES} files.`); setFileNotice(""); return;
    }
    if (incoming.some(file => file.size < 1 || file.size > MAX_CHAT_FILE_BYTES)) {
      setActionError("Each file must be between 1 byte and 10 MB."); setFileNotice(""); return;
    }
    setFiles(current => [...current, ...incoming]); setActionError("");
    setFileNotice(`${incoming.length} ${incoming.length === 1 ? "file" : "files"} attached.`);
  }

  function carriesFiles(event: DragEvent) { return Array.from(event.dataTransfer.types).includes("Files"); }
  function dragEnter(event: DragEvent<HTMLFormElement>) { if (!carriesFiles(event)) return; event.preventDefault(); dragDepth.current += 1; setDragActive(true); setFileNotice(`Drop up to ${MAX_CHAT_FILES} files here.`); }
  function dragOver(event: DragEvent<HTMLFormElement>) { if (!carriesFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
  function dragLeave(event: DragEvent<HTMLFormElement>) { if (!dragDepth.current) return; event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) { setDragActive(false); setFileNotice(""); } }
  function drop(event: DragEvent<HTMLFormElement>) { if (!carriesFiles(event)) return; event.preventDefault(); dragDepth.current = 0; setDragActive(false); addFiles(Array.from(event.dataTransfer.files)); }

  async function cancel() {
    setActionError("");
    try {
      await api.cancel(detail.companion.id);
      await onRefresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not cancel work");
    }
  }

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
      <Conversation className="conversation">
        <ConversationContent className="conversation-content">
          {timeline.length === 0 ? (
            <ConversationEmptyState className="chat-empty">
              <CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={72} />
              <h2>{specialistTemplateId ? "What should this specialist do?" : "A little less on your mind."}</h2>
              <p>{specialistTemplateId ? "Describe its role, then prepare its tools together." : `Make room for what matters. ${detail.companion.name} can help.`}</p>
              {!readOnly && !specialistTemplateId && <div className="chat-suggestions">{(specialistTemplateId ? ['Set up GitHub & Linear', 'Prepare my repositories', 'Help me test this specialist'] : ['Plan my day', 'Help with a project', 'Set up a routine']).map(prompt=><button type="button" key={prompt} onClick={()=>{setDraft(prompt);textareaRef.current?.focus();}}>{prompt}<ChevronRight/></button>)}</div>}
            </ConversationEmptyState>
          ) : timeline.map(({id, message, content, routineRuns}) => routineRuns ? <RoutineActivityRow key={id} runs={routineRuns} onOpen={setRoutineRunIds}/> : message ? (
            <Message from={message.role} key={message.id} className="thread-message">
              <div className="thread-avatar" aria-hidden="true">{message.role === "assistant" ? <CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={32} /> : <span className="user-avatar"><UserRound /></span>}</div>
              <div className="thread-message-body"><div className="message-meta"><span className="message-author">{message.role === "assistant" ? detail.companion.name : "You"}</span><time className="message-time" dateTime={message.createdAt}>{readableDate(message.createdAt)}</time>{message.complete === false && detail.runs.some(run => run.id === message.runId && !isActiveRun(run.status)) && <span className="message-time">Incomplete response</span>}</div>
              {message.role === "assistant" && <RoutineProvenance run={runsById.get(message.runId)} onOpen={setRoutineRunIds}/>}
              <MessageContent className="thread-content"><MessageResponse>{message.content}</MessageResponse></MessageContent>
              {message.files?.length ? <div className="message-files">{message.files.map((file) => <a key={file.id} href={file.url} target="_blank" rel="noreferrer"><FileText /><span>{file.name}</span></a>)}</div> : null}
              {message.role === "user" && <SpecialistsForRun detail={detail} runId={message.runId} onOpen={onOpenCompanion} />}
              </div>
            </Message>
          ) : <div className="conversation-action" key={id}>{content}</div>)}
          {activeRun && !pendingQuestion && (
            <div className="working-row" role="status">
              <span className="working-dots"><i /><i /><i /></span>
              {activeRun.status === "queued" ? "Queued" : activeRun.status === "preparing" ? "Preparing" : activeRun.status === "needs_input" ? "Waiting for your answer" : activeRun.thinkingText && !activePreview ? "Thinking…" : `${detail.companion.name} is working`}
            </div>
          )}
          {specialistCards}
          {!readOnly && <SpecialistImprovements companionId={detail.companion.id} onOpenCompanion={onOpenCompanion}/>}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest message" latestMessageId={detail.messages.at(-1)?.id} />
      </Conversation>
      {!!routineRuns.length && <RoutineRunSheet key={routineRunIds.join(":")} companionId={detail.companion.id} runs={routineRuns} onClose={() => setRoutineRunIds([])} onOpenRoutine={onOpenRoutine ? id => { setRoutineRunIds([]); onOpenRoutine(id); } : undefined}/>}
      {!readOnly && <form className={cn("composer-wrap", dragActive && "composer-wrap--drop")} onSubmit={send} onDragEnter={dragEnter} onDragOver={dragOver} onDragLeave={dragLeave} onDrop={drop}>
        <span className="sr-only" aria-live="polite">{fileNotice}</span>
        {actionError && <p className="composer-error" role="alert">{actionError}</p>}
        {files.length > 0 && <div className="pending-files">{files.map((file, index) => <span key={`${file.name}-${file.lastModified}`}><FileText />{file.name}<button type="button" onClick={() => setFiles((current) => current.filter((_, item) => item !== index))} aria-label={`Remove ${file.name}`}><X /></button></span>)}</div>}
        <div className="composer">
          {dragActive && <div className="drop-indicator" aria-hidden="true"><Paperclip />Drop files here</div>}
          {paletteOpen && <div className="skill-palette" role="listbox" id={`skill-palette-${detail.companion.id}`} aria-label="Skills">
            {skillCommandsEnabled == null ? <p role="status">Loading skills…</p>
              : skillsUnavailable ? <p>Skills are unavailable. You can still send your message.</p>
              : skills.length === 0 ? <p>No skills available.</p>
              : visibleSkills.length === 0 ? <p>No matching skills.</p>
              : visibleSkills.map((skill, index) => <button
                type="button"
                role="option"
                id={`skill-option-${detail.companion.id}-${index}`}
                aria-selected={index === activeSkillIndex}
                className={cn(index === activeSkillIndex && "skill-option--active")}
                key={skill.name}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setActiveSkillIndex(index)}
                onClick={() => insertSkill(skill)}
              >
                <span><strong>/skill:{skill.name}</strong>{skill.source && <small>{skill.source}</small>}</span>
                {skill.description && <p>{skill.description}</p>}
              </button>)}
          </div>}
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => { setDraft(event.target.value); updateCommandToken(event.target.value, event.target.selectionStart); }}
            onClick={(event) => updateCommandToken(event.currentTarget.value, event.currentTarget.selectionStart)}
            onSelect={(event) => { if (!suppressCommandDetection.current) updateCommandToken(event.currentTarget.value, event.currentTarget.selectionStart); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (paletteOpen && event.key === "Escape") {
                event.preventDefault();
                setCommandToken(null);
                activeCommandStart.current = null;
                return;
              }
              if (paletteOpen && visibleSkills.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                setActiveSkillIndex(current => event.key === "ArrowDown"
                  ? (current + 1) % visibleSkills.length
                  : (current - 1 + visibleSkills.length) % visibleSkills.length);
                return;
              }
              if (paletteOpen && event.key === "Enter") {
                event.preventDefault();
                if (activeSkill) insertSkill(activeSkill);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={`Message ${detail.companion.name}`}
            aria-label={`Message ${detail.companion.name}`}
            aria-autocomplete="list"
            aria-expanded={paletteOpen}
            aria-controls={paletteOpen ? `skill-palette-${detail.companion.id}` : undefined}
            aria-activedescendant={paletteOpen && activeSkill ? `skill-option-${detail.companion.id}-${Math.min(activeSkillIndex, visibleSkills.length - 1)}` : undefined}
            rows={2}
          />
          <div className="composer-actions">
            <span className="composer-hint">Enter to send · Shift + Enter for a new line</span>
            <div className="composer-buttons">
              <label className="attach-button" aria-label="Attach files"><Plus /><input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,text/markdown,application/json,.md,.markdown,.txt,.csv,.json" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} /></label>
              {(activeRun || (actionError && api.hasPendingUpload(detail.companion.id))) && (
                <Button type="button" variant="outline" size="sm" onClick={cancel}><CircleStop />Cancel</Button>
              )}
              <Button type="submit" size="icon" disabled={!draft.trim() || sending} aria-label="Send message">
                {sending ? <LoaderCircle className="spin" /> : <ArrowUp />}
              </Button>
            </div>
          </div>
        </div>
      </form>}
    </section>
  );
}

type NavigationGuard = (action: () => void, updateHistory?: boolean) => boolean;

function CompanionView({ detail, models, onRefresh, onUnauthorized, onMenu, onOpenCompanion, onDeleted, onRegisterNavigationGuard, onLocationChange, refreshVersion, onNavigate }: { onNavigate: (path: string) => void; detail: CompanionDetail; models: Array<{ id: string; name: string }>; onDeleted: (ids: string[]) => void; onRefresh: () => Promise<void>; onUnauthorized: () => void; onMenu: () => void; onOpenCompanion: (id: string) => void; onRegisterNavigationGuard: (guard: NavigationGuard | null) => void; onLocationChange: (location: string) => void; refreshVersion: number }) {
  const finished = Boolean(detail.companion.retiredAt);
  const specialistTemplateId = new URLSearchParams(window.location.search).get("specialist");
  const readView = (): CompanionSection => {
    const value = new URLSearchParams(window.location.search).get('view');
    if (finished) return value === 'activity' ? value : 'chat';
    if (value === 'computer' && detail.companion.provider !== 'box') return 'chat';
    return value === 'team' || value === 'automations' || value === 'activity' || value === 'computer' || value === 'applications' || value === 'settings' ? value : 'chat';
  };
  const [view, setView] = useState(readView);
  const [routineTarget, setRoutineTarget] = useState<string | undefined>();
  const [settingsVisited, setSettingsVisited] = useState(() => readView() === 'settings');
  const settingsRef = useRef<SettingsSheetHandle>(null);
  useEffect(() => { const restore = () => { const restoredView = readView(); setView(restoredView); if (restoredView === 'settings') setSettingsVisited(true); }; window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore); }, []);
  function changeView(next: CompanionSection) {
    const url = new URL(window.location.href);
    if (next === 'chat') url.searchParams.delete('view'); else url.searchParams.set('view', next);
    url.searchParams.delete('kind');
    if (url.pathname + url.search !== window.location.pathname + window.location.search) window.history.pushState({}, '', url.pathname + url.search);
    onLocationChange(url.pathname + url.search);
    if (next === 'settings') setSettingsVisited(true);
    setView(next);
  }
  useEffect(() => {
    onRegisterNavigationGuard((action, updateHistory = true) => {
      if (!settingsRef.current) { action(); return false; }
      const held = settingsRef.current.requestLeave(action);
      if (held) {
        setSettingsVisited(true);
        setView('settings');
        if (updateHistory) changeView('settings');
      }
      return held;
    });
    return () => onRegisterNavigationGuard(null);
  }, [onRegisterNavigationGuard]);

  if (specialistTemplateId && !finished && ['new', 'preparing'].includes(detail.companion.status)) return <main className="workspace" id="main-content"><SpecialistPreparation companionId={detail.companion.id} onReady={() => void onRefresh()} onBack={() => onNavigate('/specialists')}/></main>;

  return (
    <main className="workspace" id="main-content">
      {(!specialistTemplateId || finished || view !== "chat") && <CompanionHeader detail={detail} section={view} refreshVersion={refreshVersion} onSection={changeView} onMenu={onMenu} />}
      <div className="workspace-body" hidden={view !== 'chat'}>
        {specialistTemplateId && !finished ? <Suspense fallback={<div role="status">Opening specialist…</div>}><SpecialistDraftPanel templateId={specialistTemplateId} companionId={detail.companion.id} avatar={detail.companion.avatar ?? undefined} onClose={() => onNavigate('/specialists')} onComputer={detail.companion.provider === 'box' ? () => changeView('computer') : undefined} onOpenCompanion={onOpenCompanion} onContinued={onRefresh} renderChat={(cards, history) => <Chat detail={detail} onRefresh={onRefresh} onUnauthorized={onUnauthorized} onOpenCompanion={onOpenCompanion} specialistTemplateId={specialistTemplateId} specialistCards={cards} specialistHistory={history}/>} /></Suspense> : <Chat detail={detail} onRefresh={onRefresh} onUnauthorized={onUnauthorized} onOpenCompanion={onOpenCompanion} readOnly={finished} onOpenRoutine={finished ? undefined : id => { setRoutineTarget(id); changeView("automations"); }}/>}
      </div>
      {!finished && view === 'automations' && <section className="companion-page" aria-label="Automations"><div className="companion-page-inner"><header className="section-intro"><h2>A little help, on repeat.</h2><p>Set the timing. Your companion takes it from there.</p></header><div className="automation-group"><RoutineSettings companionId={detail.companion.id} initialRoutineId={routineTarget}/></div><div className="automation-group" id="events"><TriggerSettings companionId={detail.companion.id}/></div></div></section>}
      {!finished && view === 'team' && <section className="companion-page" aria-label="Team"><Suspense fallback={<div className="companion-page-inner" role="status">Opening your team…</div>}><TeamPanel onOpenDraft={(companionId, templateId) => onNavigate(`/companions/${companionId}?specialist=${encodeURIComponent(templateId)}`)} companion={detail.companion} refreshVersion={refreshVersion} onOpenCompanion={onOpenCompanion}/></Suspense></section>}
      {view === 'activity' && <section className="companion-page" aria-label="Activity"><Suspense fallback={<div className="companion-page-inner" role="status">Opening activity…</div>}><TaskActivity companion={detail.companion} refreshVersion={refreshVersion} specialists={detail.specialists} onOpenCompanion={onOpenCompanion} onOpenDiscussion={() => changeView('chat')} /></Suspense></section>}
      {!finished && view === 'computer' && <section className="companion-page" aria-label="Computer"><DesktopSheet embedded companion={detail.companion} onClose={() => changeView('chat')} onRefresh={onRefresh} /></section>}
      {!finished && view === 'applications' && <section className="companion-page" aria-label="Applications"><div className="companion-page-inner"><header className="section-intro"><h2>Applications</h2><p>Choose which connected accounts {detail.companion.name} can use.</p></header><ApplicationAccess key={detail.companion.id} companionId={detail.companion.id} onConnect={() => onNavigate("/connections")} /></div></section>}
      {!finished && settingsVisited && <div className="companion-page" hidden={view !== 'settings'}><SettingsSheet ref={settingsRef} embedded active={view === 'settings'} detail={detail} models={models} onClose={() => changeView('chat')} onSaved={onRefresh} onDeleted={onDeleted} connections={view === "settings" ? <ApplicationAccess key={detail.companion.id} companionId={detail.companion.id} onConnect={() => onNavigate("/connections")} /> : null} onActivity={() => changeView('activity')} onDesktop={() => changeView('computer')} /></div>}
    </main>
  );
}

function Home({ companions, onSelect, onCreate, onCreateTeam, onMenu }: { companions: Companion[]; onSelect: (id: string) => void; onCreate: () => void; onCreateTeam: () => void; onMenu: () => void }) {
  return <main className="home-page" id="main-content">
    <header className="mobile-page-header"><Button variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button><span className="wordmark">companions.build</span></header>
    <div className="home-inner"><div className="home-heading"><div><h1>Your companions.</h1><p>Pick up where you left off.</p></div><div className="home-create-actions"><Button variant="ghost" onClick={onCreateTeam}>Create a team</Button><Button onClick={onCreate}><Plus />New Companion</Button></div></div>
      <div className="home-list">{companions.map((companion) => <button key={companion.id} className="home-companion" onClick={() => onSelect(companion.id)}>
        <CompanionAvatar name={companion.name} avatar={companion.avatar} size={62} />
        <span><strong>{companion.name}</strong><small>{companion.instructions}</small><em><StatusDot status={companion.status} />{statusLabel(companion.status)}</em></span><ChevronRight />
      </button>)}</div>
    </div>
  </main>;
}

function AccountPage({ user, onSignOut, onMenu }: { user: AccountUser; onSignOut: () => Promise<void>; onMenu: () => void }) {
  return <main className="simple-page" id="main-content"><header className="mobile-page-header"><Button variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button><span className="wordmark">companions.build</span></header><div className="simple-inner account-inner"><h1>Account</h1><AccountProduct user={user} onSignOut={onSignOut} /></div></main>;
}

function ConnectionsPage({ onMenu }: { onMenu: () => void }) {
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [catalog, setCatalog] = useState<PluginServer[]>([]); const [accounts, setAccounts] = useState<PluginAccount[]>([]); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(""); const [namingServer,setNamingServer]=useState<PluginServer|null>(null); const [customOpen, setCustomOpen] = useState(false); const [label, setLabel] = useState(""); const [transport, setTransport] = useState<"http" | "stdio">("http"); const [url, setUrl] = useState(""); const [command, setCommand] = useState(""); const [args, setArgs] = useState(""); const [secrets, setSecrets] = useState<Array<{ key: string; value: string }>>([]); const oauthPopup = useRef<Window | null>(null); const oauthWatch=useRef<number|null>(null);
  const load = useCallback(() => workspaceApi.plugins().then((result) => { setCatalog(result.catalog); setAccounts(result.accounts); }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load connections")).finally(() => setConnectionsLoading(false)), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const completion=new URLSearchParams(window.location.search).get("connection");
    if(!["connected","cancelled","error"].includes(completion??""))return;
    if(window.opener&&window.opener!==window){window.opener.postMessage({type:"companions:plugin-oauth",status:completion},window.location.origin);window.close();return;}
    window.history.replaceState({},"","/connections");
    if(completion==="connected")setNotice("Connection added.");else if(completion==="cancelled")setNotice("Connection cancelled.");else setError("Connection could not be completed. Try again.");
  },[]);
  useEffect(()=>{
    const complete=(event:MessageEvent)=>{
      if(event.origin!==window.location.origin||event.source!==oauthPopup.current||event.data?.type!=="companions:plugin-oauth")return;
      if(oauthWatch.current!==null)window.clearInterval(oauthWatch.current);oauthWatch.current=null;oauthPopup.current=null;setBusy("");setError("");setNotice("");
      if(event.data.status==="connected"){setNotice("Connection added.");void load();}
      else if(event.data.status==="cancelled")setNotice("Connection cancelled.");
      else setError("Connection could not be completed. Try again.");
    };
    window.addEventListener("message",complete);return()=>{window.removeEventListener("message",complete);if(oauthWatch.current!==null)window.clearInterval(oauthWatch.current);};
  },[load]);
  async function connect(server: PluginServer,accountName="") { if(!server.available)return false;setError("");setNotice("");setBusy(server.id);const popup=window.open("about:blank","companions-plugin-oauth","popup,width=620,height=760");oauthPopup.current=popup;if(popup)oauthWatch.current=window.setInterval(()=>{if(!popup.closed)return;if(oauthWatch.current!==null)window.clearInterval(oauthWatch.current);oauthWatch.current=null;oauthPopup.current=null;setBusy("");setNotice("Connection window closed.");},500);try { const result = await workspaceApi.connectPlugin(server.id, accountName); if (result.url) {if(popup&&!popup.closed)popup.location.href=result.url;else window.location.assign(result.url);} else {if(oauthWatch.current!==null)window.clearInterval(oauthWatch.current);oauthWatch.current=null;popup?.close();oauthPopup.current=null;setBusy("");await load();} return true;} catch (cause) { if(oauthWatch.current!==null)window.clearInterval(oauthWatch.current);oauthWatch.current=null;popup?.close();oauthPopup.current=null;setBusy("");setError(cause instanceof Error ? cause.message : "Could not connect account");return false; } }
  function requestConnection(server:PluginServer){if(accounts.some(account=>account.serverId===server.id)){setNamingServer(server);setError("");setNotice("");return;}void connect(server);}
  async function rename(account:PluginAccount,accountName:string){setError("");setNotice("");setBusy(account.id);try{const result=await workspaceApi.renamePlugin(account.id,accountName);setAccounts(current=>current.map(item=>item.id===account.id?{...item,...result.account}:item));setNotice(`${result.account.label} saved.`);return true;}catch(cause){setError(cause instanceof Error?cause.message:"Could not rename account");return false;}finally{setBusy("");}}
  async function disconnect(account:PluginAccount){setError("");setNotice("");setBusy(account.id);try{await workspaceApi.deletePlugin(account.id);await load();setNotice("Connection removed.");}catch(cause){setError(cause instanceof Error?cause.message:"Could not remove connection");}finally{setBusy("");}}
  async function check(account:PluginAccount){setError("");setNotice("");setBusy(account.id);try{const result=await workspaceApi.checkPlugin(account.id);setAccounts(current=>current.map(item=>item.id===account.id?{...item,...result.account}:item));setNotice(`${account.label}: ${healthText({...account,...result.account})}.`);}catch(cause){setError(cause instanceof Error?cause.message:"Could not check connection");}finally{setBusy("");}}
  function healthText(account:PluginAccount){
    if(account.provider==="custom"||account.healthStatus==="requires_agent")return"Checked inside a Companion when used";
    if(account.healthStatus==="unchecked")return"Not checked yet";
    const date=account.checkedAt?` · ${readableDate(account.checkedAt)}`:"";
    if(account.healthStatus==="ok")return`Connection ready${date}`;
    if(account.healthCode==="authorization_required")return`Authorization needed${date}`;
    if(account.healthCode==="configuration_invalid")return`Connection needs attention${date}`;
    return`Service could not be reached${date}`;
  }
  function updateSecret(index: number, field: "key" | "value", value: string) { setSecrets(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item)); }
  async function addCustom(event: FormEvent) {
    event.preventDefault(); setError("");
    const values = Object.fromEntries(secrets.filter(item => item.key.trim()).map(item => [item.key.trim(), item.value]));
    const input: CustomPluginInput = transport === "http"
      ? { label: label.trim(), transport, url: url.trim(), headers: values }
      : { label: label.trim(), transport, command: command.trim(), args: args.split("\n").map(value => value.trim()).filter(Boolean), env: values };
    try { await workspaceApi.addCustomPlugin(input); setLabel(""); setUrl(""); setCommand(""); setArgs(""); setSecrets([]); setTransport("http"); setCustomOpen(false); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add MCP server"); }
  }
  return <main className="simple-page" id="main-content"><header className="mobile-page-header"><Button variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button><span className="wordmark">companions.build</span></header><div className="simple-inner connections-inner"><div className="page-title-row"><div><h1>Apps</h1><p className="muted-copy">Your accounts, and the companions allowed to use them.</p></div><Button variant="ghost" aria-expanded={customOpen} onClick={() => setCustomOpen((value) => !value)}>Custom MCP server <span aria-hidden="true">→</span></Button></div>
    {error && <p className="field-error" role="alert">{error}</p>}{notice&&<p className="connection-notice" role="status">{notice}</p>}
    {customOpen && <form className="custom-connection" onSubmit={addCustom}>
      <div className="custom-connection-main"><div className="field"><label htmlFor="custom-label">Name</label><input id="custom-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Internal tools" /></div><div className="field"><label htmlFor="custom-transport">Transport</label><select id="custom-transport" value={transport} onChange={event => { setTransport(event.target.value as "http" | "stdio"); setSecrets([]); }}><option value="http">Remote HTTP</option><option value="stdio">Local stdio</option></select></div>{transport === "http" ? <div className="field custom-endpoint"><label htmlFor="custom-url">Server URL</label><input id="custom-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" /></div> : <><div className="field custom-endpoint"><label htmlFor="custom-command">Command</label><input id="custom-command" value={command} onChange={event => setCommand(event.target.value)} placeholder="/usr/local/bin/my-mcp" /></div><div className="field custom-args"><label htmlFor="custom-args">Arguments <span>one per line</span></label><Textarea id="custom-args" rows={2} value={args} onChange={event => setArgs(event.target.value)} placeholder={"--workspace\n/home/agent/workspace"} /></div></>}</div>
      <details className="advanced-panel custom-advanced"><summary>{transport === "http" ? "Request headers" : "Environment variables"}</summary><p>Values are encrypted and cannot be viewed again.</p><div className="custom-secrets">{secrets.map((item, index) => <div className="custom-secret-row" key={index}><input aria-label={`${transport === "http" ? "Header" : "Variable"} ${index + 1} name`} value={item.key} onChange={event => updateSecret(index, "key", event.target.value)} placeholder={transport === "http" ? "Authorization" : "API_TOKEN"} autoCapitalize="none" autoComplete="off" /><input aria-label={`${transport === "http" ? "Header" : "Variable"} ${index + 1} secret value`} type="password" value={item.value} onChange={event => updateSecret(index, "value", event.target.value)} placeholder="Secret value" autoComplete="new-password" /><button type="button" className="icon-action" onClick={() => setSecrets(current => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove ${transport === "http" ? "header" : "variable"} ${index + 1}`}><Trash2 /></button></div>)}</div><Button type="button" variant="ghost" size="sm" onClick={() => setSecrets(current => [...current, { key: "", value: "" }])}><Plus />Add {transport === "http" ? "header" : "variable"}</Button></details>
      <div className="custom-submit"><Button type="submit" disabled={!label.trim() || (transport === "http" ? !url.trim() : !command.trim())}>Add server</Button></div>
    </form>}
    {connectionsLoading && <p role="status" className="muted-copy">Loading apps…</p>}
    <ConnectionCards catalog={catalog} accounts={accounts} busy={busy} namingServer={namingServer} healthText={healthText} onRequestConnection={requestConnection} onCancelNaming={()=>setNamingServer(null)} onConnect={async(server,value)=>{if(await connect(server,value))setNamingServer(null);}} onRename={rename} onCheck={account=>void check(account)} onDisconnect={account=>void disconnect(account)} />
    {!connectionsLoading && catalog.length === 0 && accounts.length === 0 && !error && <div className="quiet-empty"><Waypoints /><strong>No providers available</strong><span>Add a custom MCP server or try again shortly.</span></div>}
  </div></main>;
}

function LoadingApp() {
  return (
    <div className="app-loading" aria-label="Loading Companions">
      <div className="loading-sidebar"><div className="skeleton skeleton--logo" /><div className="skeleton" /><div className="skeleton" /></div>
      <div className="loading-main"><div className="skeleton skeleton--title" /><div className="skeleton skeleton--message" /><div className="skeleton skeleton--composer" /></div>
    </div>
  );
}

export function App() {
  const publicLegalPage = legalPageFromPath();
  const publicHomepage = /^\/about\/?$/.test(window.location.pathname);
  const publicRoute = Boolean(publicLegalPage || publicHomepage);
  const [authRequired, setAuthRequired] = useState(false);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [currentPath, setCurrentPath] = useState(window.location.pathname);
  const deletedIds = useRef(new Set<string>());
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(selectedIdFromPath);
  const [detail, setDetail] = useState<CompanionDetail | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const detailRequest = useRef(0);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [createOpen, setCreateOpen] = useState(() => window.location.pathname === "/new");
  const creationLock = useRef(false);
  const [creationLocked, setCreationLocked] = useState(false);
  const [teamCreateOpen, setTeamCreateOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigationGuard = useRef<NavigationGuard | null>(null);
  const acceptedLocation = useRef(window.location.pathname + window.location.search);
  const registerNavigationGuard = useCallback((guard: NavigationGuard | null) => { navigationGuard.current = guard; }, []);

  const setupLockedChange = useCallback((locked: boolean) => {
    creationLock.current = locked;
    setCreationLocked(locked);
    if (locked) {
      setCreateOpen(true);
      if (window.location.pathname !== "/new") window.history.pushState({}, "", "/new");
      acceptedLocation.current = "/new";
      setCurrentPath("/new");
      setSelectedId(null);
    }
  }, []);

  function leaveCompanion(action: () => void) {
    if (creationLock.current) return;
    if (selectedId && navigationGuard.current) navigationGuard.current(action);
    else action();
  }

  const handleApiError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) setAuthRequired(true);
    else setPageError(cause instanceof Error ? cause.message : "Something went wrong");
  }, []);

  const loadList = useCallback(async () => {
    try {
      const result = await api.getCompanions();
      setCompanions(result.companions.filter(item => !deletedIds.current.has(item.id)));
      setPageError("");
      return result.companions;
    } catch (cause) {
      handleApiError(cause);
      return [];
    }
  }, [handleApiError]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) return;
    const request = ++detailRequest.current;
    const current = () => request === detailRequest.current && selectedIdRef.current === selectedId && !deletedIds.current.has(selectedId);
    try {
      const result = await api.getCompanion(selectedId);
      if (!current()) return;
      setDetail(result);
      setDetailVersion(version => version + 1);
      setPageError("");
    } catch (cause) {
      if (current()) handleApiError(cause);
    }
  }, [selectedId, handleApiError]);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    setPageError("");
    try {
      const me = await api.getMe();
      const [nextConfig, list] = await Promise.all([api.getConfig(), api.getCompanions()]);
      setUser(me.user);
      setConfig(nextConfig);
      setCompanions(list.companions);
      setAuthRequired(false);
      const pathId = selectedIdFromPath();
      const nextId = pathId;
      setSelectedId(nextId);
      if (nextId) setDetail(await api.getCompanion(nextId));
    } catch (cause) {
      handleApiError(cause);
    } finally {
      setLoading(false);
    }
  }, [handleApiError]);

  useEffect(() => { if (!publicRoute) void bootstrap(); }, [bootstrap, publicRoute]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (creationLock.current) {
        event.stopImmediatePropagation();
        window.history.pushState({}, "", acceptedLocation.current);
        return;
      }
      const target = window.location.pathname + window.location.search;
      const targetId = selectedIdFromPath();
      const accept = () => {
        window.history.replaceState({}, "", target);
        acceptedLocation.current = target;
        setCurrentPath(window.location.pathname);
        if (targetId !== selectedId) setDetail(null);
        setSelectedId(targetId);
        setCreateOpen(window.location.pathname === "/new");
        setTeamCreateOpen(false);
      };
      if (selectedId && targetId !== selectedId && navigationGuard.current) {
        const restore = acceptedLocation.current;
        if (navigationGuard.current(accept, false)) {
          event.stopImmediatePropagation();
          window.history.pushState({}, "", restore);
          acceptedLocation.current = restore;
        }
        return;
      }
      accept();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [selectedId]);

  useEffect(() => {
    if (loading || !selectedId || authRequired) return;
    let closed = false;
    let refreshing = false;
    let dirty = false;
    let listTimer: number | undefined;
    const refresh = async () => {
      if (refreshing) { dirty = true; return; }
      refreshing = true;
      do {
        dirty = false;
        await loadDetail();
      } while (!closed && dirty);
      refreshing = false;
    };
    void refresh();
    if (typeof EventSource === "undefined") return () => { closed = true; };
    const events = api.companionEvents(selectedId);
    const changed = () => {
      void refresh();
      if (!listTimer) listTimer = window.setTimeout(() => { listTimer = undefined; void loadList(); }, 250);
    };
    const unauthorized = () => { events.close(); setAuthRequired(true); };
    events.addEventListener("invalidate", changed);
    events.addEventListener("resync", changed);
    events.addEventListener("unauthorized", unauthorized);
    return () => {
      closed = true;
      events.removeEventListener("invalidate", changed);
      events.removeEventListener("resync", changed);
      events.removeEventListener("unauthorized", unauthorized);
      events.close();
      if (listTimer) window.clearTimeout(listTimer);
    };
  }, [loading, selectedId, authRequired, loadDetail, loadList]);

  useEffect(() => {
    if (authRequired || publicRoute) return;
    const timer = window.setInterval(() => { void loadList(); }, LIST_INTERVAL);
    return () => window.clearInterval(timer);
  }, [authRequired, loadList, publicRoute]);

  function selectCompanion(id: string) {
    const select = () => {
      setSelectedId(id);
      if (id !== selectedId) setDetail(null);
      else void loadDetail();
      setCreateOpen(false);
      setTeamCreateOpen(false);
      setSidebarOpen(false);
      window.history.pushState({}, "", `/companions/${id}`);
      acceptedLocation.current = `/companions/${id}`;
      setCurrentPath(`/companions/${id}`);
    };
    if (id === selectedId) select(); else leaveCompanion(select);
  }

  function navigate(path: string) {
    leaveCompanion(() => {
      window.history.pushState({}, "", path);
      acceptedLocation.current = path;
      setCurrentPath(path);
      setSelectedId(selectedIdFromPath());
      setCreateOpen(path === "/new");
      setTeamCreateOpen(false);
      setSidebarOpen(false);
    });
  }

  async function signOut() {
    await api.signOut();
    setUser(null); setAuthRequired(true); setCompanions([]); setDetail(null);
    navigate("/");
  }

  function handleDeleted(ids: string[]) {
    ids.forEach(id => deletedIds.current.add(id));
    setCompanions(current => current.filter(item => !ids.includes(item.id)));
    setDetail(null);
    setPageError('');
    window.history.replaceState({}, '', '/');
    acceptedLocation.current = '/';
    setCurrentPath('/'); setSelectedId(null);
    setCreateOpen(false); setTeamCreateOpen(false);
  }

  function handleCreated(companion: Companion) {
    setCompanions((current) => [companion, ...current.filter(item => item.id !== companion.id)]);
    selectCompanion(companion.id);
    void loadList();
  }

  function openLogin() {
    window.history.pushState({}, "", "/login");
    acceptedLocation.current = "/login";
    setCurrentPath("/login");
  }

  if (publicLegalPage) return <LegalPage kind={publicLegalPage} />;
  if (publicHomepage) return <LandingPage onLogin={openLogin} />;
  if (authRequired) return currentPath === "/" ? <LandingPage onLogin={openLogin} /> : <AccessGate />;
  if (loading) return <LoadingApp />;
  if (!config || !user) {
    return (
      <main className="load-failure">
        <CircleAlert />
        <h1>Couldn’t load companions.build</h1>
        <p>{pageError || "The service did not return its configuration."}</p>
        <Button onClick={() => void bootstrap()}>Try again</Button>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <Sidebar
        companions={companions}
        selectedId={selectedId}
        currentPath={currentPath}
        locked={creationLocked}
        onSelect={selectCompanion}
        onCreate={() => navigate("/new")}
        onCreateTeam={() => leaveCompanion(() => { setTeamCreateOpen(true); setCreateOpen(false); setSidebarOpen(false); })}
        onNavigate={navigate}
        user={user}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      {pageError && (
        <div className="page-error" role="alert"><CircleAlert />{pageError}<button onClick={() => void bootstrap()}>Try again</button></div>
      )}
      {teamCreateOpen ? <main className="team-onboarding" id="main-content"><Suspense fallback={<div className="companion-page-inner" role="status">Opening team creation…</div>}><CreateTeamWizard config={config} companions={companions.filter(item => !item.temporary && !item.retiredAt)} onCancel={() => setTeamCreateOpen(false)} onCreated={companion => { handleCreated(companion); window.history.replaceState({}, '', `/companions/${companion.id}?view=team`); }} /></Suspense></main> : currentPath === "/account" && !createOpen ? (
        <AccountPage user={user} onSignOut={signOut} onMenu={() => setSidebarOpen(true)} />
      ) : currentPath === "/specialists" && !createOpen ? (
        <Suspense fallback={<main className="detail-loading" id="main-content" role="status">Opening specialists…</main>}><SpecialistLibrary onMenu={() => setSidebarOpen(true)} onOpenDraft={(companionId, templateId) => navigate(`/companions/${companionId}?specialist=${encodeURIComponent(templateId)}`)} /></Suspense>
      ) : currentPath === "/connections" && !createOpen ? (
        <ConnectionsPage onMenu={() => setSidebarOpen(true)} />
      ) : (companions.length === 0 && !selectedId) || createOpen ? (
        <main className="onboarding" id="main-content">
          <div className="onboarding-mobile-header"><Button disabled={creationLocked} variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu /></Button><span className="wordmark">companions.build</span></div>
          <Suspense fallback={<div className="detail-loading" role="status">Opening creation…</div>}><CreateCompanion ownerId={user.id} onSetupLockedChange={setupLockedChange} config={config} onCreated={handleCreated} compact={companions.length > 0} /></Suspense>
        </main>
      ) : !selectedId ? (
        <Home companions={companions} onSelect={selectCompanion} onCreateTeam={() => leaveCompanion(() => setTeamCreateOpen(true))} onCreate={() => navigate("/new")} onMenu={() => setSidebarOpen(true)} />
      ) : detail && detail.companion.id === selectedId ? (
        <CompanionView onNavigate={navigate} onDeleted={handleDeleted} key={detail.companion.id} detail={detail} refreshVersion={detailVersion} models={config.models ?? [{ id: config.model, name: config.model }]} onRefresh={loadDetail} onUnauthorized={() => setAuthRequired(true)} onMenu={() => setSidebarOpen(true)} onOpenCompanion={selectCompanion} onRegisterNavigationGuard={registerNavigationGuard} onLocationChange={location => { acceptedLocation.current = location; }} />
      ) : (
        <main className="detail-loading" id="main-content"><LoaderCircle className="spin" /><span>Opening Companion…</span></main>
      )}
    </div>
  );
}
