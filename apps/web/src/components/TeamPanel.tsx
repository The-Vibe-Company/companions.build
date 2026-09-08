import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, CopyPlus, LoaderCircle, Plus, RotateCw, UserRoundMinus, X } from "lucide-react";
import { workspaceApi, type AgentTemplate, type Companion, type CompanionTemplatePermission, type PluginAccount, type SpecialistConnection } from "@/api";
import { CompanionAvatar, DEFAULT_AVATAR } from "@/components/CompanionAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import "./TeamPanel.css";
import { SpecialistCreation } from "./SpecialistCreation";

const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong.";

type TeamMember = {
  profile: AgentTemplate;
  permission: CompanionTemplatePermission;
};

export function TeamPanel({ companion, onOpenCompanion, onOpenDraft, refreshVersion = 0 }: { companion: Companion; onOpenCompanion: (id: string) => void; onOpenDraft: (companionId: string, templateId: string) => void; refreshVersion?: number }) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [permissions, setPermissions] = useState<CompanionTemplatePermission[]>([]);
  const [replicas, setReplicas] = useState<Companion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [adding, setAdding] = useState<"" | "existing" | "new">("");
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const opening = useRef(false);
  const mounted = useRef(false);
  const activeLoads = useRef(0);
  const latestLoad = useRef(0);
  const passiveQueued = useRef(false);
  const passiveDraining = useRef(false);
  const drainPassive = useRef<() => void>(() => undefined);
  const lastRefreshVersion = useRef(refreshVersion);

  const load = useCallback(async (preserveError = false) => {
    const requestId = ++latestLoad.current;
    activeLoads.current += 1;
    try {
      const [profileResult, permissionResult, replicaResult] = await Promise.all([
        workspaceApi.templates(),
        workspaceApi.companionTemplates(companion.id),
        workspaceApi.replicas(companion.id),
      ]);
      if (mounted.current && requestId === latestLoad.current) {
        setTemplates(profileResult.templates);
        setPermissions(permissionResult.templates);
        setReplicas(replicaResult.replicas);
        setLoadFailed(false);
        if (!preserveError) setError("");
      }
      return profileResult.templates;
    } catch (cause) {
      if (mounted.current && requestId === latestLoad.current) {
        if (!preserveError) setLoadFailed(true);
        setError(current => preserveError && current ? current : errorText(cause));
      }
      return null;
    } finally {
      activeLoads.current -= 1;
      if (mounted.current && requestId === latestLoad.current) setLoading(false);
      if (activeLoads.current === 0 && passiveQueued.current) drainPassive.current();
    }
  }, [companion.id]);

  const runPassiveRefresh = useCallback(async () => {
    if (passiveDraining.current || activeLoads.current > 0 || !passiveQueued.current) return;
    passiveDraining.current = true;
    try {
      while (passiveQueued.current && mounted.current) {
        passiveQueued.current = false;
        await load(true);
      }
    } finally {
      passiveDraining.current = false;
    }
  }, [load]);
  drainPassive.current = () => { void runPassiveRefresh(); };

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; latestLoad.current += 1; };
  }, [load]);

  useEffect(() => {
    if (refreshVersion === lastRefreshVersion.current) return;
    lastRefreshVersion.current = refreshVersion;
    passiveQueued.current = true;
    void runPassiveRefresh();
  }, [refreshVersion, runPassiveRefresh]);

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
  const available = useMemo(() => templates.filter(template => template.hasPublished !== false && !team.some(member => member.profile.id === template.id)), [team, templates]);

  useEffect(() => {
    if (adding !== "existing") return;
    setSelectedId(current => available.some(item => item.id === current) ? current : available[0]?.id ?? "");
  }, [adding, available]);

  function closeAdd() {
    setAdding("");
    setSelectedId("");
    setError("");
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

  async function configure(templateId: string) {
    if (opening.current) return;
    opening.current = true; setBusy(`configure:${templateId}`); setError("");
    try {
      const { draft } = await workspaceApi.openTemplateDraft(templateId);
      onOpenDraft(draft.companionId, draft.templateId);
    } catch (cause) { setError(errorText(cause)); }
    finally { opening.current = false; setBusy(""); }
  }

  if (adding === "new") return <SpecialistCreation onCancel={closeAdd} onRefresh={async () => { await load(); closeAdd(); }} onCreated={draft => onOpenDraft(draft.companionId, draft.templateId)}/>;

  return <section className="team-panel" aria-labelledby="team-title">
    <header className="team-heading">
      <div><h1 id="team-title">Who can help {companion.name}?</h1><p>Specialists bring their own prepared tools, skills and accounts to focused work.</p></div>
      <Button onClick={() => setAdding(available.length ? "existing" : "new")} disabled={!!busy || !!adding}><Plus />Add specialist</Button>
    </header>

    {error && !adding && <div className="team-error" role="alert"><span>{error}</span><Button variant="outline" size="sm" onClick={() => { setLoading(true); void load(); }}><RotateCw />Retry</Button></div>}

    <section className="team-coordinator" aria-labelledby="coordinator-title">
      <div className="team-section-label" id="coordinator-title">Coordinator</div>
      <div className="team-person team-person--coordinator">
        <CompanionAvatar name={companion.name} avatar={companion.avatar} size={56} />
        <div><strong>{companion.name}</strong><p>{companion.instructions || "Your permanent point of contact."}</p></div>
      </div>
    </section>

    <section className="team-specialists" aria-labelledby="specialists-title">
      <div className="team-section-label" id="specialists-title">Specialists</div>
      {loading ? <TeamSkeleton /> : loadFailed ? null : team.length ? <div className="team-list">{team.map(member =>
        <SpecialistRow key={member.profile.id} companionId={companion.id} member={member} onConfigure={() => void configure(member.profile.id)} busy={busy} setBusy={setBusy} onError={setError} onReload={load} />
      )}</div> : <div className="team-empty"><p>{companion.name} does not have any specialists yet.</p><span>Add a published specialist, or prepare a new one together in chat.</span></div>}
    </section>

    {adding === "existing" && <section className="team-add" aria-labelledby="add-specialist-title">
      <div className="team-add-heading"><div><h2 id="add-specialist-title">Add a specialist</h2><p>Choose a published specialist, or create one in chat and add it after publishing.</p></div><Button variant="ghost" size="icon" aria-label="Close add specialist" onClick={closeAdd} disabled={!!busy}><X /></Button></div>
      <form onSubmit={addExisting}>
        <fieldset className="team-profile-choices"><legend>Published specialists</legend>{available.map(profile => <label key={profile.id}><input type="radio" name="team-profile" value={profile.id} checked={selectedId === profile.id} onChange={() => setSelectedId(profile.id)} /><CompanionAvatar name={profile.name} avatar={profile.avatar} size={44} /><span><strong>{profile.name}</strong><small>{profile.instructions || "No role description yet."}</small></span></label>)}</fieldset>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="team-form-actions"><Button type="submit" disabled={!selectedId || !!busy}>{busy === "add-existing" ? <LoaderCircle className="spin" /> : <Check />}Add to team</Button><Button type="button" variant="ghost" disabled={!!busy} onClick={() => { setAdding("new"); setError(""); }}>Create a specialist</Button></div>
      </form>
    </section>}

    {!!replicas.length && <section className="team-work" aria-labelledby="team-work-title"><div><h2 id="team-work-title">Specialist conversations</h2><p>Open a specialist&apos;s conversation and results.</p></div><div className="team-work-list">{replicas.map(replica => <button type="button" key={replica.id} onClick={() => onOpenCompanion(replica.id)} aria-label={`Open ${replica.name}'s work`}><CompanionAvatar name={replica.name} avatar={replica.avatar} size={40} /><span><strong>{replica.name}</strong><small>{replica.status}</small></span><span>Open</span></button>)}</div></section>}
  </section>;
}

function TeamSkeleton() {
  return <div className="team-list" role="status" aria-label="Loading specialists"><div className="team-person team-person--skeleton"><span /><div><i /><i /></div></div><div className="team-person team-person--skeleton"><span /><div><i /><i /></div></div></div>;
}

function SpecialistRow({ companionId, member, onConfigure, busy, setBusy, onError, onReload }: {
  companionId: string;
  member: TeamMember;
  onConfigure: () => void;
  busy: string;
  setBusy: (value: string) => void;
  onError: (value: string) => void;
  onReload: () => Promise<AgentTemplate[] | null>;
}) {
  const [assigning, setAssigning] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const taskIntent = useRef<{ prompt: string; id: string } | null>(null);

  async function assign(event: FormEvent) {
    event.preventDefault(); const nextPrompt = prompt.trim();
    const intent = taskIntent.current?.prompt === nextPrompt ? taskIntent.current : { prompt: nextPrompt, id: crypto.randomUUID() };
    taskIntent.current = intent;
    setBusy(`spawn:${member.profile.id}`); onError("");
    try {
      await workspaceApi.spawnReplica(companionId, member.profile.id, nextPrompt, intent.id);
      taskIntent.current = null;
      setPrompt(""); setAssigning(false); await onReload();
    } catch (cause) { onError(errorText(cause)); }
    finally { setBusy(""); }
  }

  async function changeLimit(value: number) {
    setBusy(`limit:${member.profile.id}`); onError("");
    try { await workspaceApi.setTemplatePermission(companionId, member.profile.id, value); await onReload(); }
    catch (cause) { onError(errorText(cause)); }
    finally { setBusy(""); }
  }

  const limits = [...new Set([member.permission.maxChildren, 1, 2, 3, 5, 10, 20])].sort((a, b) => a - b);

  return <article className="team-member">
    <div className="team-person"><CompanionAvatar name={member.profile.name} avatar={member.profile.avatar} size={48} /><div><strong>{member.profile.name}</strong><p>{member.profile.instructions || "Focused specialist profile."}</p></div><div className="team-member-actions"><Button size="sm" disabled={!!busy} onClick={onConfigure}>{busy === `configure:${member.profile.id}` ? <><LoaderCircle className="spin"/>Opening…</> : "Configure"}</Button><Button variant="outline" size="sm" disabled={!!busy} onClick={() => setAssigning(value => !value)} aria-expanded={assigning} aria-controls={`assign-${member.profile.id}`}>Assign a task</Button></div></div>
    {assigning && <form className="team-task" id={`assign-${member.profile.id}`} onSubmit={assign}><div className="field"><label htmlFor={`task-${member.profile.id}`}>What should {member.profile.name} do?</label><Textarea autoFocus id={`task-${member.profile.id}`} rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} /></div><div className="team-form-actions"><Button type="submit" disabled={!prompt.trim() || !!busy}>{busy === `spawn:${member.profile.id}` ? <LoaderCircle className="spin" /> : <CopyPlus />}Start task</Button><Button type="button" variant="ghost" disabled={!!busy} onClick={() => setAssigning(false)}>Cancel</Button></div></form>}
    <details className="team-advanced" onToggle={event => setAdvancedOpen(event.currentTarget.open)}><summary>Team settings</summary><div className="team-advanced-content">
      {advancedOpen && <TeamConnectionOverrides companionId={companionId} templateId={member.profile.id}/>}
      <label>Simultaneous copies<select value={member.permission.maxChildren} disabled={!!busy} onChange={event => void changeLimit(Number(event.target.value))}>{limits.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <Button className="team-remove" type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => void changeLimit(0)}><UserRoundMinus />Remove from team</Button>
    </div></details>
  </article>;
}

function TeamConnectionOverrides({ companionId, templateId }: { companionId: string; templateId: string }) {
  const [connections, setConnections] = useState<SpecialistConnection[]>([]);
  const [accounts, setAccounts] = useState<PluginAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [slots, granted] = await Promise.all([workspaceApi.specialistConnections(companionId, templateId), workspaceApi.companionPlugins(companionId)]);
      if (!mounted.current) return;
      setConnections(slots.connections); setAccounts(granted.accounts);
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setLoading(false); }
  }, [companionId, templateId]);

  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);

  async function update(connection: SpecialistConnection, value: string) {
    if (pending) return;
    setPending(connection.slot); setError("");
    try {
      const result = value === "__default__"
        ? await workspaceApi.updateSpecialistConnection(companionId, templateId, { slot: connection.slot, accountId: null, useDefault: true })
        : await workspaceApi.updateSpecialistConnection(companionId, templateId, { slot: connection.slot, accountId: value || null });
      if (mounted.current) setConnections(result.connections);
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setPending(""); }
  }

  if (loading) return <div className="team-connections team-connections--loading" role="status">Loading specialist accounts…</div>;
  if (!connections.length && !error) return null;
  return <section className="team-connections" aria-label="Specialist accounts"><div><strong>Accounts for this team</strong><p>Use the specialist default or replace it only for this coordinator.</p></div>
    {connections.map(connection => {
      const compatible = accounts.filter(account => account.provider === connection.provider);
      const value = connection.overridden ? connection.accountId ?? "" : "__default__";
      return <label key={connection.slot}><span>{connection.provider}<small>{connection.required && !connection.accountId ? "Required · connect an account before assigning work" : connection.label ?? "No account selected"}</small></span><select aria-label={`${connection.provider} account`} value={value} disabled={Boolean(pending)} onChange={event => void update(connection, event.target.value)}><option value="__default__">Specialist default{connection.defaultAccountId ? "" : " (not connected)"}</option>{compatible.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>;
    })}
    {error && <div className="team-revision-error"><span role="alert">{error}</span><Button type="button" variant="outline" size="sm" onClick={() => void load()}><RotateCw/>Retry accounts</Button></div>}
  </section>;
}

export default TeamPanel;
