import {
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Computer,
  LoaderCircle,
  LogOut,
  Mail,
  Menu,
  MonitorUp,
  PanelLeftClose,
  Plus,
  Settings,
  Send,
  Server,
  UserRound,
  UsersRound,
  Waypoints,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
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
} from "@/api";
import { cn } from "@/lib/utils";
import { AvatarPicker, CompanionAvatar, DEFAULT_AVATAR, type CompanionAvatarValue } from "@/components/CompanionAvatar";

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

function ActivityPanel({ detail }: { detail: CompanionDetail }) {
  const latestRuns = detail.runs.slice().reverse().slice(0, 8);
  return (
    <aside className="activity-panel" aria-label="Activity">
      <div className="activity-heading">
        <span>Activity</span>
        <span className="model-badge">{detail.companion.provider === "box" ? "Box" : "Local"}</span>
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
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Chat({ detail, onRefresh, onUnauthorized }: { detail: CompanionDetail; onRefresh: () => Promise<void>; onUnauthorized: () => void }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeRun = detail.runs.find((run) => isActiveRun(run.status));

  async function send(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setActionError("");
    try {
      await api.sendMessage(detail.companion.id, content);
      setDraft("");
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
              <MessageContent><p className="message-text">{message.content}</p></MessageContent>
              <time className="message-time" dateTime={message.createdAt}>{readableDate(message.createdAt)}</time>
            </Message>
          ))}
          {activeRun && (
            <div className="working-row" role="status">
              <span className="working-dots"><i /><i /><i /></span>
              {activeRun.status === "queued" ? "Queued" : activeRun.status === "preparing" ? "Preparing" : `${detail.companion.name} is working`}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest message" />
      </Conversation>
      <form className="composer-wrap" onSubmit={send}>
        {actionError && <p className="composer-error" role="alert">{actionError}</p>}
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

function IdentitySheet({ detail, onClose, onSaved }: { detail: CompanionDetail; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(detail.companion.name);
  const [instructions, setInstructions] = useState(detail.companion.instructions);
  const [avatar, setAvatar] = useState(detail.companion.avatar ?? DEFAULT_AVATAR);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setError("");
    try {
      await api.updateCompanion(detail.companion.id, { name: name.trim(), instructions: instructions.trim(), avatar });
      await onSaved(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save identity"); }
    finally { setSaving(false); }
  }
  return <div className="sheet-layer" role="presentation">
    <button className="sheet-scrim" onClick={onClose} aria-label="Close settings" />
    <aside className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="identity-title">
      <header className="sheet-header"><div><span>Settings</span><h2 id="identity-title">Identity</h2></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close settings">×</Button></header>
      <form className="sheet-content identity-form" onSubmit={save}>
        <AvatarPicker value={avatar} onChange={setAvatar} />
        <div className="field"><label htmlFor="identity-name">Name</label><input id="identity-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></div>
        <div className="field"><label htmlFor="identity-mission">Mission</label><Textarea id="identity-mission" value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={5} maxLength={20_000} /></div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="sheet-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={saving || !name.trim()}>{saving ? <LoaderCircle className="spin" /> : <Check />}Save</Button></div>
      </form>
    </aside>
  </div>;
}

function CompanionView({ detail, onRefresh, onUnauthorized, onMenu }: { detail: CompanionDetail; onRefresh: () => Promise<void>; onUnauthorized: () => void; onMenu: () => void }) {
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [desktopError, setDesktopError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  async function openDesktop() {
    const desktopWindow = window.open("about:blank", "_blank");
    if (desktopWindow) desktopWindow.opener = null;
    setDesktopBusy(true);
    setDesktopError("");
    try {
      const { url } = await api.openDesktop(detail.companion.id);
      if (desktopWindow) desktopWindow.location.replace(url);
      else setDesktopError("Allow pop-ups to open the desktop.");
    } catch (cause) {
      desktopWindow?.close();
      setDesktopError(cause instanceof Error ? cause.message : "Desktop is unavailable");
    } finally {
      setDesktopBusy(false);
    }
  }

  return (
    <main className="workspace" id="main-content">
      <header className="chat-header">
        <Button className="mobile-menu" variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button>
        <div className="header-identity">
          <CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={38} />
          <div><h1>{detail.companion.name}</h1><span><StatusDot status={detail.companion.status} />{statusLabel(detail.companion.status)}</span></div>
        </div>
        <div className="header-actions">
          {desktopError && <span className="desktop-error" role="alert">{desktopError}</span>}
          {detail.companion.provider === "box" && (
            <Button variant="outline" size="sm" onClick={openDesktop} disabled={desktopBusy || detail.companion.status !== "ready"}>
              {desktopBusy ? <LoaderCircle className="spin" /> : <MonitorUp />}
              <span>Open desktop</span>
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)} aria-label={`Settings for ${detail.companion.name}`}><Settings /></Button>
        </div>
      </header>
      <div className="workspace-body">
        <Chat detail={detail} onRefresh={onRefresh} onUnauthorized={onUnauthorized} />
        <ActivityPanel detail={detail} />
      </div>
      {settingsOpen && <IdentitySheet detail={detail} onClose={() => setSettingsOpen(false)} onSaved={onRefresh} />}
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
  return <main className="simple-page" id="main-content"><header className="mobile-page-header"><Button variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button><span className="wordmark">companions.build</span></header><div className="simple-inner"><h1>Account</h1><div className="account-row"><span className="large-initial">{user.email.slice(0, 1).toUpperCase()}</span><div><strong>{user.name || user.email}</strong><small>{user.email}</small></div></div><Button variant="outline" onClick={() => void onSignOut()}><LogOut />Sign out</Button></div></main>;
}

function ConnectionsPage({ onMenu }: { onMenu: () => void }) {
  return <main className="simple-page" id="main-content"><header className="mobile-page-header"><Button variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button><span className="wordmark">companions.build</span></header><div className="simple-inner"><h1>Connections</h1><p className="muted-copy">Connect the tools your Companions can use.</p><div className="quiet-empty"><Waypoints /><strong>No connections yet</strong><span>Add your first connection when the provider catalog is available.</span></div></div></main>;
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
        <CompanionView key={detail.companion.id} detail={detail} onRefresh={loadDetail} onUnauthorized={() => setAuthRequired(true)} onMenu={() => setSidebarOpen(true)} />
      ) : (
        <main className="detail-loading" id="main-content"><LoaderCircle className="spin" /><span>Opening Companion…</span></main>
      )}
    </div>
  );
}
