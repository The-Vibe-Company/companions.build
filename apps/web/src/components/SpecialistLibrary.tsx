import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, LoaderCircle, Menu, Plus, RotateCw, X } from "lucide-react";
import { workspaceApi, type AgentTemplate, type AgentTemplateRevision } from "@/api";
import { AvatarPicker, CompanionAvatar, DEFAULT_AVATAR, type CompanionAvatarValue } from "@/components/CompanionAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import "./SpecialistLibrary.css";

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "Something went wrong.";

type Props = { onMenu?: () => void; refreshVersion?: number };

export function SpecialistLibrary({ onMenu, refreshVersion = 0 }: Props) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const loadSequence = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const sequence = ++loadSequence.current;
    if (!quiet) setLoading(true);
    const templateResult = await workspaceApi.templates().then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
    if (sequence !== loadSequence.current) return null;
    if (templateResult.status === "rejected") {
      setError(errorText(templateResult.reason));
      setLoading(false);
      return null;
    }
    setTemplates(templateResult.value.templates);
    setError("");
    setLoading(false);
    return templateResult.value.templates;
  }, []);

  useEffect(() => { void load(refreshVersion > 0); }, [load, refreshVersion]);

  return <main className="specialist-library" id="main-content">
    <div className="specialist-library__inner">
      <header className="specialist-library__heading">
        <div className="specialist-library__title">
          {onMenu && <Button className="specialist-library__menu" variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button>}
          <div><h1>Specialists</h1><p>Reusable profiles your companions can call on. Adding one here never starts a machine.</p></div>
        </div>
        <Button onClick={() => { setCreating(true); setEditingId(null); }} disabled={creating}><Plus />New specialist</Button>
      </header>

      {error && <div className="specialist-library__error" role="alert"><span>{error}</span><Button variant="outline" size="sm" onClick={() => void load()}><RotateCw />Try again</Button></div>}
      {creating && <NewSpecialist onCancel={() => setCreating(false)} onRefresh={async () => { await load(); setCreating(false); }} onCreated={async id => { const result = await load(true); setCreating(false); if (result?.some(item => item.id === id)) setEditingId(id); }} />}

      {loading && templates.length === 0 ? <LibrarySkeleton /> : !error && templates.length === 0 && !creating ? <section className="specialist-library__empty"><CompanionAvatar name="Specialist" avatar={DEFAULT_AVATAR} size={72}/><h2>Build your specialist bench</h2><p>Create a reusable role once, then add it to any companion’s team.</p></section> : <section className="specialist-library__list" aria-label="Saved specialists">
        {templates.map(template => <SpecialistLibraryRow key={template.id} template={template} expanded={editingId === template.id} onToggle={() => setEditingId(current => current === template.id ? null : template.id)} onReload={load} />)}
      </section>}
    </div>
  </main>;
}

function NewSpecialist({ onCancel, onRefresh, onCreated }: { onCancel: () => void; onRefresh: () => Promise<void>; onCreated: (id: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [avatar, setAvatar] = useState<CompanionAvatarValue>(DEFAULT_AVATAR);
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (savingRef.current || !name.trim() || uncertain) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      const result = await workspaceApi.createTemplate({ name: name.trim(), instructions: instructions.trim(), avatar });
      await onCreated(result.id);
    } catch (cause) {
      setUncertain(true);
      setError(errorText(cause));
    } finally { savingRef.current = false; setSaving(false); }
  }

  return <section className="specialist-create" aria-labelledby="new-specialist-title">
    <div className="specialist-create__preview"><CompanionAvatar name={name || "New specialist"} avatar={avatar} size={112}/><strong>{name || "New specialist"}</strong><span>{instructions || "Give this specialist a focused role."}</span></div>
    <form onSubmit={submit}>
      <div className="specialist-editor__head"><div><h2 id="new-specialist-title">New specialist</h2><p>Create a reusable profile without starting work.</p></div><Button variant="ghost" size="icon" type="button" onClick={onCancel} disabled={saving} aria-label="Close new specialist"><X /></Button></div>
      {uncertain ? <div className="specialist-editor__uncertain" role="alert"><strong>We couldn’t confirm whether this specialist was created.</strong><p>Refresh the page before creating another so you don’t make a duplicate.</p>{error && <span>{error}</span>}</div> : <>
        <div className="specialist-editor__grid"><label>Name<input autoFocus value={name} maxLength={80} disabled={saving} onChange={event => setName(event.target.value)} /></label><label>Role<Textarea value={instructions} rows={3} maxLength={20_000} disabled={saving} onChange={event => setInstructions(event.target.value)} /></label></div>
        <details className="specialist-editor__appearance"><summary><CompanionAvatar name="Appearance preview" avatar={avatar} size={32}/>Change appearance<ChevronDown /></summary><AvatarPicker value={avatar} onChange={setAvatar}/></details>
        <ProviderAccess />
        {error && <p className="field-error" role="alert">{error}</p>}
      </>}
      <div className="specialist-editor__actions"><Button type="button" variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>{uncertain ? <Button type="button" onClick={() => void onRefresh()}><RotateCw />Refresh specialists</Button> : <Button type="submit" disabled={saving || !name.trim()}>{saving ? <LoaderCircle className="spin"/> : <Check />}{saving ? "Creating…" : "Create specialist"}</Button>}</div>
    </form>
  </section>;
}

function SpecialistLibraryRow({ template, expanded, onToggle, onReload }: { template: AgentTemplate; expanded: boolean; onToggle: () => void; onReload: (quiet?: boolean) => Promise<AgentTemplate[] | null> }) {
  return <article className={`specialist-library__row${expanded ? " is-expanded" : ""}`}>
    <div className="specialist-library__summary">
      <CompanionAvatar name={template.name} avatar={template.avatar} size={56}/>
      <div><strong>{template.name}</strong><span>{template.instructions || "Focused specialist profile."}</span></div>
      <span className="specialist-library__version">Version {template.revision}</span>
      <Button variant="outline" size="sm" onClick={onToggle} aria-expanded={expanded}>{expanded ? "Editing" : "Edit"}</Button>
    </div>
    {expanded && <SpecialistEditor template={template} onCancel={onToggle} onReload={onReload}/>} 
  </article>;
}

function SpecialistEditor({ template, onCancel, onReload }: { template: AgentTemplate; onCancel: () => void; onReload: (quiet?: boolean) => Promise<AgentTemplate[] | null> }) {
  const [name, setName] = useState(template.name);
  const [instructions, setInstructions] = useState(template.instructions);
  const [avatar, setAvatar] = useState(template.avatar);
  const [baselineRevision, setBaselineRevision] = useState(template.revision);
  const [revisions, setRevisions] = useState<AgentTemplateRevision[] | null>(null);
  const [targetRevision, setTargetRevision] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const request = useRef(0);
  const busyRef = useRef(false);

  const loadHistory = useCallback(async () => {
    const id = ++request.current; setHistoryError("");
    try {
      const result = await workspaceApi.templateRevisions(template.id);
      if (id !== request.current) return;
      setRevisions(result.revisions);
      setTargetRevision(String(result.revisions.find(item => item.revision !== baselineRevision)?.revision ?? ""));
    } catch (cause) { if (id === request.current) setHistoryError(errorText(cause)); }
  }, [template.id, baselineRevision]);
  useEffect(() => { void loadHistory(); return () => { request.current += 1; }; }, [loadHistory]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !name.trim()) return;
    busyRef.current = true; setSaving(true); setError(""); setSaved(false);
    try {
      const result = await workspaceApi.updateTemplate(template.id, { name: name.trim(), instructions: instructions.trim(), avatar, revision: baselineRevision });
      setBaselineRevision(result.revision);
      const profiles = await onReload(true);
      const refreshed = profiles?.find(item => item.id === template.id);
      if (refreshed) { setName(refreshed.name); setInstructions(refreshed.instructions); setAvatar(refreshed.avatar); setBaselineRevision(refreshed.revision); }
      setSaved(true);
    } catch (cause) { setError(errorText(cause)); }
    finally { busyRef.current = false; setSaving(false); }
  }

  async function restore() {
    if (!targetRevision || busyRef.current) return;
    busyRef.current = true; setSaving(true); setError(""); setSaved(false);
    try {
      const result = await workspaceApi.rollbackTemplate(template.id, Number(targetRevision), baselineRevision);
      setBaselineRevision(result.revision);
      const profiles = await onReload(true);
      const refreshed = profiles?.find(item => item.id === template.id);
      if (refreshed) { setName(refreshed.name); setInstructions(refreshed.instructions); setAvatar(refreshed.avatar); setBaselineRevision(refreshed.revision); }
      setSaved(true);
    } catch (cause) { setError(errorText(cause)); }
    finally { busyRef.current = false; setSaving(false); }
  }

  return <form className="specialist-editor" onSubmit={save}>
    <div className="specialist-editor__grid"><label>Name<input value={name} maxLength={80} disabled={saving} onChange={event => { setName(event.target.value); setSaved(false); }}/></label><label>Role<Textarea value={instructions} rows={3} maxLength={20_000} disabled={saving} onChange={event => { setInstructions(event.target.value); setSaved(false); }}/></label></div>
    <ProviderAccess />
    <details className="specialist-editor__appearance"><summary><CompanionAvatar name="Appearance preview" avatar={avatar} size={30}/>Change appearance<ChevronDown /></summary><AvatarPicker value={avatar} onChange={value => { setAvatar(value); setSaved(false); }}/></details>
    <div className="specialist-editor__history"><div><span>Version {baselineRevision}</span>{historyError ? <Button type="button" variant="ghost" size="sm" onClick={() => void loadHistory()}><RotateCw />Retry history</Button> : revisions === null ? <span>Loading history…</span> : revisions.length < 2 ? <span>First saved version</span> : <><label htmlFor={`history-${template.id}`}>Earlier version</label><select id={`history-${template.id}`} value={targetRevision} disabled={saving} onChange={event => setTargetRevision(event.target.value)}>{revisions.filter(item => item.revision !== baselineRevision).map(item => <option key={item.revision} value={item.revision}>Version {item.revision} · {item.name}</option>)}</select><Button type="button" variant="outline" size="sm" disabled={!targetRevision || saving} onClick={() => void restore()}><RotateCw />Restore</Button></>}</div></div>
    {error && <p className="field-error" role="alert">{error}</p>}{saved && <p className="specialist-editor__saved" role="status">Profile saved.</p>}
    <div className="specialist-editor__actions"><Button type="button" variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button><Button type="submit" disabled={saving || !name.trim()}>{saving ? <LoaderCircle className="spin"/> : <Check />}{saving ? "Saving…" : "Save"}</Button></div>
  </form>;
}

function ProviderAccess() {
  return <section className="specialist-editor__access"><strong>Apps &amp; accounts</strong><span>Apps are granted by the companion that calls this specialist.</span></section>;
}

function LibrarySkeleton() { return <div className="specialist-library__skeleton" role="status" aria-label="Loading specialists">{[0,1,2,3].map(item => <span key={item}/>)}</div>; }

export default SpecialistLibrary;
