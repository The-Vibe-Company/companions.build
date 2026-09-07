import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, CopyPlus, LoaderCircle, Plus, RotateCw, UserRoundMinus, X } from "lucide-react";
import { workspaceApi, type AgentTemplate, type AgentTemplateRevision, type Companion, type CompanionTemplatePermission } from "@/api";
import { AvatarPicker, CompanionAvatar, DEFAULT_AVATAR, type CompanionAvatarValue } from "@/components/CompanionAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import "./TeamPanel.css";

const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong.";

type TeamMember = {
  profile: AgentTemplate;
  permission: CompanionTemplatePermission;
};

export function TeamPanel({ companion, onOpenCompanion }: { companion: Companion; onOpenCompanion: (id: string) => void }) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [permissions, setPermissions] = useState<CompanionTemplatePermission[]>([]);
  const [replicas, setReplicas] = useState<Companion[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<"" | "existing" | "new">("");
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [avatar, setAvatar] = useState<CompanionAvatarValue>(DEFAULT_AVATAR);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const pendingCreated = useRef<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [profileResult, permissionResult, replicaResult] = await Promise.all([
        workspaceApi.templates(),
        workspaceApi.companionTemplates(companion.id),
        workspaceApi.replicas(companion.id),
      ]);
      setTemplates(profileResult.templates);
      setPermissions(permissionResult.templates);
      setReplicas(replicaResult.replicas);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [companion.id]);

  useEffect(() => { void load(); }, [load]);

  const team = useMemo<TeamMember[]>(() => permissions
    .filter(permission => permission.maxChildren > 0)
    .map(permission => ({
      permission,
      profile: templates.find(template => template.id === permission.templateId) ?? {
        id: permission.templateId,
        name: permission.name,
        instructions: "",
        avatar: DEFAULT_AVATAR,
        revision: permission.revision,
        sourceCompanionId: null,
        hasSnapshot: false,
      },
    })), [permissions, templates]);
  const available = useMemo(() => templates.filter(template => !team.some(member => member.profile.id === template.id)), [team, templates]);

  useEffect(() => {
    if (adding !== "existing") return;
    setSelectedId(current => available.some(item => item.id === current) ? current : available[0]?.id ?? "");
  }, [adding, available]);

  function closeAdd() {
    setAdding("");
    setSelectedId("");
    setError("");
    if (!pendingCreated.current) {
      setName("");
      setInstructions("");
      setAvatar(DEFAULT_AVATAR);
    }
  }

  async function authorize(templateId: string) {
    await workspaceApi.setTemplatePermission(companion.id, templateId, 2);
    await load();
  }

  async function addExisting(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    setBusy("add-existing"); setError("");
    try {
      await authorize(selectedId);
      setAdding(""); setSelectedId("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy("");
    }
  }

  async function createAndAdd(event: FormEvent) {
    event.preventDefault();
    setBusy("create"); setError("");
    try {
      let created = pendingCreated.current;
      if (!created) {
        const result = await workspaceApi.createTemplate({ name: name.trim(), instructions: instructions.trim(), avatar });
        created = { id: result.id, name: name.trim() };
        pendingCreated.current = created;
      }
      await authorize(created.id);
      pendingCreated.current = null;
      setName(""); setInstructions(""); setAvatar(DEFAULT_AVATAR); setAdding("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy("");
    }
  }

  return <main className="team-panel" aria-labelledby="team-title">
    <header className="team-heading">
      <div><h1 id="team-title">Who can help {companion.name}?</h1><p>Specialists are reusable profiles {companion.name} can call on for focused work.</p></div>
      <Button onClick={() => setAdding(available.length ? "existing" : "new")} disabled={!!busy || !!adding}><Plus />Add specialist</Button>
    </header>

    {error && !adding && <div className="team-error" role="alert"><span>{error}</span>{loading ? <Button variant="outline" size="sm" onClick={() => { setLoading(true); void load(); }}><RotateCw />Retry</Button> : null}</div>}

    <section className="team-coordinator" aria-labelledby="coordinator-title">
      <div className="team-section-label" id="coordinator-title">Coordinator</div>
      <div className="team-person team-person--coordinator">
        <CompanionAvatar name={companion.name} avatar={companion.avatar} size={56} />
        <div><strong>{companion.name}</strong><p>{companion.instructions || "Your permanent point of contact."}</p></div>
      </div>
    </section>

    <section className="team-specialists" aria-labelledby="specialists-title">
      <div className="team-section-label" id="specialists-title">Specialists</div>
      {loading ? <TeamSkeleton /> : team.length ? <div className="team-list">{team.map(member =>
        <SpecialistRow key={member.profile.id} companionId={companion.id} member={member} busy={busy} setBusy={setBusy} onError={setError} onReload={load} />
      )}</div> : <div className="team-empty"><p>{companion.name} does not have any specialists yet.</p><span>Add a reusable profile now; you can assign work later.</span></div>}
    </section>

    {adding && <section className="team-add" aria-labelledby="add-specialist-title">
      <div className="team-add-heading"><div><h2 id="add-specialist-title">{adding === "existing" ? "Add a specialist" : "Create a specialist"}</h2><p>{adding === "existing" ? "Choose a profile to make available to this coordinator." : "Define the role first. Appearance is optional."}</p></div><Button variant="ghost" size="icon" aria-label="Close add specialist" onClick={closeAdd} disabled={!!busy}><X /></Button></div>
      {adding === "existing" ? <form onSubmit={addExisting}>
        <fieldset className="team-profile-choices"><legend>Existing profiles</legend>{available.map(profile => <label key={profile.id}><input type="radio" name="team-profile" value={profile.id} checked={selectedId === profile.id} onChange={() => setSelectedId(profile.id)} /><CompanionAvatar name={profile.name} avatar={profile.avatar} size={44} /><span><strong>{profile.name}</strong><small>{profile.instructions || "No role description yet."}</small></span></label>)}</fieldset>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="team-form-actions"><Button type="submit" disabled={!selectedId || !!busy}>{busy === "add-existing" ? <LoaderCircle className="spin" /> : <Check />}Add to team</Button><Button type="button" variant="ghost" disabled={!!busy} onClick={() => { setAdding("new"); setError(""); }}>Create a new profile</Button></div>
      </form> : <form onSubmit={createAndAdd}>
        {pendingCreated.current ? <p className="team-partial" role="status"><strong>{pendingCreated.current.name} was created.</strong> Adding it to {companion.name}&apos;s team still needs to finish.</p> : <>
          <div className="field"><label htmlFor="team-profile-name">Name</label><input autoFocus id="team-profile-name" value={name} onChange={event => setName(event.target.value)} placeholder="Researcher" /></div>
          <div className="field"><label htmlFor="team-profile-role">Role</label><Textarea id="team-profile-role" rows={3} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Research sources and summarize findings" /></div>
          <details className="team-appearance"><summary><CompanionAvatar name="Profile preview" avatar={avatar} size={36} />Customize appearance<ChevronDown /></summary><AvatarPicker value={avatar} onChange={setAvatar} /></details>
        </>}
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="team-form-actions"><Button type="submit" disabled={(!pendingCreated.current && !name.trim()) || !!busy}>{busy === "create" ? <LoaderCircle className="spin" /> : <Check />}{pendingCreated.current ? "Retry adding" : "Create and add"}</Button>{available.length > 0 && !pendingCreated.current && <Button type="button" variant="ghost" disabled={!!busy} onClick={() => { setAdding("existing"); setError(""); }}>Choose existing</Button>}</div>
      </form>}
    </section>}

    {!!replicas.length && <section className="team-work" aria-labelledby="team-work-title"><div><h2 id="team-work-title">Work in progress</h2><p>Specialist interventions currently available.</p></div><div className="team-work-list">{replicas.map(replica => <button type="button" key={replica.id} onClick={() => onOpenCompanion(replica.id)} aria-label={`Open ${replica.name}'s work`}><CompanionAvatar name={replica.name} avatar={replica.avatar} size={40} /><span><strong>{replica.name}</strong><small>{replica.status}</small></span><span>Open</span></button>)}</div></section>}
  </main>;
}

function TeamSkeleton() {
  return <div className="team-list" role="status" aria-label="Loading specialists"><div className="team-person team-person--skeleton"><span /><div><i /><i /></div></div><div className="team-person team-person--skeleton"><span /><div><i /><i /></div></div></div>;
}

function SpecialistRow({ companionId, member, busy, setBusy, onError, onReload }: {
  companionId: string;
  member: TeamMember;
  busy: string;
  setBusy: (value: string) => void;
  onError: (value: string) => void;
  onReload: () => Promise<void>;
}) {
  const [assigning, setAssigning] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [revisions, setRevisions] = useState<AgentTemplateRevision[] | null>(null);
  const [restoreRevision, setRestoreRevision] = useState("");

  async function assign(event: FormEvent) {
    event.preventDefault(); setBusy(`spawn:${member.profile.id}`); onError("");
    try {
      await workspaceApi.spawnReplica(companionId, member.profile.id, prompt.trim());
      setPrompt(""); setAssigning(false); await onReload();
    } catch (cause) { onError(errorText(cause)); }
    finally { setBusy(""); }
  }

  async function loadRevisions() {
    if (revisions) return;
    try {
      const result = await workspaceApi.templateRevisions(member.profile.id);
      setRevisions(result.revisions);
      setRestoreRevision(String(result.revisions.find(item => item.revision !== member.profile.revision)?.revision ?? ""));
    } catch (cause) { onError(errorText(cause)); }
  }

  async function changeLimit(value: number) {
    setBusy(`limit:${member.profile.id}`); onError("");
    try { await workspaceApi.setTemplatePermission(companionId, member.profile.id, value); await onReload(); }
    catch (cause) { onError(errorText(cause)); }
    finally { setBusy(""); }
  }

  async function restore() {
    if (!restoreRevision) return;
    setBusy(`restore:${member.profile.id}`); onError("");
    try { await workspaceApi.rollbackTemplate(member.profile.id, Number(restoreRevision), member.profile.revision); setRevisions(null); await onReload(); }
    catch (cause) { onError(errorText(cause)); }
    finally { setBusy(""); }
  }

  return <article className="team-member">
    <div className="team-person"><CompanionAvatar name={member.profile.name} avatar={member.profile.avatar} size={48} /><div><strong>{member.profile.name}</strong><p>{member.profile.instructions || "Focused specialist profile."}</p></div><Button variant="outline" size="sm" onClick={() => setAssigning(value => !value)} aria-expanded={assigning} aria-controls={`assign-${member.profile.id}`}>Assign a task</Button></div>
    {assigning && <form className="team-task" id={`assign-${member.profile.id}`} onSubmit={assign}><div className="field"><label htmlFor={`task-${member.profile.id}`}>What should {member.profile.name} do?</label><Textarea autoFocus id={`task-${member.profile.id}`} rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} /></div><div className="team-form-actions"><Button type="submit" disabled={!prompt.trim() || !!busy}>{busy === `spawn:${member.profile.id}` ? <LoaderCircle className="spin" /> : <CopyPlus />}Start task</Button><Button type="button" variant="ghost" disabled={!!busy} onClick={() => setAssigning(false)}>Cancel</Button></div></form>}
    <details className="team-advanced" onToggle={event => { if (event.currentTarget.open) void loadRevisions(); }}><summary>Profile settings</summary><div className="team-advanced-content"><label>Simultaneous copies<select value={member.permission.maxChildren} disabled={!!busy} onChange={event => void changeLimit(Number(event.target.value))}>{[1, 2, 3, 5, 10, 20].map(value => <option key={value} value={value}>{value}</option>)}</select></label>{revisions === null ? <span className="team-muted">Loading version history…</span> : revisions.length > 1 ? <div className="team-restore"><label>Earlier version<select value={restoreRevision} onChange={event => setRestoreRevision(event.target.value)}>{revisions.filter(item => item.revision !== member.profile.revision).map(item => <option value={item.revision} key={item.revision}>Version {item.revision} · {item.name}</option>)}</select></label><Button type="button" variant="outline" size="sm" disabled={!restoreRevision || !!busy} onClick={() => void restore()}>{busy === `restore:${member.profile.id}` ? <LoaderCircle className="spin" /> : <RotateCw />}Restore</Button></div> : <span className="team-muted">Version {member.profile.revision} is the only saved version.</span>}<Button className="team-remove" type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => void changeLimit(0)}><UserRoundMinus />Remove from team</Button></div></details>
  </article>;
}

export default TeamPanel;
