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
  Settings,
  Send,
  Server,
  Trash2,
  UserRound,
  UsersRound,
  Waypoints,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  ApiError,
  type AppConfig,
  type AccountUser,
  type Companion,
  type CompanionDetail,
  isActiveRun,
  type RunStatus,
  workspaceApi,
  type PluginAccount,
  type PluginServer,
} from "@/api";
import { Question } from "@/components/Question";
import { cn } from "@/lib/utils";
import { AvatarPicker, CompanionAvatar, DEFAULT_AVATAR, type CompanionAvatarValue } from "@/components/CompanionAvatar";
import { AccountProduct, DeliverySettings, DesktopSheet, SpecialistsSettings } from "@/components/ProductPanels";
import { RoutineSettings, TriggerSettings } from "@/components/AutomationPanels";

const ACTIVE_DETAIL_INTERVAL = 1_000;
const IDLE_DETAIL_INTERVAL = 5_000;
const LIST_INTERVAL = 8_000;

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
  return status.replace("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function StatusDot({ status }: { status: Companion["status"] }) {
  return <span className={cn("status-dot", `status-dot--${status}`)} aria-hidden="true" />;
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
  const firstProvider = config.localAvailable ? "local" : "box";
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [provider, setProvider] = useState<"local" | "box">(firstProvider);
  const [avatar, setAvatar] = useState<CompanionAvatarValue>(DEFAULT_AVATAR);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !instructions.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await api.createCompanion({
        name: name.trim(),
        instructions: instructions.trim(),
        provider,
        avatar,
      });
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

      <AvatarPicker value={avatar} onChange={setAvatar} />

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

      <fieldset className="provider-picker">
        <legend>Computer</legend>
        <label className={cn("provider-option", provider === "local" && "provider-option--selected", !config.localAvailable && "provider-option--disabled")}>
          <input
            type="radio"
            name="provider"
            value="local"
            checked={provider === "local"}
            onChange={() => setProvider("local")}
            disabled={!config.localAvailable}
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
      </fieldset>
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
  onNavigate,
  currentPath,
  user,
  open,
  onClose,
}: {
  companions: Companion[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onNavigate: (path: string) => void;
  currentPath: string;
  user: AccountUser;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {open && <button className="sidebar-scrim" onClick={onClose} aria-label="Close navigation" />}
      <aside className={cn("sidebar", open && "sidebar--open")} aria-label="Companions">
        <div className="sidebar-header">
          <button className="wordmark wordmark-button" onClick={() => onNavigate("/")}>companions.build</button>
          <Button variant="ghost" size="icon" className="sidebar-close" onClick={onClose} aria-label="Close navigation"><PanelLeftClose /></Button>
        </div>
        <button className={cn("nav-link", currentPath === "/" && "nav-link--active")} onClick={() => onNavigate("/")}><UsersRound />Companions</button>
        <div className="sidebar-label">Your team</div>
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
        <Button variant="outline" className="new-companion" onClick={onCreate}><Plus />New Companion</Button>
        <nav className="sidebar-global" aria-label="Workspace">
          <button className={cn("nav-link", currentPath === "/connections" && "nav-link--active")} onClick={() => onNavigate("/connections")}><Waypoints />Connections</button>
          <button className={cn("nav-link", currentPath === "/account" && "nav-link--active")} onClick={() => onNavigate("/account")}><UserRound />Account<span className="account-initial">{user.email.slice(0, 1).toUpperCase()}</span></button>
        </nav>
      </aside>
    </>
  );
}

function ActivityPanel({ detail, onClose }: { detail: CompanionDetail; onClose: () => void }) {
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
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Chat({ detail, onRefresh, onUnauthorized }: { detail: CompanionDetail; onRefresh: () => Promise<void>; onUnauthorized: () => void }) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
      await onRefresh();
      textareaRef.current?.focus();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setActionError(cause instanceof Error ? cause.message : "Could not send message");
    } finally {
      setSending(false);
    }
  }

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
              <h2>What should {detail.companion.name} work on?</h2>
              <p>Send a task or ask a question to begin.</p>
            </ConversationEmptyState>
          ) : detail.messages.map((message) => (
            <Message from={message.role} key={message.id}>
              {message.role === "assistant" && <span className="message-author">{detail.companion.name}</span>}
              <MessageContent><MessageResponse>{message.content}</MessageResponse></MessageContent>
              {message.files?.length ? <div className="message-files">{message.files.map((file) => <a key={file.id} href={file.url} target="_blank" rel="noreferrer"><FileText /><span>{file.name}</span></a>)}</div> : null}
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
      <form className="composer-wrap" onSubmit={send}>
        {actionError && <p className="composer-error" role="alert">{actionError}</p>}
        {files.length > 0 && <div className="pending-files">{files.map((file, index) => <span key={`${file.name}-${file.lastModified}`}><FileText />{file.name}<button type="button" onClick={() => setFiles((current) => current.filter((_, item) => item !== index))} aria-label={`Remove ${file.name}`}><X /></button></span>)}</div>}
        <div className="composer">
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
              <label className="attach-button" aria-label="Attach files"><Paperclip /><input type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 5))} /></label>
              {activeRun && (
                <Button type="button" variant="outline" size="sm" onClick={cancel}><CircleStop />Cancel</Button>
              )}
              <Button type="submit" size="icon" disabled={!draft.trim() || sending} aria-label="Send message">
                {sending ? <LoaderCircle className="spin" /> : <Send />}
              </Button>
            </div>
          </div>
        </div>
      </form>
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

function SettingsSheet({ detail, models, onClose, onSaved }: { detail: CompanionDetail; models: Array<{ id: string; name: string }>; onClose: () => void; onSaved: () => Promise<void> }) {
  const tabs = ["identity", "routines", "connections", "triggers", "specialists", "delivery"] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]>("identity");
  const [name, setName] = useState(detail.companion.name);
  const [instructions, setInstructions] = useState(detail.companion.instructions);
  const [avatar, setAvatar] = useState(detail.companion.avatar ?? DEFAULT_AVATAR);
  const [modelId, setModelId] = useState(detail.companion.modelId ?? models[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setError("");
    try {
      await api.updateCompanion(detail.companion.id, { name: name.trim(), instructions: instructions.trim(), avatar, modelId: modelId || null });
      await onSaved(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save identity"); }
    finally { setSaving(false); }
  }
  return <div className="sheet-layer" role="presentation">
    <button className="sheet-scrim" onClick={onClose} aria-label="Close settings" />
    <aside className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="sheet-header"><div><span>{detail.companion.name}</span><h2 id="settings-title">Settings</h2></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close settings"><X /></Button></header>
      <nav className="settings-tabs" aria-label="Companion settings">{tabs.map((value) => <button key={value} aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}>{value === "connections" ? "Tools" : value === "specialists" ? "Team" : value[0].toUpperCase() + value.slice(1)}</button>)}</nav>
      {tab === "identity" ? <form className="sheet-content identity-form" onSubmit={save}>
        <AvatarPicker value={avatar} onChange={setAvatar} />
        <div className="field"><label htmlFor="identity-name">Name</label><input id="identity-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></div>
        <div className="field"><label htmlFor="identity-mission">Mission</label><Textarea id="identity-mission" value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={5} maxLength={20_000} /></div>
        {models.length > 0 && <div className="field"><label htmlFor="identity-model">Model</label><select id="identity-model" value={modelId} onChange={(event) => setModelId(event.target.value)}>{models.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}</select></div>}
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="sheet-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={saving || !name.trim()}>{saving ? <LoaderCircle className="spin" /> : <Check />}Save</Button></div>
      </form> : <div className="sheet-content">{tab === "routines" ? <RoutineSettings companionId={detail.companion.id} /> : tab === "connections" ? <CompanionConnections companionId={detail.companion.id} /> : tab === "triggers" ? <TriggerSettings companionId={detail.companion.id} /> : tab === "specialists" ? <SpecialistsSettings companionId={detail.companion.id} /> : <DeliverySettings companionId={detail.companion.id} />}</div>}
    </aside>
  </div>;
}

function CompanionView({ detail, models, onRefresh, onUnauthorized, onMenu }: { detail: CompanionDetail; models: Array<{ id: string; name: string }>; onRefresh: () => Promise<void>; onUnauthorized: () => void; onMenu: () => void }) {
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);

  return (
    <main className="workspace" id="main-content">
      <header className="chat-header">
        <Button className="mobile-menu" variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button>
        <div className="header-identity">
          <CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={38} />
          <div><h1>{detail.companion.name}</h1><span><StatusDot status={detail.companion.status} />{statusLabel(detail.companion.status)}</span></div>
        </div>
        <div className="header-actions">
          {detail.companion.provider === "box" && (
            <Button variant="outline" size="sm" onClick={() => setDesktopOpen(true)}>
              <Computer />
              <span>Desktop</span>
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setActivityOpen(true)} aria-label="Activity"><CalendarClock /><span>Activity</span></Button>
          <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)} aria-label={`Settings for ${detail.companion.name}`}><Settings /></Button>
        </div>
      </header>
      <div className="workspace-body">
        <Chat detail={detail} onRefresh={onRefresh} onUnauthorized={onUnauthorized} />
      </div>
      {activityOpen && <div className="activity-layer"><button className="sheet-scrim" onClick={() => setActivityOpen(false)} aria-label="Close activity" /><ActivityPanel detail={detail} onClose={() => setActivityOpen(false)} /></div>}
      {settingsOpen && <SettingsSheet detail={detail} models={models} onClose={() => setSettingsOpen(false)} onSaved={onRefresh} />}
      {desktopOpen && <DesktopSheet companion={detail.companion} onClose={() => setDesktopOpen(false)} onRefresh={onRefresh} />}
    </main>
  );
}

function Home({ companions, onSelect, onCreate, onMenu }: { companions: Companion[]; onSelect: (id: string) => void; onCreate: () => void; onMenu: () => void }) {
  return <main className="home-page" id="main-content">
    <header className="mobile-page-header"><Button variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button><span className="wordmark">companions.build</span></header>
    <div className="home-inner"><div className="home-heading"><div><h1>Your Companions</h1><p>A small team, each with their own computer.</p></div><Button onClick={onCreate}><Plus />New Companion</Button></div>
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
  const [catalog, setCatalog] = useState<PluginServer[]>([]); const [accounts, setAccounts] = useState<PluginAccount[]>([]); const [error, setError] = useState(""); const [customOpen, setCustomOpen] = useState(false); const [label, setLabel] = useState(""); const [url, setUrl] = useState("");
  const load = useCallback(() => workspaceApi.plugins().then((result) => { setCatalog(result.catalog); setAccounts(result.accounts); }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load connections")), []);
  useEffect(() => { void load(); }, [load]);
  async function connect(server: PluginServer) { setError(""); try { const result = await workspaceApi.connectPlugin(server.id, server.name); if (result.url) window.location.assign(result.url); else await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not connect account"); } }
  async function addCustom(event: FormEvent) { event.preventDefault(); setError(""); try { await workspaceApi.addCustomPlugin({ label: label.trim(), url: url.trim() }); setLabel(""); setUrl(""); setCustomOpen(false); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add MCP server"); } }
  return <main className="simple-page" id="main-content"><header className="mobile-page-header"><Button variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button><span className="wordmark">companions.build</span></header><div className="simple-inner connections-inner"><div className="page-title-row"><div><h1>Connections</h1><p className="muted-copy">Accounts your Companions can use.</p></div><Button variant="outline" onClick={() => setCustomOpen((value) => !value)}><Plus />Custom MCP</Button></div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {customOpen && <form className="custom-connection" onSubmit={addCustom}><div className="field"><label htmlFor="custom-label">Name</label><input id="custom-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Internal tools" /></div><div className="field"><label htmlFor="custom-url">Server URL</label><input id="custom-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" /></div><Button type="submit" disabled={!label.trim() || !url.trim()}>Add server</Button></form>}
    {accounts.length > 0 && <section className="connection-section"><h2>Connected</h2>{accounts.map((account) => <div className="connected-row" key={account.id}><span className="provider-dot">{(account.provider ?? account.label)[0]?.toUpperCase()}</span><div><strong>{account.label}</strong><small>{account.provider ?? account.serverId}</small></div><button className="icon-action" onClick={() => void workspaceApi.deletePlugin(account.id).then(load)} aria-label={`Disconnect ${account.label}`}><Trash2 /></button></div>)}</section>}
    <section className="connection-section"><h2>Add a connection</h2><div className="provider-list">{catalog.map((server) => <div className="provider-row" key={server.id}><span className="provider-dot">{(server.provider ?? server.name)[0]?.toUpperCase()}</span><div><strong>{server.name}</strong><small>{server.description ?? "Tools and events"}</small></div><Button variant="outline" size="sm" onClick={() => void connect(server)}>Connect<ExternalLink /></Button></div>)}</div>{catalog.length === 0 && <div className="quiet-empty"><Waypoints /><strong>No providers available</strong><span>Add a custom MCP server or try again shortly.</span></div>}</section>
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
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(selectedIdFromPath);
  const [detail, setDetail] = useState<CompanionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleApiError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) setAuthRequired(true);
    else setPageError(cause instanceof Error ? cause.message : "Something went wrong");
  }, []);

  const loadList = useCallback(async () => {
    try {
      const result = await api.getCompanions();
      setCompanions(result.companions);
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
      setDetail(result);
      setPageError("");
    } catch (cause) {
      handleApiError(cause);
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
    const onPopState = () => { setCurrentPath(window.location.pathname); setSelectedId(selectedIdFromPath()); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const active = useMemo(
    () => detail?.companion.status === "preparing" || detail?.runs.some((run) => isActiveRun(run.status)),
    [detail],
  );

  useEffect(() => {
    if (!selectedId || authRequired) return;
    void loadDetail();
    const timer = window.setInterval(() => { void loadDetail(); }, active ? ACTIVE_DETAIL_INTERVAL : IDLE_DETAIL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [selectedId, active, authRequired, loadDetail]);

  useEffect(() => {
    if (authRequired) return;
    const timer = window.setInterval(() => { void loadList(); }, LIST_INTERVAL);
    return () => window.clearInterval(timer);
  }, [authRequired, loadList]);

  function selectCompanion(id: string) {
    setSelectedId(id);
    setDetail(null);
    setCreateOpen(false);
    setSidebarOpen(false);
    window.history.pushState({}, "", `/companions/${id}`);
    setCurrentPath(`/companions/${id}`);
  }

  function navigate(path: string) {
    window.history.pushState({}, "", path);
    setCurrentPath(path);
    setSelectedId(selectedIdFromPath());
    setCreateOpen(false);
    setSidebarOpen(false);
  }

  async function signOut() {
    await api.signOut();
    setUser(null); setAuthRequired(true); setCompanions([]); setDetail(null);
    navigate("/");
  }

  function handleCreated(companion: Companion) {
    setCompanions((current) => [companion, ...current]);
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
        onCreate={() => { setCreateOpen(true); setSidebarOpen(false); }}
        onNavigate={navigate}
        currentPath={currentPath}
        user={user}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      {pageError && (
        <div className="page-error" role="alert"><CircleAlert />{pageError}<button onClick={() => void bootstrap()}>Try again</button></div>
      )}
      {currentPath === "/account" && !createOpen ? (
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
        <Home companions={companions} onSelect={selectCompanion} onCreate={() => setCreateOpen(true)} onMenu={() => setSidebarOpen(true)} />
      ) : detail && detail.companion.id === selectedId ? (
        <CompanionView key={detail.companion.id} detail={detail} models={config.models ?? [{ id: config.model, name: config.model }]} onRefresh={loadDetail} onUnauthorized={() => setAuthRequired(true)} onMenu={() => setSidebarOpen(true)} />
      ) : (
        <main className="detail-loading" id="main-content"><LoaderCircle className="spin" /><span>Opening Companion…</span></main>
      )}
    </div>
  );
}
