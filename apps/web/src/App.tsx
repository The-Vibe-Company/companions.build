import {
  ArrowRight,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Computer,
  LoaderCircle,
  Menu,
  MessageSquare,
  MonitorUp,
  PanelLeftClose,
  Plus,
  Send,
  Server,
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
  type Companion,
  type CompanionDetail,
  isActiveRun,
  type RunStatus,
} from "@/api";
import { cn } from "@/lib/utils";

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

function AccessGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api.createSession(token.trim());
      onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="access-page">
      <form className="access-form" onSubmit={submit}>
        <div className="wordmark wordmark--center">companions.build</div>
        <div>
          <h1>Welcome back</h1>
          <p>Enter your operator access token to continue.</p>
        </div>
        <label htmlFor="access-token">Access token</label>
        <input
          id="access-token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          aria-describedby={error ? "access-error" : undefined}
          aria-invalid={Boolean(error)}
          autoFocus
        />
        {error && <p className="field-error" id="access-error">{error}</p>}
        <Button type="submit" disabled={!token.trim() || submitting}>
          {submitting ? <LoaderCircle className="spin" /> : <ArrowRight />}
          Continue
        </Button>
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
          <div className="companion-glyph"><MessageSquare /></div>
          <h1>Create your first Companion</h1>
          <p>Give them a name and a clear mission. Their chat stays here while they work.</p>
        </div>
      )}
      {compact && <h2>New Companion</h2>}

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
        <span className="field-hint">You can refine this together later.</span>
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
  open,
  onClose,
}: {
  companions: Companion[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {open && <button className="sidebar-scrim" onClick={onClose} aria-label="Close navigation" />}
      <aside className={cn("sidebar", open && "sidebar--open")} aria-label="Companions">
        <div className="sidebar-header">
          <div className="wordmark">companions.build</div>
          <Button variant="ghost" size="icon" className="sidebar-close" onClick={onClose} aria-label="Close navigation"><PanelLeftClose /></Button>
        </div>
        <div className="sidebar-label">Your Companions</div>
        <nav className="companion-list">
          {companions.map((companion) => (
            <button
              key={companion.id}
              className={cn("companion-link", selectedId === companion.id && "companion-link--active")}
              onClick={() => onSelect(companion.id)}
              aria-current={selectedId === companion.id ? "page" : undefined}
            >
              <span className="companion-avatar">{companion.name.slice(0, 1).toUpperCase()}</span>
              <span className="companion-link-copy">
                <strong>{companion.name}</strong>
                <small><StatusDot status={companion.status} />{statusLabel(companion.status)}</small>
              </span>
              <ChevronRight className="companion-chevron" />
            </button>
          ))}
        </nav>
        <Button variant="outline" className="new-companion" onClick={onCreate}><Plus />New Companion</Button>
        <div className="sidebar-footer">Open source · {companions.length} {companions.length === 1 ? "Companion" : "Companions"}</div>
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
              <div className="companion-glyph companion-glyph--small">{detail.companion.name.slice(0, 1).toUpperCase()}</div>
              <h2>What should {detail.companion.name} work on?</h2>
              <p>Send a task, ask a question, or start by refining the mission together.</p>
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
            {activeRun ? (
              <Button type="button" variant="outline" size="sm" onClick={cancel}><CircleStop />Cancel</Button>
            ) : (
              <Button type="submit" size="icon" disabled={!draft.trim() || sending} aria-label="Send message">
                {sending ? <LoaderCircle className="spin" /> : <Send />}
              </Button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}

function CompanionView({ detail, onRefresh, onUnauthorized, onMenu }: { detail: CompanionDetail; onRefresh: () => Promise<void>; onUnauthorized: () => void; onMenu: () => void }) {
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [desktopError, setDesktopError] = useState("");

  async function openDesktop() {
    setDesktopBusy(true);
    setDesktopError("");
    try {
      const { url } = await api.openDesktop(detail.companion.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (cause) {
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
          <h1>{detail.companion.name}</h1>
          <span><StatusDot status={detail.companion.status} />{statusLabel(detail.companion.status)}</span>
        </div>
        <div className="header-actions">
          {desktopError && <span className="desktop-error" role="alert">{desktopError}</span>}
          {detail.companion.provider === "box" && (
            <Button variant="outline" size="sm" onClick={openDesktop} disabled={desktopBusy || detail.companion.status !== "ready"}>
              {desktopBusy ? <LoaderCircle className="spin" /> : <MonitorUp />}
              <span>Open desktop</span>
            </Button>
          )}
        </div>
      </header>
      <div className="workspace-body">
        <Chat detail={detail} onRefresh={onRefresh} onUnauthorized={onUnauthorized} />
        <ActivityPanel detail={detail} />
      </div>
    </main>
  );
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
    try {
      const [nextConfig, list] = await Promise.all([api.getConfig(), api.getCompanions()]);
      setConfig(nextConfig);
      setCompanions(list.companions);
      setAuthRequired(false);
      const pathId = selectedIdFromPath();
      const nextId = pathId || list.companions[0]?.id || null;
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
    const onPopState = () => setSelectedId(selectedIdFromPath());
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
  }

  function handleCreated(companion: Companion) {
    setCompanions((current) => [companion, ...current]);
    selectCompanion(companion.id);
    void loadList();
  }

  if (authRequired) return <AccessGate onAuthenticated={() => void bootstrap()} />;
  if (loading || !config) return <LoadingApp />;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <Sidebar
        companions={companions}
        selectedId={selectedId}
        onSelect={selectCompanion}
        onCreate={() => { setCreateOpen(true); setSidebarOpen(false); }}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      {pageError && (
        <div className="page-error" role="alert"><CircleAlert />{pageError}<button onClick={() => void bootstrap()}>Try again</button></div>
      )}
      {companions.length === 0 || createOpen ? (
        <main className="onboarding" id="main-content">
          <div className="onboarding-mobile-header"><Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu /></Button><span className="wordmark">companions.build</span></div>
          <CreateCompanion config={config} onCreated={handleCreated} compact={companions.length > 0} />
          <div className="model-note"><Server />Using {config.model}</div>
        </main>
      ) : detail && detail.companion.id === selectedId ? (
        <CompanionView detail={detail} onRefresh={loadDetail} onUnauthorized={() => setAuthRequired(true)} onMenu={() => setSidebarOpen(true)} />
      ) : (
        <main className="detail-loading" id="main-content"><LoaderCircle className="spin" /><span>Opening Companion…</span></main>
      )}
    </div>
  );
}
