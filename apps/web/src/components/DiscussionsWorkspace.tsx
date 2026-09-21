import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, X } from "lucide-react";
import { ApiError, discussionApi, type AccountUser, type Companion, type Discussion, type DiscussionSnapshot } from "@/api";
import { Button } from "./ui/button";
import { useModalFocus } from "@/hooks/useModalFocus";
import { Sidebar } from "./discussions/Sidebar";
import { Thread } from "./discussions/Thread";
import { ArchivedPanel } from "./discussions/DetailsPanel";
import { POLL_INTERVAL, mergeMessages } from "./discussions/shared";
import "./discussions/styles/index.css";

type Props = {
  user: AccountUser;
  companions: Companion[];
  initialDiscussionId: string | null;
  legacyCompanionId: string | null;
  onUnauthorized: () => void;
  onCreateCompanion: () => void;
  onApplications: () => void;
  onAccount: () => void;
  onCompanionSettings?: (id: string) => void;
};

export function DiscussionsWorkspace({ user, companions, initialDiscussionId, legacyCompanionId, onUnauthorized, onCreateCompanion, onApplications, onAccount, onCompanionSettings }: Props) {
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [selectedId, setSelectedId] = useState(initialDiscussionId);
  const [snapshot, setSnapshot] = useState<DiscussionSnapshot | null>(null);
  const [olderMessages, setOlderMessages] = useState<DiscussionSnapshot["messages"]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingDiscussion, setLoadingDiscussion] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderCursor = useRef<string | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useModalFocus(sidebarOpen, () => setSidebarOpen(false), "(max-width: 1024px)");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [archived, setArchived] = useState<Discussion[]>([]);
  const creationIntents = useRef(new Map<string, string>());
  const currentId = useRef(selectedId);
  const snapshotRef = useRef(snapshot);
  currentId.current = selectedId;
  snapshotRef.current = snapshot;

  const handleError = useCallback((cause: unknown, fallback = "Something went wrong.") => {
    if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
    else setError(cause instanceof Error ? cause.message : fallback);
  }, [onUnauthorized]);

  const loadList = useCallback(async () => {
    const result = await discussionApi.list();
    setDiscussions(result.discussions);
    return result;
  }, []);

  const openDiscussion = useCallback((id: string, replace = false) => {
    setSelectedId(id);
    setSnapshot(null);
    setOlderMessages([]);
    olderCursor.current = undefined;
    currentId.current = id;
    setSidebarOpen(false);
    const path = `/discussions/${id}`;
    window.history[replace ? "replaceState" : "pushState"]({}, "", path);
  }, []);

  const createDiscussion = useCallback(async (input: { title?: string; directCompanionId?: string; participantIds?: string[] } = {}) => {
    const signature = JSON.stringify({ title: input.title, directCompanionId: input.directCompanionId, participantIds: input.participantIds ?? [] });
    const clientCreationId = creationIntents.current.get(signature) ?? crypto.randomUUID();
    creationIntents.current.set(signature, clientCreationId);
    const result = await discussionApi.create({ clientCreationId, title: input.title, directCompanionId: input.directCompanionId });
    // A team chat is created with its people: each invitation is durable once accepted.
    for (const companionId of input.participantIds ?? []) {
      if (companionId === input.directCompanionId) continue;
      await discussionApi.addParticipant(result.discussion.id, companionId).catch(cause => handleError(cause, "One participant could not be added."));
    }
    creationIntents.current.delete(signature);
    setDiscussions(current => [result.discussion, ...current.filter(item => item.id !== result.discussion.id)]);
    openDiscussion(result.discussion.id);
    return result.discussion;
  }, [openDiscussion, handleError]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await loadList();
        if (!active) return;
        if (legacyCompanionId) {
          const direct = await discussionApi.directForCompanion(legacyCompanionId);
          if (!active) return;
          const latest = direct.discussions.find(item => !item.archivedAt) ?? await createDiscussion({ directCompanionId: legacyCompanionId }).catch(() => null);
          if (latest) openDiscussion(latest.id, true);
        } else if (initialDiscussionId) {
          setSelectedId(initialDiscussionId);
        } else if (list.discussions.find(item => !item.directCompanionId)) {
          openDiscussion(list.discussions.find(item => !item.directCompanionId)!.id, true);
        } else if (list.discussions[0]) {
          openDiscussion(list.discussions[0].id, true);
        } else if (companions.length > 0) {
          await createDiscussion({ title: "New discussion" });
        }
        // With no companions and no conversations there is nothing to open; the shell
        // offers to create a first Companion instead of manufacturing an empty chat.
      } catch (cause) { if (active) handleError(cause, "Could not load conversations."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    const id = currentId.current;
    if (!id) return;
    if (!quiet) setLoadingDiscussion(true);
    try {
      const result = await discussionApi.snapshot(id);
      if (currentId.current !== id) return;
      if (olderCursor.current !== undefined && snapshotRef.current?.discussion.id === id) setOlderMessages(current => mergeMessages(current, snapshotRef.current!.messages.filter(message => !result.messages.some(next => next.id === message.id))));
      setSnapshot({...result,beforeCursor:olderCursor.current===undefined?result.beforeCursor:olderCursor.current});
      // The snapshot has no preview; keep the one the list poll provides.
      setDiscussions(current => current.map(item => item.id === result.discussion.id ? { ...item, ...result.discussion, participantIds: result.participants.filter(participant => !participant.removedAt).map(participant => participant.companionId) } : item));
      setRefreshError("");
    } catch (cause) {
      if (currentId.current !== id) return;
      if (quiet && !(cause instanceof ApiError && cause.status === 401)) setRefreshError("Updates are unavailable. The last received messages are still shown.");
      else handleError(cause, "Could not open this conversation.");
    }
    finally { if (currentId.current === id && !quiet) setLoadingDiscussion(false); }
  }, [handleError]);

  useEffect(() => { void refresh(); }, [selectedId, refresh]);
  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setInterval(() => { void refresh(true); void loadList().catch(cause => handleError(cause)); }, POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [selectedId, refresh, loadList, handleError]);
  useEffect(() => {
    const pop = () => { const id = window.location.pathname.match(/^\/discussions\/([^/]+)$/)?.[1] ?? null; setSelectedId(id); currentId.current=id; olderCursor.current=undefined; setSnapshot(null); setOlderMessages([]); };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  async function loadOlder() {
    if (!snapshot?.beforeCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const id=snapshot.discussion.id;
      const page = await discussionApi.snapshot(id, snapshot.beforeCursor);
      if(currentId.current!==id)return;
      olderCursor.current=page.beforeCursor;
      setOlderMessages(current => mergeMessages(page.messages, current));
      setSnapshot(current => current ? { ...current, beforeCursor: page.beforeCursor } : current);
    } catch (cause) { handleError(cause, "Could not load older messages."); }
    finally { setLoadingOlder(false); }
  }

  async function showArchived() {
    setArchivedOpen(true); setLoadingArchived(true); setArchiveError("");
    try { setArchived((await discussionApi.list(true)).discussions.filter(item => item.archivedAt)); }
    catch (cause) { setArchiveError("Could not load archived conversations."); if (cause instanceof ApiError && cause.status === 401) onUnauthorized(); }
    finally { setLoadingArchived(false); }
  }

  async function archiveDiscussion(id: string) {
    try {
      await discussionApi.update(id, { archived: true });
      setDiscussions(current => current.filter(item => item.id !== id));
      if (currentId.current === id) {
        const next = discussions.find(item => item.id !== id);
        if (next) openDiscussion(next.id, true);
        else if (companions.length > 0) await createDiscussion({ title: "New discussion" });
        else { setSelectedId(null); setSnapshot(null); window.history.replaceState({}, "", "/"); }
      }
    } catch (cause) { handleError(cause, "Could not archive this conversation."); }
  }
  async function archiveCurrent() { if (snapshot) await archiveDiscussion(snapshot.discussion.id); }

  if (loading) return <div className="discussion-loading" role="status"><div/><div/><main><span/><span/></main></div>;

  return <div className="discussion-shell">
    <a className="skip-link" href="#discussion-main">Skip to conversation</a>
    {sidebarOpen && <button className="discussion-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <Sidebar
      panelRef={sidebarRef}
      open={sidebarOpen}
      user={user}
      companions={companions}
      discussions={discussions}
      selectedId={selectedId}
      onClose={() => setSidebarOpen(false)}
      onOpen={openDiscussion}
      onArchive={archiveDiscussion}
      onCreate={createDiscussion}
      onListRefresh={loadList}
      onShowArchived={() => void showArchived()}
      onCreateCompanion={onCreateCompanion}
      onApplications={onApplications}
      onAccount={onAccount}
      onCompanionSettings={onCompanionSettings}
      onError={handleError}
    />
    {error && <div className="discussion-error" role="alert"><CircleAlert />{error}<button onClick={() => setError("")} aria-label="Dismiss error"><X /></button></div>}
    <main className="discussion-main" id="discussion-main">
      {refreshError && <div className="refresh-notice" role="status">{refreshError}<Button variant="ghost" size="sm" onClick={() => void refresh(true)}>Retry updates</Button></div>}
      {loadingDiscussion && !snapshot ? <div className="discussion-opening" role="status"><LoaderCircle className="spin" />Opening conversation…</div> : snapshot ? <Thread
        key={snapshot.discussion.id}
        user={user}
        snapshot={snapshot}
        olderMessages={olderMessages}
        companions={companions}
        onMenu={() => setSidebarOpen(true)}
        onRefresh={() => refresh(true)}
        onListRefresh={loadList}
        onArchive={archiveCurrent}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
        onError={handleError}
      /> : companions.length === 0 ? <div className="discussion-first-run"><h2>Create your first Companion</h2><p>Companions do the work in a conversation. Create one, then start a direct chat or a team chat.</p><Button onClick={onCreateCompanion}>Create a Companion</Button></div> : <div className="discussion-opening" role="status">Choose a conversation</div>}
    </main>
    {archivedOpen && <ArchivedPanel loading={loadingArchived} error={archiveError} onRetry={() => void showArchived()} discussions={archived} onClose={() => setArchivedOpen(false)} onRestore={async discussion => { try { await discussionApi.update(discussion.id, { archived: false }); setArchived(current => current.filter(item => item.id !== discussion.id)); await loadList(); openDiscussion(discussion.id); setArchivedOpen(false); } catch (cause) { handleError(cause); } }} />}
  </div>;
}
