import { useRef, useState, type FormEvent, type MouseEvent, type RefObject } from "react";
import { Check, MoreHorizontal, Plus, Settings, X } from "lucide-react";
import { discussionApi, type AccountUser, type Companion, type Discussion } from "@/api";
import { AvatarStack, CompanionAvatar } from "../CompanionAvatar";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";
import { useModalFocus } from "@/hooks/useModalFocus";
import { readTheme, setTheme } from "@/lib/theme";
import { RowMenu, RowMenuTrigger, type RowMenuItem, type RowMenuRequest } from "./RowMenu";
import { fullDateLabel, stripPreview, timeLabel } from "./shared";

type CreateDiscussionInput = { title?: string; directCompanionId?: string; participantIds?: string[] };

type SidebarProps = {
  panelRef: RefObject<HTMLElement | null>;
  open: boolean;
  user: AccountUser;
  companions: Companion[];
  discussions: Discussion[];
  selectedId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onArchive: (id: string) => Promise<void>;
  onCreate: (input?: CreateDiscussionInput) => Promise<unknown>;
  onListRefresh: () => Promise<unknown>;
  onShowArchived: () => void;
  onCreateCompanion: () => void;
  onApplications: () => void;
  onAccount: () => void;
  onCompanionSettings?: (id: string) => void;
  onError: (cause: unknown, fallback?: string) => void;
};

/**
 * One rail, one list. Team chats and direct conversations sit together, newest
 * first; the mark tells them apart (a face for direct, a stack for a team).
 */
export function Sidebar({ panelRef, open, user, companions, discussions, selectedId, onClose, onOpen, onArchive, onCreate, onListRefresh, onShowArchived, onCreateCompanion, onApplications, onAccount, onCompanionSettings, onError }: SidebarProps) {
  const [menu, setMenu] = useState<RowMenuRequest | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [theme, setThemeState] = useState(() => readTheme());

  function requestMenu(id: string, label: string, items: RowMenuItem[]) {
    return (anchor: HTMLElement) => setMenu(current => current?.id === id ? null : { id, label, items, anchor });
  }

  function cycleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  }

  async function mutate(action: () => Promise<unknown>) { try { await action(); await onListRefresh(); } catch (cause) { onError(cause); } }

  async function openDirect(companion: Companion, existing?: Discussion) {
    if (existing) { onOpen(existing.id); return; }
    try {
      const result = await discussionApi.directForCompanion(companion.id);
      const found = result.discussions.find(item => !item.archivedAt);
      if (found) onOpen(found.id); else await onCreate({ directCompanionId: companion.id, title: companion.name });
    } catch (cause) { onError(cause); }
  }

  const ordered = [...discussions].sort(byRecency);

  const createItems: RowMenuItem[] = [
    { label: "New team chat", onSelect: () => setTeamOpen(true) },
    ...companions.filter(companion => !companion.retiredAt).map(companion => ({
      label: `Message ${companion.name}`,
      accessibleName: `Message ${companion.name}`,
      onSelect: () => void openDirect(companion, ordered.find(item => item.directCompanionId === companion.id && !item.archivedAt)),
    })),
    { label: "New companion", onSelect: onCreateCompanion },
  ];

  const headerItems: RowMenuItem[] = [
    { label: "Archived discussions", onSelect: onShowArchived },
    { label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", accessibleName: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", onSelect: cycleTheme },
  ];

  return <aside ref={panelRef} tabIndex={-1} className={cn("discussion-sidebar", open && "discussion-sidebar--open")} aria-label="Conversations">
    <header>
      <span className="discussion-wordmark"><img src="/favicon.svg" alt="companions.build" /></span>
      <button type="button" className="sidebar-icon" aria-label="Create" aria-haspopup="menu" aria-expanded={menu?.id === "create"} onClick={event => requestMenu("create", "Create", createItems)(event.currentTarget)}><Plus /></button>
      <button type="button" className="sidebar-icon" aria-label="More options" aria-haspopup="menu" aria-expanded={menu?.id === "header"} onClick={event => requestMenu("header", "Options", headerItems)(event.currentTarget)}><MoreHorizontal /></button>
      <Button className="discussion-sidebar-close" variant="ghost" size="icon" onClick={onClose} aria-label="Close navigation"><X /></Button>
    </header>

    <nav className="discussion-nav" aria-label="Conversations">
      {ordered.map(item => <DiscussionRow
        key={item.id}
        discussion={item}
        companions={companions}
        active={selectedId === item.id}
        renaming={renaming === item.id}
        menuOpen={menu?.id === `discussion:${item.id}`}
        onOpen={onOpen}
        onArchive={onArchive}
        onRename={() => setRenaming(item.id)}
        onRenamed={() => setRenaming(null)}
        onSettings={onCompanionSettings ? () => item.directCompanionId && onCompanionSettings(item.directCompanionId) : undefined}
        onMutate={mutate}
        onMenu={requestMenu}
      />)}
      {!ordered.length && <p className="discussion-rail-empty">Start a team chat, or message a Companion directly.</p>}
    </nav>

    <footer>
      <button onClick={onApplications}><Settings />Applications</button>
      <button onClick={onAccount} aria-label={`Account, ${user.email}`}><span>{(user.name || user.email).slice(0, 1).toUpperCase()}</span>{user.name || user.email}</button>
    </footer>

    {menu && <RowMenu request={menu} onClose={() => setMenu(null)} />}
    {teamOpen && <TeamChatDialog companions={companions} onClose={() => setTeamOpen(false)} onCreate={async input => { await onCreate(input); setTeamOpen(false); }} onError={onError} />}
  </aside>;
}

function byRecency(a: Discussion, b: Discussion) { return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id); }

/** A right click opens the same menu as the row's own trigger, when it has one. */
function openFromRow(event: MouseEvent<HTMLElement>, open: (anchor: HTMLElement) => void) {
  const trigger = event.currentTarget.querySelector<HTMLElement>(".row-menu-trigger");
  if (!trigger) return;
  event.preventDefault();
  open(trigger);
}

function DiscussionRow({ discussion, companions, active, renaming, menuOpen, onOpen, onArchive, onRename, onRenamed, onSettings, onMutate, onMenu }: {
  discussion: Discussion; companions: Companion[]; active: boolean; renaming: boolean; menuOpen: boolean;
  onOpen: (id: string) => void; onArchive: (id: string) => Promise<void>; onRename: () => void; onRenamed: () => void;
  onSettings?: () => void;
  onMutate: (action: () => Promise<unknown>) => Promise<void>;
  onMenu: (id: string, label: string, items: RowMenuItem[]) => (anchor: HTMLElement) => void;
}) {
  const title = discussion.title || "Untitled discussion";
  const last = discussion.lastMessage ?? null;
  const author = last?.companionId ? companions.find(item => item.id === last.companionId)?.name ?? "Companion" : last?.role === "user" ? "You" : "Companion";
  const preview = last ? `${author}: ${stripPreview(last.preview)}` : "No messages yet";
  const direct = discussion.directCompanionId ? companions.find(companion => companion.id === discussion.directCompanionId) : undefined;
  const participants = (discussion.participantIds ?? (direct ? [direct.id] : []))
    .map(id => companions.find(companion => companion.id === id && !companion.retiredAt))
    .filter((companion): companion is Companion => Boolean(companion));
  const requestMenu = onMenu(`discussion:${discussion.id}`, `Options for ${title}`, [
    { label: "Rename", onSelect: onRename },
    ...(onSettings ? [{ label: "Companion settings", accessibleName: `Settings for ${title}`, onSelect: onSettings }] : []),
    { label: "Archive", danger: true, onSelect: () => void onArchive(discussion.id) },
  ]);
  if (renaming) return <RenameRow value={title} label="Conversation name" onCancel={onRenamed} onSave={async name => { await onMutate(() => discussionApi.update(discussion.id, { title: name })); onRenamed(); }} />;
  return <div className="discussion-row" data-menu-open={menuOpen || undefined} onContextMenu={event => openFromRow(event, requestMenu)}>
    <button className={cn("discussion-link", active && "discussion-link--active")} aria-current={active ? "page" : undefined} onClick={() => onOpen(discussion.id)}>
      <span className="discussion-row-mark">
        {direct
          ? <CompanionAvatar name={direct.name} avatar={direct.avatar} sleeping={direct.status === "archived"} size={28}/>
          : participants.length
            ? <AvatarStack companions={participants} size={24}/>
            : <span className="central-mark central-mark--pill" aria-hidden="true">c.</span>}
      </span>
      <span className="discussion-row-copy">
        <span className="discussion-row-title">{title}</span>
        <span className="discussion-row-preview">{preview}</span>
      </span>
      {last && <time className="discussion-row-time" dateTime={last.createdAt} title={fullDateLabel(last.createdAt)}>{timeLabel(last.createdAt)}</time>}
    </button>
    <div className="discussion-row-actions">
      <RowMenuTrigger label={`Options for ${title}`} expanded={menuOpen || false} onOpen={requestMenu} />
    </div>
  </div>;
}

function RenameRow({ value, label, onSave, onCancel, placeholder }: { value: string; label: string; onSave: (name: string) => Promise<void>; onCancel: () => void; placeholder?: string }) {
  const [name, setName] = useState(value);
  return <form
    className="rename-row"
    onSubmit={event => { event.preventDefault(); if (name.trim()) void onSave(name.trim()); }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }}
    onClick={event => event.stopPropagation()}
  >
    <input aria-label={label} placeholder={placeholder} autoFocus value={name} onChange={event => setName(event.target.value)} onBlur={onCancel} />
  </form>;
}

function TeamChatDialog({ companions, onClose, onCreate, onError }: {
  companions: Companion[]; onClose: () => void; onCreate: (input: CreateDiscussionInput) => Promise<unknown>; onError: (cause: unknown, fallback?: string) => void;
}) {
  const modalRef = useModalFocus(true, onClose);
  const available = companions.filter(companion => !companion.retiredAt);
  const [selected, setSelected] = useState(new Set<string>());
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected.size || saving) return;
    setSaving(true);
    try { await onCreate({ title: title.trim() || undefined, participantIds: [...selected] }); }
    catch (cause) { onError(cause, "Could not create this team chat."); setSaving(false); }
  }

  return <><button className="details-scrim" onClick={onClose} aria-label="Close new team chat" />
    <section ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="New team chat" className="team-chat-dialog">
      <header><h2>New team chat</h2><p>Pick the Companions who should work together. You can add more later.</p></header>
      <form onSubmit={submit}>
        <div className="field"><label htmlFor="team-chat-title">Name <span>(optional)</span></label><input id="team-chat-title" value={title} maxLength={120} placeholder="For example: Autumn launch" onChange={event => setTitle(event.target.value)}/></div>
        <fieldset className="team-chat-members">
          <legend>Companions</legend>
          {available.length ? available.map(companion => <label key={companion.id} className="team-chat-member">
            <input type="checkbox" checked={selected.has(companion.id)} onChange={() => setSelected(current => { const next = new Set(current); if (next.has(companion.id)) next.delete(companion.id); else next.add(companion.id); return next; })}/>
            <CompanionAvatar name={companion.name} avatar={companion.avatar} size={28}/>
            <span><strong>{companion.name}</strong><small>{companion.instructions}</small></span>
            {selected.has(companion.id) && <Check className="team-chat-check" aria-hidden="true"/>}
          </label>) : <p className="muted-copy">Create a Companion first, then start a team chat.</p>}
        </fieldset>
        <div className="team-chat-actions"><Button size="sm" variant="ghost" type="button" onClick={onClose}>Cancel</Button><Button size="sm" type="submit" disabled={!selected.size || saving}>{saving ? "Creating…" : "Create team chat"}</Button></div>
      </form>
    </section></>;
}
