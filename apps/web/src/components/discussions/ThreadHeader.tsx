import { useState } from "react";
import { Menu, Pencil, PanelRight, Plus, UserPlus } from "lucide-react";
import { discussionApi, type Companion, type Discussion } from "@/api";
import { AvatarStack, CompanionAvatar } from "../CompanionAvatar";
import { Button } from "../ui/button";

export function ThreadHeader({ discussion, direct, participants, companions, workspaceOpen, onMenu, onToggleWorkspace, onAddParticipant, onRefresh, onListRefresh, onError }: {
  discussion: Discussion; direct: Companion | null | undefined; participants: Companion[]; companions: Companion[];
  workspaceOpen: boolean; onMenu: () => void; onToggleWorkspace: () => void;
  onAddParticipant: (companionId: string) => Promise<void>;
  onRefresh: () => Promise<void>; onListRefresh: () => Promise<unknown>; onError: (cause: unknown) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(discussion.title);
  const [adding, setAdding] = useState(false);
  async function saveTitle() { if (!title.trim()) return; try { await discussionApi.update(discussion.id, { title: title.trim() }); setEditingTitle(false); await onListRefresh(); await onRefresh(); } catch (cause) { onError(cause); } }
  function cancelTitle() { setTitle(discussion.title); setEditingTitle(false); }
  const available = direct ? [] : companions.filter(companion => !companion.retiredAt && !participants.some(participant => participant.id === companion.id));

  return <header className="discussion-header">
    <Button className="discussion-mobile-menu" variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button>
    <span className="header-participants" aria-hidden="true">
      {direct
        ? <CompanionAvatar name={direct.name} avatar={direct.avatar} sleeping={direct.status === "archived"} size={26}/>
        : participants.length
          ? <AvatarStack companions={participants} size={26}/>
          : <span className="central-mark central-mark--stack">c.</span>}
    </span>
    <div className="discussion-title">
      {editingTitle
        ? <form onSubmit={event => { event.preventDefault(); void saveTitle(); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancelTitle(); } }}><input aria-label="Conversation title" value={title} onChange={event => setTitle(event.target.value)} autoFocus /><Button size="sm" type="submit">Save</Button></form>
        : <button onClick={() => setEditingTitle(true)} aria-label="Rename conversation"><h1>{discussion.title || "Untitled conversation"}</h1><Pencil /></button>}
      {!direct && participants.length > 0 && <span>{participants.length} companion{participants.length === 1 ? "" : "s"}</span>}
    </div>
    {available.length > 0 && <div className="header-add">
      <Button variant="ghost" size="icon" aria-label="Add a companion" aria-expanded={adding} onClick={() => setAdding(value => !value)}><Plus /></Button>
      {adding && <>
        <button className="header-add-scrim" aria-label="Close add companion" onClick={() => setAdding(false)} />
        <div className="header-add-menu" role="menu" aria-label="Add a companion">
          <strong><UserPlus aria-hidden="true" /> Add a companion</strong>
          {available.map(companion => <button key={companion.id} role="menuitem" onClick={async () => { setAdding(false); await onAddParticipant(companion.id); }}><CompanionAvatar name={companion.name} avatar={companion.avatar} size={24}/><span>{companion.name}</span></button>)}
        </div>
      </>}
    </div>}
    <Button className="header-workspace" variant={workspaceOpen ? "secondary" : "ghost"} size="icon" onClick={onToggleWorkspace} aria-label="Workspace" aria-expanded={workspaceOpen}><PanelRight /></Button>
  </header>;
}
