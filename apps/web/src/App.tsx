import {
  Box,
  CalendarClock,
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
  Send,
  Server,
  Trash2,
  UserRound,
  Waypoints,
  X,
} from "lucide-react";
import { DragEvent, FormEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { ConnectionActions } from "@/components/ConnectionActions";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  ApiError,
  type AppConfig,
  type AccountUser,
  type AgentTemplate,
  type Companion,
  type CompanionDetail,
  type CustomPluginInput,
  isActiveRun,
  type RunStatus,
  workspaceApi,
  type PluginAccount,
  type PluginServer,
} from "@/api";
import { Question } from "@/components/Question";
import { cn } from "@/lib/utils";
import { AvatarPicker, CompanionAvatar, DEFAULT_AVATAR, type CompanionAvatarValue } from "@/components/CompanionAvatar";
import { AccountProduct, DesktopSheet } from "@/components/ProductPanels";
import { RoutineSettings, TriggerSettings } from "@/components/AutomationPanels";
const TeamPanel = lazy(() => import("@/components/TeamPanel").then(module => ({ default: module.TeamPanel })));
const CreateTeamWizard = lazy(() => import("@/components/CreateTeamWizard").then(module => ({ default: module.CreateTeamWizard })));
import { ProviderMark } from "@/components/ProviderMark";
import { SettingsSheet } from "@/components/SettingsSheet";

const LIST_INTERVAL = 8_000;
const MAX_CHAT_FILES = 5;
const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;

function selectedIdFromPath() {
  return window.location.pathname.match(/^\/companions\/([^/]+)$/)?.[1] ?? null;
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

function CreateCompanion({
  config,
  onCreated,
  compact = false,
}: {
  config: AppConfig;
  onCreated: (companion: Companion) => void;
  compact?: boolean;
}) {
  const firstProvider = config.boxAvailable ? "box" : "local";
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [provider, setProvider] = useState<"local" | "box">(firstProvider);
  const [avatar, setAvatar] = useState<CompanionAvatarValue>(DEFAULT_AVATAR);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const creationIntent = useRef<{ fingerprint: string; id: string } | null>(null);

  useEffect(() => {
    let current = true;
    void workspaceApi.templates().then(result => { if (current) setTemplates(result.templates); }).catch(() => {});
    return () => { current = false; };
  }, []);

  const selectedTemplate = templates.find(template => template.id === templateId);
  const selectedTemplateNeedsBox = !!(selectedTemplate?.hasSnapshot || selectedTemplate?.softwareBuildId || selectedTemplate?.softwareResultId);
  function chooseTemplate(id: string) {
    setTemplateId(id);
    const template = templates.find(item => item.id === id);
    if (!template) return;
    setName(template.name); setInstructions(template.instructions); setAvatar(template.avatar);
    if ((template.hasSnapshot || template.softwareBuildId || template.softwareResultId) && config.boxAvailable) setProvider("box");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !instructions.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const input = {
        name: name.trim(),
        instructions: instructions.trim(),
        provider,
        avatar,
        ...(selectedTemplate ? { templateId: selectedTemplate.id, templateRevision: selectedTemplate.revision } : {}),
      };
      const fingerprint=JSON.stringify(input);
      if(creationIntent.current?.fingerprint!==fingerprint)creationIntent.current={fingerprint,id:crypto.randomUUID()};
      const result = await api.createCompanion({...input,clientCreationId:creationIntent.current.id});
      onCreated(result.companion);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create Companion");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={cn("create-form", compact && "create-form--compact")} onSubmit={submit}>
      {!compact && (
        <div className="create-intro">
          <h1>Create your first Companion</h1>
          <p>Give them a name and a clear mission. Their chat stays here while they work.</p>
        </div>
      )}
      {compact && <h2>New Companion</h2>}

      {templates.length > 0 && <div className="field template-source"><label htmlFor={compact ? "template-compact" : "template"}>Start from</label><select id={compact ? "template-compact" : "template"} value={templateId} onChange={event => chooseTemplate(event.target.value)}><option value="">Blank Companion</option>{templates.map(template => {const needsBox=!!(template.hasSnapshot||template.softwareBuildId||template.softwareResultId);return <option key={template.id} value={template.id} disabled={needsBox&&!config.boxAvailable}>{template.name} · v{template.revision}{needsBox&&!config.boxAvailable ? " · cloud unavailable" : ""}</option>;})}</select><span className="field-hint">Templates prefill the mission and pin this Companion to the version shown.</span></div>}

      <details className="create-personality"><summary><CompanionAvatar name="Your companion" avatar={avatar} size={48}/><span>Give them a little personality<small>Choose a shape, color and expression</small></span><ChevronRight/></summary><AvatarPicker value={avatar} onChange={setAvatar} /></details>

      <div className="field">
        <label htmlFor={compact ? "name-compact" : "name"}>Name</label>
        <input
          id={compact ? "name-compact" : "name"}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Ada"
          autoFocus
        />
      </div>
      <div className="field">
        <label htmlFor={compact ? "mission-compact" : "mission"}>Mission</label>
        <Textarea
          id={compact ? "mission-compact" : "mission"}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Research customer questions and turn the findings into clear briefs."
          rows={compact ? 3 : 4}
        />
        <span className="field-hint">Set the mission this Companion will start with.</span>
      </div>

      <details className="create-advanced"><summary>Computer preferences</summary><fieldset className="provider-picker">
        <legend>Computer</legend>
        <label className={cn("provider-option", provider === "local" && "provider-option--selected", (!config.localAvailable || selectedTemplateNeedsBox) && "provider-option--disabled")}>
          <input
            type="radio"
            name="provider"
            value="local"
            checked={provider === "local"}
            onChange={() => setProvider("local")}
            disabled={!config.localAvailable || selectedTemplateNeedsBox}
          />
          <Computer />
          <span><strong>Local</strong><small>Runs on this machine</small></span>
          {provider === "local" && <Check className="provider-check" />}
        </label>
        <label className={cn("provider-option", provider === "box" && "provider-option--selected", !config.boxAvailable && "provider-option--disabled")}>
          <input
            type="radio"
            name="provider"
            value="box"
            checked={provider === "box"}
            onChange={() => setProvider("box")}
            disabled={!config.boxAvailable}
          />
          <Box />
          <span><strong>Box</strong><small>Persistent cloud computer</small></span>
          {provider === "box" && <Check className="provider-check" />}
        </label>
      </fieldset></details>
      {error && <p className="field-error" role="alert">{error}</p>}
      <Button className="create-submit" type="submit" disabled={!name.trim() || !instructions.trim() || submitting || (!config.localAvailable && !config.boxAvailable)}>
        {submitting ? <LoaderCircle className="spin" /> : <Plus />}
        Create Companion
      </Button>
    </form>
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
}: {
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
      <aside className={cn("sidebar", open && "sidebar--open")} aria-label="Companions">
        <div className="sidebar-header">
          <button className="wordmark wordmark-button" onClick={() => onNavigate("/")}>companions<span>.build</span></button>
          <Button variant="ghost" size="icon" className="sidebar-close" onClick={onClose} aria-label="Close navigation"><PanelLeftClose /></Button>
        </div>
        <div className="sidebar-label"><span>Your companions</span><details className="create-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}><summary aria-label="Create"><Plus /></summary><div className="create-popover"><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onCreate(); }}>New Companion</button><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onCreateTeam(); }}>Create a team</button></div></details></div>
        <nav className="companion-list">
          {companions.map((companion) => (
            <button
              key={companion.id}
              className={cn("companion-link", selectedId === companion.id && "companion-link--active")}
              onClick={() => onSelect(companion.id)}
              aria-current={selectedId === companion.id ? "page" : undefined}
            >
              <CompanionAvatar name={companion.name} avatar={companion.avatar} size={34} />
              <span className="companion-link-copy">
                <strong>{companion.name}</strong>
                <small><StatusDot status={companion.status} />{statusLabel(companion.status)}</small>
              </span>
              <ChevronRight className="companion-chevron" />
            </button>
          ))}
        </nav>
        <details className="account-menu" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))event.currentTarget.open=false;}} onKeyDown={event=>{if(event.key==='Escape'){event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}>
          <summary><span className="account-initial">{user.email.slice(0,1).toUpperCase()}</span><span>Your account</span><ChevronRight /></summary>
          <div className="account-popover"><p>{user.email}</p><button onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');onNavigate('/connections');}}><Waypoints/>Connections</button><button onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');onNavigate('/account');}}><UserRound/>Account & subscription</button></div>
        </details>
      </aside>
    </>
  );
}

function ActivityPanel({ detail, onClose, onOpenCompanion }: { detail: CompanionDetail; onClose: () => void; onOpenCompanion: (id: string) => void }) {
  const latestRuns = detail.runs.slice().reverse().slice(0, 8);
  return (
    <aside className="activity-panel" aria-label="Activity">
      <div className="activity-heading">
        <span>Activity</span>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close activity"><X /></Button>
      </div>
      <div className="mission-copy">
        <span>Mission</span>
        <p>{detail.companion.instructions}</p>
      </div>
      <div className="timeline">
        {latestRuns.length === 0 ? (
          <p className="timeline-empty">Work will appear here as it happens.</p>
        ) : latestRuns.map((run) => (
          <div className="timeline-row" key={run.id}>
            <span className={cn("run-icon", `run-icon--${run.status}`)}>
              {isActiveRun(run.status) ? <LoaderCircle className="spin" /> : run.status === "succeeded" ? <Check /> : <CircleAlert />}
            </span>
            <div>
              <strong>{statusLabel(run.status)}</strong>
              <small>{readableDate(run.createdAt)}</small>
              {run.error && <p className="run-error">{run.error}</p>}
              {run.lane === "background" && run.resultText && <div className="task-result"><MessageResponse>{run.resultText}</MessageResponse></div>}
              {run.lane === "background" && detail.files?.some(file => file.runId === run.id) && <div className="message-files">{detail.files.filter(file => file.runId === run.id).map(file => <a key={file.id} href={file.url} target="_blank" rel="noreferrer"><FileText /><span>{file.name}</span></a>)}</div>}
              {run.lane === "background" && <SpecialistsForRun detail={detail} runId={run.id} onOpen={onOpenCompanion} />}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Chat({ detail, onRefresh, onUnauthorized, onOpenCompanion, readOnly = false }: { detail: CompanionDetail; onRefresh: () => Promise<void>; onUnauthorized: () => void; onOpenCompanion: (id: string) => void; readOnly?: boolean }) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [fileNotice, setFileNotice] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragDepth = useRef(0);
  const activeRun = detail.runs.find((run) => run.lane !== "background" && isActiveRun(run.status));
  const activePreview = activeRun
    && (activeRun.status === "running" || activeRun.status === "needs_input")
    && activeRun.previewText
    && !detail.messages.some((message) => message.role === "assistant" && message.runId === activeRun.id)
      ? activeRun.previewText
      : null;

  async function send(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setActionError("");
    try {
      await api.sendMessage(detail.companion.id, content, files);
      setDraft("");
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
          {detail.messages.length === 0 ? (
            <ConversationEmptyState className="chat-empty">
              <CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={72} />
              <h2>A little less on your mind.</h2>
              <p>Make room for what matters. {detail.companion.name} can help.</p>
              {!readOnly && <div className="chat-suggestions">{['Plan my day', 'Help with a project', 'Set up a routine'].map(prompt=><button type="button" key={prompt} onClick={()=>{setDraft(prompt);textareaRef.current?.focus();}}>{prompt}<ChevronRight/></button>)}</div>}
            </ConversationEmptyState>
          ) : detail.messages.map((message) => (
            <Message from={message.role} key={message.id}>
              {message.role === "assistant" && <span className="message-author">{detail.companion.name}</span>}
              <MessageContent><MessageResponse>{message.content}</MessageResponse></MessageContent>
              {message.files?.length ? <div className="message-files">{message.files.map((file) => <a key={file.id} href={file.url} target="_blank" rel="noreferrer"><FileText /><span>{file.name}</span></a>)}</div> : null}
              {message.role === "user" && <SpecialistsForRun detail={detail} runId={message.runId} onOpen={onOpenCompanion} />}
              <time className="message-time" dateTime={message.createdAt}>{readableDate(message.createdAt)}</time>
            </Message>
          ))}
          {activePreview && (
            <Message from="assistant" className="message-preview">
              <span className="message-author">{detail.companion.name}</span>
              <MessageContent><MessageResponse>{activePreview}</MessageResponse></MessageContent>
            </Message>
          )}
          {activeRun && (
            <div className="working-row" role="status">
              <span className="working-dots"><i /><i /><i /></span>
              {activeRun.status === "queued" ? "Queued" : activeRun.status === "preparing" ? "Preparing" : `${detail.companion.name} is working`}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest message" />
      </Conversation>
      {(detail.questions??[]).map(question=><Question key={question.id} companionId={detail.companion.id} question={question} onAnswered={onRefresh}/>)}
      {!readOnly && <form className={cn("composer-wrap", dragActive && "composer-wrap--drop")} onSubmit={send} onDragEnter={dragEnter} onDragOver={dragOver} onDragLeave={dragLeave} onDrop={drop}>
        <span className="sr-only" aria-live="polite">{fileNotice}</span>
        {actionError && <p className="composer-error" role="alert">{actionError}</p>}
        {files.length > 0 && <div className="pending-files">{files.map((file, index) => <span key={`${file.name}-${file.lastModified}`}><FileText />{file.name}<button type="button" onClick={() => setFiles((current) => current.filter((_, item) => item !== index))} aria-label={`Remove ${file.name}`}><X /></button></span>)}</div>}
        <div className="composer">
          {dragActive && <div className="drop-indicator" aria-hidden="true"><Paperclip />Drop files here</div>}
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={`Message ${detail.companion.name}`}
            aria-label={`Message ${detail.companion.name}`}
            rows={2}
          />
          <div className="composer-actions">
            <span className="composer-hint">Enter to send · Shift + Enter for a new line</span>
            <div className="composer-buttons">
              <label className="attach-button" aria-label="Attach files"><Plus /><input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,text/markdown,application/json,.md,.markdown,.txt,.csv,.json" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} /></label>
              {activeRun && (
                <Button type="button" variant="outline" size="sm" onClick={cancel}><CircleStop />Cancel</Button>
              )}
              <Button type="submit" size="icon" disabled={!draft.trim() || sending} aria-label="Send message">
                {sending ? <LoaderCircle className="spin" /> : <Send />}
              </Button>
            </div>
          </div>
        </div>
      </form>}
    </section>
  );
}

function CompanionConnections({ companionId }: { companionId: string }) {
  const [all, setAll] = useState<PluginAccount[]>([]); const [selected, setSelected] = useState<PluginAccount[]>([]); const [error, setError] = useState("");
  const load = useCallback(async () => { try { const [plugins, current] = await Promise.all([workspaceApi.plugins(), workspaceApi.companionPlugins(companionId)]); setAll(plugins.accounts); setSelected(current.accounts); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load connections"); } }, [companionId]);
  useEffect(() => { void load(); }, [load]);
  const selectedIds = new Set(selected.map((item) => item.id));
  return <div className="settings-stack"><div className="settings-intro"><Waypoints /><div><h3>Connections</h3><p>Choose which connected accounts this Companion can use.</p></div></div>{all.length === 0 ? <p className="settings-empty">Connect an account from Connections first.</p> : all.map((account) => <label className="connection-choice" key={account.id}><span className="provider-dot">{(account.provider ?? account.label).slice(0, 1).toUpperCase()}</span><span><strong>{account.label}</strong><small>{account.provider ?? account.serverId}</small></span><input type="checkbox" checked={selectedIds.has(account.id)} onChange={() => void (selectedIds.has(account.id) ? workspaceApi.unselectPlugin(companionId, account.id) : workspaceApi.selectPlugin(companionId, account.id)).then(load)} /></label>)}{error && <p className="field-error">{error}</p>}</div>;
}

function CompanionView({ detail, models, onRefresh, onUnauthorized, onMenu, onOpenCompanion, onDeleted }: { detail: CompanionDetail; models: Array<{ id: string; name: string }>; onDeleted: (ids: string[]) => void; onRefresh: () => Promise<void>; onUnauthorized: () => void; onMenu: () => void; onOpenCompanion: (id: string) => void }) {
  const readView = () => { const value = new URLSearchParams(window.location.search).get('view'); return value === 'team' || value === 'automations' ? value : 'chat'; };
  const [view, setView] = useState(readView);
  const [automationView, setAutomationView] = useState(() => new URLSearchParams(window.location.search).get('kind') === 'events' ? 'events' : 'routines');
  const [identityOpen, setIdentityOpen] = useState(false);
  useEffect(() => { const restore = () => { setView(readView()); setAutomationView(new URLSearchParams(window.location.search).get('kind') === 'events' ? 'events' : 'routines'); }; window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore); }, []);
  function changeView(next: 'chat' | 'automations' | 'team', kind = automationView) {
    const url = new URL(window.location.href);
    if (next === 'chat') url.searchParams.delete('view'); else url.searchParams.set('view', next);
    if (next === 'automations' && kind === 'events') url.searchParams.set('kind', kind); else url.searchParams.delete('kind');
    if (url.pathname + url.search !== window.location.pathname + window.location.search) window.history.pushState({}, '', url.pathname + url.search);
    setView(next); setAutomationView(kind);
  }
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const finished = Boolean(detail.companion.temporary && detail.companion.retiredAt);
  const displayedStatus = finished ? "archived" : detail.companion.status;

  return (
    <main className="workspace" id="main-content">
      <header className="chat-header">
        <Button className="mobile-menu" variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button>
        <button className="header-identity identity-link" disabled={finished} aria-label={`Edit ${detail.companion.name}'s personality`} onClick={() => { setIdentityOpen(true); setSettingsOpen(true); }}>
          <CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={38} />
          <div><h1>{detail.companion.name}</h1><span><StatusDot status={displayedStatus} />{finished ? "Finished" : statusLabel(displayedStatus)}</span></div>
        </button>
        <div className="header-actions">
          {(finished || detail.runs.some(run => isActiveRun(run.status)) || !!detail.questions?.length) && <Button variant="ghost" size="sm" onClick={() => setActivityOpen(true)} aria-label="Activity"><CalendarClock /><span>{detail.questions?.length ? 'Needs you' : 'Activity'}</span></Button>}
        </div>
      </header>
      {!finished && <nav className="companion-sections" aria-label="Companion sections">{([['chat', 'Discussion'], ['automations', 'Automations'], ['team', 'Team']] as const).map(([key, label]) => <button key={key} aria-current={view === key ? 'page' : undefined} onClick={() => changeView(key)}>{label}</button>)}</nav>}
      <div className="workspace-body" hidden={!finished && view !== 'chat'}>
        <Chat detail={detail} onRefresh={onRefresh} onUnauthorized={onUnauthorized} onOpenCompanion={onOpenCompanion} readOnly={finished} />
      </div>
      {!finished && view === 'automations' && <section className="companion-page" aria-label="Automations"><div className="companion-page-inner"><header className="section-intro"><h2>A little help, on repeat.</h2><p>Set the timing. Your companion takes it from there.</p></header><nav className="automation-sections" aria-label="Automation type"><button aria-current={automationView === 'routines' ? 'page' : undefined} onClick={() => changeView('automations', 'routines')}>Routines</button><button aria-current={automationView === 'events' ? 'page' : undefined} onClick={() => changeView('automations', 'events')}>Events</button></nav>{automationView === 'routines' ? <RoutineSettings companionId={detail.companion.id}/> : <TriggerSettings companionId={detail.companion.id}/>}</div></section>}
      {!finished && view === 'team' && <section className="companion-page" aria-label="Team"><Suspense fallback={<div className="companion-page-inner" role="status">Opening your team…</div>}><TeamPanel companion={detail.companion} onOpenCompanion={onOpenCompanion}/></Suspense></section>}
      {activityOpen && <div className="activity-layer"><button className="sheet-scrim" onClick={() => setActivityOpen(false)} aria-label="Close activity" /><ActivityPanel detail={detail} onClose={() => setActivityOpen(false)} onOpenCompanion={(id) => { setActivityOpen(false); onOpenCompanion(id); }} /></div>}
      {settingsOpen && <SettingsSheet initialPage={identityOpen ? "identity" : "home"} detail={detail} models={models} onClose={() => setSettingsOpen(false)} onSaved={onRefresh} onDeleted={onDeleted} connections={<CompanionConnections companionId={detail.companion.id} />} onActivity={() => { setSettingsOpen(false); setActivityOpen(true); }} onDesktop={() => { setSettingsOpen(false); setDesktopOpen(true); }} />}
      {desktopOpen && <DesktopSheet companion={detail.companion} onClose={() => setDesktopOpen(false)} onRefresh={onRefresh} />}
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
  const [catalog, setCatalog] = useState<PluginServer[]>([]); const [accounts, setAccounts] = useState<PluginAccount[]>([]); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(""); const [customOpen, setCustomOpen] = useState(false); const [label, setLabel] = useState(""); const [transport, setTransport] = useState<"http" | "stdio">("http"); const [url, setUrl] = useState(""); const [command, setCommand] = useState(""); const [args, setArgs] = useState(""); const [secrets, setSecrets] = useState<Array<{ key: string; value: string }>>([]); const oauthPopup = useRef<Window | null>(null); const oauthWatch=useRef<number|null>(null);
  const load = useCallback(() => workspaceApi.plugins().then((result) => { setCatalog(result.catalog); setAccounts(result.accounts); }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load connections")), []);
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
  async function connect(server: PluginServer) { if(!server.available)return;setError("");setNotice("");setBusy(server.id);const popup=window.open("about:blank","companions-plugin-oauth","popup,width=620,height=760");oauthPopup.current=popup;if(popup)oauthWatch.current=window.setInterval(()=>{if(!popup.closed)return;if(oauthWatch.current!==null)window.clearInterval(oauthWatch.current);oauthWatch.current=null;oauthPopup.current=null;setBusy("");setNotice("Connection window closed.");},500);try { const result = await workspaceApi.connectPlugin(server.id, server.name); if (result.url) {if(popup&&!popup.closed)popup.location.href=result.url;else window.location.assign(result.url);} else {if(oauthWatch.current!==null)window.clearInterval(oauthWatch.current);oauthWatch.current=null;popup?.close();oauthPopup.current=null;setBusy("");await load();} } catch (cause) { if(oauthWatch.current!==null)window.clearInterval(oauthWatch.current);oauthWatch.current=null;popup?.close();oauthPopup.current=null;setBusy("");setError(cause instanceof Error ? cause.message : "Could not connect account"); } }
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
  return <main className="simple-page" id="main-content"><header className="mobile-page-header"><Button variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button><span className="wordmark">companions.build</span></header><div className="simple-inner connections-inner"><div className="page-title-row"><div><h1>Connections</h1><p className="muted-copy">Accounts your Companions can use.</p></div><Button variant="outline" onClick={() => setCustomOpen((value) => !value)}><Plus />Custom MCP</Button></div>
    {error && <p className="field-error" role="alert">{error}</p>}{notice&&<p className="connection-notice" role="status">{notice}</p>}
    {customOpen && <form className="custom-connection" onSubmit={addCustom}>
      <div className="custom-connection-main"><div className="field"><label htmlFor="custom-label">Name</label><input id="custom-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Internal tools" /></div><div className="field"><label htmlFor="custom-transport">Transport</label><select id="custom-transport" value={transport} onChange={event => { setTransport(event.target.value as "http" | "stdio"); setSecrets([]); }}><option value="http">Remote HTTP</option><option value="stdio">Local stdio</option></select></div>{transport === "http" ? <div className="field custom-endpoint"><label htmlFor="custom-url">Server URL</label><input id="custom-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" /></div> : <><div className="field custom-endpoint"><label htmlFor="custom-command">Command</label><input id="custom-command" value={command} onChange={event => setCommand(event.target.value)} placeholder="/usr/local/bin/my-mcp" /></div><div className="field custom-args"><label htmlFor="custom-args">Arguments <span>one per line</span></label><Textarea id="custom-args" rows={2} value={args} onChange={event => setArgs(event.target.value)} placeholder={"--workspace\n/home/agent/workspace"} /></div></>}</div>
      <details className="advanced-panel custom-advanced"><summary>{transport === "http" ? "Request headers" : "Environment variables"}</summary><p>Values are encrypted and cannot be viewed again.</p><div className="custom-secrets">{secrets.map((item, index) => <div className="custom-secret-row" key={index}><input aria-label={`${transport === "http" ? "Header" : "Variable"} ${index + 1} name`} value={item.key} onChange={event => updateSecret(index, "key", event.target.value)} placeholder={transport === "http" ? "Authorization" : "API_TOKEN"} autoCapitalize="none" autoComplete="off" /><input aria-label={`${transport === "http" ? "Header" : "Variable"} ${index + 1} secret value`} type="password" value={item.value} onChange={event => updateSecret(index, "value", event.target.value)} placeholder="Secret value" autoComplete="new-password" /><button type="button" className="icon-action" onClick={() => setSecrets(current => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove ${transport === "http" ? "header" : "variable"} ${index + 1}`}><Trash2 /></button></div>)}</div><Button type="button" variant="ghost" size="sm" onClick={() => setSecrets(current => [...current, { key: "", value: "" }])}><Plus />Add {transport === "http" ? "header" : "variable"}</Button></details>
      <div className="custom-submit"><Button type="submit" disabled={!label.trim() || (transport === "http" ? !url.trim() : !command.trim())}>Add server</Button></div>
    </form>}
    {accounts.length > 0 && <section className="connection-section"><h2>Connected</h2>{accounts.map((account) => {const reconnect=account.healthCode==="authorization_required"?catalog.find(server=>server.id===account.serverId&&server.available):undefined;return <div className="connected-row" key={account.id}><ProviderMark provider={account.provider} name={account.label}/><div><strong>{account.label}</strong><small role="status" className={`connection-health connection-health--${account.healthStatus}`}>{healthText(account)}</small></div><div className="connection-row-actions">{reconnect&&<Button variant="ghost" size="sm" disabled={!!busy} onClick={()=>void connect(reconnect)}>Reconnect</Button>}<ConnectionActions label={account.label} busy={!!busy} onCheck={account.provider === "custom" ? undefined : () => void check(account)} onDisconnect={() => void disconnect(account)} /></div></div>;})}</section>}
    <section className="connection-section"><h2>Add a connection</h2><div className="provider-list">{catalog.map((server) => <div className="provider-row" key={server.id}><ProviderMark provider={server.provider} name={server.name}/><div><strong>{server.name}</strong><small>{server.available?(server.description ?? "Tools and events"):"Unavailable in this deployment"}</small></div><Button variant="outline" size="sm" disabled={!server.available||!!busy} onClick={() => void connect(server)}>{busy===server.id?<LoaderCircle className="spin"/>:server.available?"Connect":"Unavailable"}{server.available&&<ExternalLink />}</Button></div>)}</div>{catalog.length === 0 && <div className="quiet-empty"><Waypoints /><strong>No providers available</strong><span>Add a custom MCP server or try again shortly.</span></div>}</section>
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
  const [authRequired, setAuthRequired] = useState(false);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [currentPath, setCurrentPath] = useState(window.location.pathname);
  const deletedIds = useRef(new Set<string>());
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(selectedIdFromPath);
  const [detail, setDetail] = useState<CompanionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [teamCreateOpen, setTeamCreateOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
    try {
      const result = await api.getCompanion(selectedId);
      if (!deletedIds.current.has(selectedId)) setDetail(result);
      setPageError("");
    } catch (cause) {
      if (!deletedIds.current.has(selectedId)) handleApiError(cause);
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

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  useEffect(() => {
    const onPopState = () => { setCurrentPath(window.location.pathname); setSelectedId(selectedIdFromPath()); setCreateOpen(false); setTeamCreateOpen(false); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
    if (authRequired) return;
    const timer = window.setInterval(() => { void loadList(); }, LIST_INTERVAL);
    return () => window.clearInterval(timer);
  }, [authRequired, loadList]);

  function selectCompanion(id: string) {
    setSelectedId(id);
    if (id !== selectedId) setDetail(null);
    else void loadDetail();
    setCreateOpen(false);
    setTeamCreateOpen(false);
    setSidebarOpen(false);
    window.history.pushState({}, "", `/companions/${id}`);
    setCurrentPath(`/companions/${id}`);
  }

  function navigate(path: string) {
    window.history.pushState({}, "", path);
    setCurrentPath(path);
    setSelectedId(selectedIdFromPath());
    setCreateOpen(false);
    setTeamCreateOpen(false);
    setSidebarOpen(false);
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
    setCurrentPath('/'); setSelectedId(null);
    setCreateOpen(false); setTeamCreateOpen(false);
  }

  function handleCreated(companion: Companion) {
    setCompanions((current) => [companion, ...current.filter(item => item.id !== companion.id)]);
    selectCompanion(companion.id);
    void loadList();
  }

  if (authRequired) return <AccessGate />;
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
        onSelect={selectCompanion}
        onCreate={() => { setCreateOpen(true); setTeamCreateOpen(false); setSidebarOpen(false); }}
        onCreateTeam={() => { setTeamCreateOpen(true); setCreateOpen(false); setSidebarOpen(false); }}
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
      ) : currentPath === "/connections" && !createOpen ? (
        <ConnectionsPage onMenu={() => setSidebarOpen(true)} />
      ) : companions.length === 0 || createOpen ? (
        <main className="onboarding" id="main-content">
          <div className="onboarding-mobile-header"><Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu /></Button><span className="wordmark">companions.build</span></div>
          <CreateCompanion config={config} onCreated={handleCreated} compact={companions.length > 0} />
          <div className="model-note"><Server />Using {config.model}</div>
        </main>
      ) : !selectedId ? (
        <Home companions={companions} onSelect={selectCompanion} onCreateTeam={() => setTeamCreateOpen(true)} onCreate={() => setCreateOpen(true)} onMenu={() => setSidebarOpen(true)} />
      ) : detail && detail.companion.id === selectedId ? (
        <CompanionView onDeleted={handleDeleted} key={detail.companion.id} detail={detail} models={config.models ?? [{ id: config.model, name: config.model }]} onRefresh={loadDetail} onUnauthorized={() => setAuthRequired(true)} onMenu={() => setSidebarOpen(true)} onOpenCompanion={selectCompanion} />
      ) : (
        <main className="detail-loading" id="main-content"><LoaderCircle className="spin" /><span>Opening Companion…</span></main>
      )}
    </div>
  );
}
