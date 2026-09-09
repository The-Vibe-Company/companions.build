import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronDown, FlaskConical, History, LoaderCircle, Play, Plus, RotateCw, Trash2, X } from "lucide-react";
import { workspaceApi, type PluginAccount, type Routine, type RoutineHistory, type RoutinePublicationMode, type Trigger, type TriggerDelivery, type TriggerFilterRequest } from "@/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import "./AutomationPanels.css";

const errorText = (value: unknown) => value instanceof Error ? value.message : "Something went wrong.";
const shortDate = (value?: string | null) => value ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "";
const scheduleLabel = (cron: string) => cron === "0 9 * * 1-5" ? "Weekdays at 9:00" : cron === "0 9 * * *" ? "Daily at 9:00" : cron === "0 9 * * 1" ? "Mondays at 9:00" : cron;

export function RoutineSettings({ companionId, initialRoutineId }: { companionId: string; initialRoutineId?: string }) {
  return <RoutinePanel key={companionId} companionId={companionId} initialRoutineId={initialRoutineId} />;
}

function RoutinePanel({ companionId, initialRoutineId }: { companionId: string; initialRoutineId?: string }) {
  const [items, setItems] = useState<Routine[]>([]);
  const [publicationMode, setPublicationMode] = useState<RoutinePublicationMode>("auto");
  const openedInitial = useRef<string | undefined>(undefined);
  const [history, setHistory] = useState<Record<string, RoutineHistory>>({});
  const [creating, setCreating] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
  function closeCreation() { setCreating(false); createButton.current?.focus(); }
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState("");
  const [name, setName] = useState(""); const [prompt, setPrompt] = useState(""); const [cron, setCron] = useState("0 9 * * 1-5");
  const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  const testIntents = useRef<Record<string, string>>({});
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const load = useCallback(async () => { try { setItems((await workspaceApi.routines(companionId)).routines); setError(""); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); } }, [companionId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (loading || !initialRoutineId || openedInitial.current === initialRoutineId) return;
    openedInitial.current = initialRoutineId;
    if (items.some(item => item.id === initialRoutineId)) { setOpenId(initialRoutineId); void loadHistory(initialRoutineId); }
    else setError("This routine is no longer available. Its executions remain in the chat and activity.");
  }, [loading, initialRoutineId, items]);
  async function change(id: string, action: () => Promise<unknown>) {
    setBusy(id); setError("");
    try { await action(); await load(); return true; }
    catch (cause) { setError(errorText(cause)); return false; }
    finally { setBusy(""); }
  }
  async function loadHistory(id: string) { setBusy(`history:${id}`); try { const value = await workspaceApi.routineHistory(companionId, id); setHistory(current => ({ ...current, [id]: value })); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  async function inspect(id: string) { const next = openId === id ? "" : id; setOpenId(next); if (next) await loadHistory(id); }
  async function test(id: string) { setBusy(`test:${id}`); setError(""); testIntents.current[id] ??= crypto.randomUUID(); try { await workspaceApi.testRoutine(companionId, id, testIntents.current[id]); delete testIntents.current[id]; await loadHistory(id); setOpenId(id); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  async function create(event: FormEvent) { event.preventDefault(); setBusy("create"); setError(""); try { await workspaceApi.createRoutine(companionId, { name: name.trim(), prompt: prompt.trim(), cron, timezone, publicationMode, enabled: true }); setName(""); setPrompt(""); setPublicationMode("auto"); closeCreation(); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  return <div className="settings-stack automation-settings">
    <div className="automation-heading"><div><h3>Routines</h3><p>Work on a schedule.</p></div><Button variant="outline" size="sm" ref={createButton} disabled={!!busy} aria-expanded={creating} aria-controls="routine-create" onClick={() => setCreating(!creating)}><Plus />New routine</Button></div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {loading ? <p className="settings-empty" role="status">Loading routines…</p> : !error && !items.length && <p className="automation-empty">A morning brief, a weekly review. Give recurring work a time.</p>}
    <div className="automation-list">{items.map(item => <section className="automation-card" key={item.id}>
      <div className="automation-row">
        <button className="automation-summary" disabled={!!busy} onClick={() => void inspect(item.id)} aria-expanded={openId === item.id} aria-controls={`routine-detail-${item.id}`}>
          <span><strong>{item.name}</strong><small>{scheduleLabel(item.cron)} · {item.timezone}</small></span><ChevronDown className={cn(openId === item.id && "chevron-open")} />
        </button>
        <AutomationSwitch name={item.name} enabled={item.enabled} disabled={!!busy} onChange={() => void change(`toggle:${item.id}`, () => workspaceApi.updateRoutine(companionId, item.id, { enabled: !item.enabled }))} />
      </div>
      {openId === item.id && <div id={`routine-detail-${item.id}`} className="automation-expanded">
        <p className="automation-prompt">{item.prompt}</p>
        <p className="automation-caption">Chat messages: {publicationLabels[item.publicationMode ?? "auto"]}</p>
        <p className="automation-caption">{item.enabled && item.nextFireAt ? `Next run ${shortDate(item.nextFireAt)}` : item.enabled ? "Schedule enabled" : "Schedule paused"}</p>
        <div className="detail-actions"><Button variant="outline" size="sm" disabled={!!busy} onClick={() => void test(item.id)} aria-label={`Run ${item.name} now`}>{busy === `test:${item.id}` ? <LoaderCircle className="spin" /> : <Play />}Run now</Button><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void loadHistory(item.id)}><RotateCw />Refresh history</Button></div>
        <details className="automation-section"><summary>Edit routine</summary><AutomationEditor key={`${item.name}:${item.prompt}:${item.cron}:${item.timezone}:${item.publicationMode}`} item={item} busy={!!busy} onSave={value => change(`edit:${item.id}`, () => workspaceApi.updateRoutine(companionId, item.id, value))} /></details>
        <RoutineHistoryView value={history[item.id]} loading={busy === `history:${item.id}`} />
        <DeleteAutomation name={item.name} busy={!!busy} onDelete={() => change(`delete:${item.id}`, () => workspaceApi.deleteRoutine(companionId, item.id))} />
      </div>}
    </section>)}</div>
    {creating && <form id="routine-create" className="inline-create" onSubmit={create}><h3>New routine</h3><div className="field"><label htmlFor="routine-name">Name</label><input autoFocus id="routine-name" value={name} onChange={event => setName(event.target.value)} placeholder="Morning brief" /></div><div className="field"><label htmlFor="routine-prompt">What should happen?</label><Textarea id="routine-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} rows={3} /></div><div className="field"><label htmlFor="routine-time">When</label><select id="routine-time" value={cron} onChange={event => setCron(event.target.value)}><option value="0 9 * * 1-5">Weekdays at 9:00</option><option value="0 9 * * *">Every day at 9:00</option><option value="0 9 * * 1">Mondays at 9:00</option></select></div><RoutinePublicationField id="routine-publication" value={publicationMode} onChange={setPublicationMode} disabled={!!busy}/><Button type="submit" disabled={!name.trim() || !prompt.trim() || busy === "create"}>{busy === "create" ? <LoaderCircle className="spin" /> : <Plus />}Add routine</Button><Button type="button" variant="ghost" disabled={busy === "create"} onClick={closeCreation}>Cancel</Button></form>}
  </div>;
}

function RoutineHistoryView({ value, loading }: { value?: RoutineHistory; loading: boolean }) {
  if (loading && !value) return <div className="automation-detail muted-copy"><LoaderCircle className="spin" />Loading history…</div>;
  if (!value && !loading) return <p className="automation-caption">History is unavailable.</p>;
  return <div className="automation-detail"><div className="detail-label"><History />Recent runs</div>{value?.runs.length ? value.runs.slice(0, 5).map(run => <div className="history-row" key={run.id}><span className={`history-dot history-dot--${run.status}`} /><div><strong>{run.status.replaceAll("_", " ")}</strong><small>{shortDate(run.scheduledFor ?? run.acceptedAt)}{run.error ? ` · ${run.error}` : ""}</small>{run.resultText && <p>{run.resultText}</p>}</div></div>) : <p className="settings-empty">No runs yet.</p>}{value?.missed.length ? <p className="missed-copy">{value.missed.length} missed window{value.missed.length === 1 ? "" : "s"} recorded</p> : null}</div>;
}

const initialPayload = (source: Trigger["source"]) => source === "github" ? '{\n  "action": "completed",\n  "workflow_run": { "head_branch": "main", "conclusion": "failure" }\n}' : source === "sentry" ? JSON.stringify({ group: { id: "123", firstSeen: new Date().toISOString() }, event: { eventID: "replace-with-event-id" } }, null, 2) : '{\n  "event": "example"\n}';

export function TriggerSettings({ companionId }: { companionId: string }) {
  return <TriggerPanel key={companionId} companionId={companionId} />;
}

function TriggerPanel({ companionId }: { companionId: string }) {
  const [items, setItems] = useState<Trigger[]>([]); const [accounts, setAccounts] = useState<PluginAccount[]>([]);
  const [name, setName] = useState(""); const [prompt, setPrompt] = useState(""); const [source, setSource] = useState<Trigger["source"]>("generic"); const [mode, setMode] = useState<Trigger["mode"]>("direct"); const [filter, setFilter] = useState("");
  const [providerAccountId, setProviderAccountId] = useState(""); const [repo, setRepo] = useState(""); const [branch, setBranch] = useState("main"); const [organization, setOrganization] = useState(""); const [project, setProject] = useState(""); const [problemPath, setProblemPath] = useState(""); const [reads, setReads] = useState<TriggerFilterRequest[]>([]);
  const [creating, setCreating] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
  function closeCreation() { setCreating(false); createButton.current?.focus(); }
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(""); const [deliveries, setDeliveries] = useState<Record<string, TriggerDelivery[]>>({}); const [testPayload, setTestPayload] = useState(""); const [testResult, setTestResult] = useState("");
  const [newWebhook, setNewWebhook] = useState<{ url?: string | null; secret: string } | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  const load = useCallback(async () => { try { const [triggers, plugins] = await Promise.all([workspaceApi.triggers(companionId), workspaceApi.plugins()]); setItems(triggers.triggers); setAccounts(plugins.accounts); setError(""); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); } }, [companionId]);
  useEffect(() => { void load(); }, [load]);
  async function change(id: string, action: () => Promise<unknown>) {
    setBusy(id); setError("");
    try { await action(); await load(); return true; }
    catch (cause) { setError(errorText(cause)); return false; }
    finally { setBusy(""); }
  }
  const providerAccounts = useMemo(() => accounts.filter(account => account.provider === source), [accounts, source]);
  useEffect(() => { setProviderAccountId(providerAccounts[0]?.id ?? ""); }, [source, providerAccounts.map(account => account.id).join(":")]);
  async function inspect(item: Trigger) { const next = openId === item.id ? "" : item.id; setOpenId(next); setTestPayload(initialPayload(item.source)); setTestResult(""); if (next) await loadDeliveries(item.id); }
  async function loadDeliveries(id: string) { setBusy(`history:${id}`); try { const value = (await workspaceApi.triggerDeliveries(companionId, id)).deliveries; setDeliveries(current => ({ ...current, [id]: value })); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  async function test(item: Trigger) { setBusy(`test:${item.id}`); setTestResult(""); try { const payload = JSON.parse(testPayload); const result = await workspaceApi.testTrigger(companionId, item.id, payload); setTestResult(result.decision === "trigger" ? "Would start work" : "Would ignore"); } catch (cause) { setTestResult(errorText(cause)); } finally { setBusy(""); } }
  async function register(item: Trigger) { setBusy(`register:${item.id}`); try { await workspaceApi.registerTrigger(companionId, item.id); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  async function create(event: FormEvent) { event.preventDefault(); setBusy("create"); setError(""); setNewWebhook(null); try { const target = source === "github" ? { repo: repo.trim(), branch: branch.trim() || "main", events: ["workflow_run"] } : source === "sentry" ? { organization: organization.trim(), project: project.trim(), events: ["event.created"] } : undefined; const result = await workspaceApi.createTrigger(companionId, { name: name.trim(), prompt: prompt.trim(), source, mode, filter: mode === "filter" ? filter.trim() : undefined, filterRequests: mode === "filter" ? reads.filter(read => read.key && read.path) : [], problemPath: problemPath.trim() || undefined, providerAccountId: source === "generic" ? undefined : providerAccountId || undefined, target, enabled: true }); if (result.secret) setNewWebhook({ url: result.trigger.url, secret: result.secret }); setName(""); setPrompt(""); closeCreation(); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  const targetReady = source === "generic" || (source === "github" ? !!repo.trim() : !!organization.trim() && !!project.trim());
  return <div className="settings-stack automation-settings">
    <div className="automation-heading"><div><h3>Triggers</h3><p>Work starts when an event arrives.</p></div><Button variant="outline" size="sm" ref={createButton} disabled={!!busy} aria-expanded={creating} aria-controls="trigger-create" onClick={() => setCreating(!creating)}><Plus />New trigger</Button></div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {newWebhook && <div className="secret-callout" role="status"><strong>Save this webhook secret</strong><p>It is shown once.</p>{newWebhook.url && <a href={newWebhook.url} target="_blank" rel="noreferrer">{newWebhook.url}</a>}<code>{newWebhook.secret}</code></div>}
    {loading ? <p className="settings-empty" role="status">Loading triggers…</p> : !error && !items.length && <p className="automation-empty">A failed build, a new issue. Choose the event that starts work.</p>}
    <div className="automation-list">{items.map(item => <section className="automation-card" key={item.id}>
      <div className="automation-row">
        <button className="automation-summary" disabled={!!busy} onClick={() => void inspect(item)} aria-expanded={openId === item.id} aria-controls={`trigger-detail-${item.id}`}><span><strong>{item.name}</strong><small>{item.source === "generic" ? "Webhook" : item.source === "github" ? "GitHub" : "Sentry"} · {item.mode === "filter" ? "Filtered events" : "Every matching event"}{item.registrationStatus === "needs_connection" ? " · Connect account" : item.registrationStatus === "error" ? " · Needs attention" : ""}</small></span><ChevronDown className={cn(openId === item.id && "chevron-open")} /></button>
        <AutomationSwitch name={item.name} enabled={item.enabled} disabled={!!busy} onChange={() => void change(`toggle:${item.id}`, () => workspaceApi.updateTrigger(companionId, item.id, { enabled: !item.enabled }))} />
      </div>
      {openId === item.id && <div id={`trigger-detail-${item.id}`} className="automation-expanded">
        <p className="automation-prompt">{item.prompt}</p>
        {item.registrationError && <p className="field-error" role="alert">{item.registrationError}</p>}
        {(item.registrationStatus === "needs_connection" || item.registrationStatus === "error") && <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void register(item)} aria-label={`Retry registration for ${item.name}`}>{busy === `register:${item.id}` ? <LoaderCircle className="spin" /> : <RotateCw />}Retry connection</Button>}
        <details className="automation-section"><summary>Edit instructions</summary><AutomationEditor key={`${item.name}:${item.prompt}`} item={item} busy={!!busy} onSave={value => change(`edit:${item.id}`, () => workspaceApi.updateTrigger(companionId, item.id, value))} /></details>
        <details className="automation-section"><summary>Test an event</summary><p className="automation-caption">Checks the filter without starting work.</p><div className="field"><label htmlFor={`trigger-payload-${item.id}`}>Test event</label><Textarea id={`trigger-payload-${item.id}`} className="code-input" rows={5} value={testPayload} onChange={event => setTestPayload(event.target.value)} /></div><div className="detail-actions"><Button variant="outline" size="sm" disabled={!!busy} onClick={() => void test(item)}>{busy === `test:${item.id}` ? <LoaderCircle className="spin" /> : <FlaskConical />}Test only</Button>{testResult && <strong role="status" className="test-result">{testResult}</strong>}</div></details>
        <div className="automation-history"><div className="automation-history-heading"><span className="detail-label"><History />Deliveries</span><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void loadDeliveries(item.id)} aria-label={`Refresh deliveries for ${item.name}`}><RotateCw />Refresh</Button></div>
          {busy === `history:${item.id}` && !deliveries[item.id] ? <p className="settings-empty" role="status">Loading deliveries…</p> : deliveries[item.id]?.length ? deliveries[item.id].slice(0, 5).map(delivery => <div className="history-row" key={delivery.id}><span className={`history-dot history-dot--${delivery.status}`} /><div><strong>{delivery.eventName || "Event"} · {delivery.decision || delivery.status}</strong><small>{shortDate(delivery.receivedAt)}{delivery.errorCode ? ` · ${delivery.errorCode.replaceAll("_", " ")}` : ""}</small></div></div>) : <p className="settings-empty">{deliveries[item.id] ? "No deliveries yet." : "Delivery history is unavailable."}</p>}
        </div>
        {item.url && <details className="automation-section"><summary>Webhook address</summary><a className="webhook-link" href={item.url} target="_blank" rel="noreferrer">{item.url}</a></details>}
        <DeleteAutomation name={item.name} busy={!!busy} onDelete={() => change(`delete:${item.id}`, () => workspaceApi.deleteTrigger(companionId, item.id))} />
      </div>}
    </section>)}</div>
    {creating && <form id="trigger-create" className="inline-create" onSubmit={create}><h3>New trigger</h3><div className="field"><label htmlFor="trigger-name">Name</label><input autoFocus id="trigger-name" value={name} onChange={event => setName(event.target.value)} placeholder="Main branch failed" /></div><div className="field"><label htmlFor="trigger-source">Source</label><select id="trigger-source" value={source} onChange={event => setSource(event.target.value as Trigger["source"])}><option value="generic">Webhook</option><option value="github">GitHub</option><option value="sentry">Sentry</option></select></div>{source !== "generic" && <div className="field"><label htmlFor="trigger-account">Account</label><select id="trigger-account" value={providerAccountId} onChange={event => setProviderAccountId(event.target.value)}><option value="">Choose connected account</option>{providerAccounts.map(account => <option value={account.id} key={account.id}>{account.label}</option>)}</select></div>}{source === "github" && <div className="field-pair"><div className="field"><label htmlFor="trigger-repo">Repository</label><input id="trigger-repo" value={repo} onChange={event => setRepo(event.target.value)} placeholder="owner/repo" /></div><div className="field"><label htmlFor="trigger-branch">Branch</label><input id="trigger-branch" value={branch} onChange={event => setBranch(event.target.value)} /></div></div>}{source === "sentry" && <div className="field-pair"><div className="field"><label htmlFor="trigger-org">Organization</label><input id="trigger-org" value={organization} onChange={event => setOrganization(event.target.value)} /></div><div className="field"><label htmlFor="trigger-project">Project</label><input id="trigger-project" value={project} onChange={event => setProject(event.target.value)} /></div></div>}<div className="field"><label htmlFor="trigger-prompt">What should happen?</label><Textarea id="trigger-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} rows={3} /></div><details className="advanced-panel"><summary>Filter and grouping</summary><label className="filter-toggle"><input type="checkbox" checked={mode === "filter"} onChange={event => setMode(event.target.checked ? "filter" : "direct")} />Run only when code accepts the event</label>{mode === "filter" && <><div className="field"><label htmlFor="trigger-filter">Filter code</label><Textarea id="trigger-filter" className="code-input" value={filter} onChange={event => setFilter(event.target.value)} rows={5} placeholder="return payload.action === 'opened'" /></div><FilterReads value={reads} accounts={accounts} onChange={setReads} /></>}<div className="field"><label htmlFor="trigger-problem">Group by field</label><input id="trigger-problem" value={problemPath} onChange={event => setProblemPath(event.target.value)} placeholder={source === "sentry" ? "group.id" : source === "github" ? "workflow_run.id" : "issue.id"} /></div></details><Button type="submit" disabled={!name.trim() || !prompt.trim() || !targetReady || (source !== "generic" && !providerAccountId) || (mode === "filter" && !filter.trim()) || busy === "create"}>{busy === "create" ? <LoaderCircle className="spin" /> : <Plus />}Add trigger</Button><Button type="button" variant="ghost" disabled={busy === "create"} onClick={closeCreation}>Cancel</Button></form>}
  </div>;
}

function FilterReads({ value, accounts, onChange }: { value: TriggerFilterRequest[]; accounts: PluginAccount[]; onChange: (value: TriggerFilterRequest[]) => void }) {
  return <div className="filter-reads"><div className="detail-actions"><span className="detail-label">Provider reads</span><Button type="button" variant="ghost" size="sm" disabled={value.length >= 5} onClick={() => onChange([...value, { key: "", provider: "github", path: "" }])}><Plus />Add read</Button></div>{value.map((read, index) => { const providerAccounts = accounts.filter(account => account.provider === read.provider); return <div className="filter-read" key={index}><input aria-label={`Read ${index + 1} name`} value={read.key} onChange={event => onChange(value.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))} placeholder="issue" /><select aria-label={`Read ${index + 1} provider`} value={read.provider} onChange={event => onChange(value.map((item, itemIndex) => itemIndex === index ? { ...item, provider: event.target.value as "github" | "sentry", connectionId: undefined } : item))}><option value="github">GitHub</option><option value="sentry">Sentry</option></select><select aria-label={`Read ${index + 1} account`} value={read.connectionId ?? ""} onChange={event => onChange(value.map((item, itemIndex) => itemIndex === index ? { ...item, connectionId: event.target.value || undefined } : item))}><option value="">Any matching account</option>{providerAccounts.map(account => <option value={account.id} key={account.id}>{account.label}</option>)}</select><input aria-label={`Read ${index + 1} path`} value={read.path} onChange={event => onChange(value.map((item, itemIndex) => itemIndex === index ? { ...item, path: event.target.value } : item))} placeholder="owner/repo/issues/1" /><button type="button" className="icon-action" onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove read ${index + 1}`}><X /></button></div>; })}</div>;
}

function AutomationSwitch({ name, enabled, disabled, onChange }: { name: string; enabled: boolean; disabled: boolean; onChange: () => void }) {
  return <label className="automation-switch">
    <span>{enabled ? "On" : "Paused"}</span>
    <span className="switch"><input type="checkbox" role="switch" aria-label={`Enable ${name}`} checked={enabled} disabled={disabled} onChange={onChange} /><span /></span>
  </label>;
}

function DeleteAutomation({ name, busy, onDelete }: { name: string; busy: boolean; onDelete: () => Promise<boolean> }) {
  const [confirming, setConfirming] = useState(false);
  return <div className="automation-delete">
    {confirming ? <><p>Delete “{name}”?</p><div className="detail-actions"><Button variant="destructive" size="sm" disabled={busy} onClick={() => void onDelete()} aria-label={`Confirm delete ${name}`}>Delete</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>Keep it</Button></div></>
      : <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)} aria-label={`Delete ${name}`}><Trash2 />Delete</Button>}
  </div>;
}

function AutomationEditor({ item, busy, onSave }: { item: Routine | Trigger; busy: boolean; onSave: (value: { name: string; prompt: string; cron?: string; timezone?: string; publicationMode?: RoutinePublicationMode }) => Promise<boolean> }) {
  const [name, setName] = useState(item.name);
  const [publicationMode, setPublicationMode] = useState<RoutinePublicationMode>("cron" in item ? item.publicationMode ?? "auto" : "auto");
  const [prompt, setPrompt] = useState(item.prompt);
  const [cron, setCron] = useState("cron" in item ? item.cron : "");
  const [timezone, setTimezone] = useState("timezone" in item ? item.timezone : "");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const disclosure = event.currentTarget.closest("details");
    const saved = await onSave({ name: name.trim(), prompt: prompt.trim(), ...("cron" in item ? { cron, timezone, publicationMode } : {}) });
    if (saved && disclosure) { disclosure.open = false; disclosure.querySelector("summary")?.focus(); }
  }
  return <form className="automation-edit" onSubmit={save}>
    <div className="field"><label htmlFor={`edit-name-${item.id}`}>Name</label><input id={`edit-name-${item.id}`} value={name} onChange={event => setName(event.target.value)} required /></div>
    <div className="field"><label htmlFor={`edit-prompt-${item.id}`}>Instructions</label><Textarea id={`edit-prompt-${item.id}`} value={prompt} onChange={event => setPrompt(event.target.value)} rows={3} required /></div>
    {"cron" in item && <div className="field-pair">
      <div className="field"><label htmlFor={`edit-cron-${item.id}`}>Schedule</label><select id={`edit-cron-${item.id}`} value={cron} onChange={event => setCron(event.target.value)}>
        {!["0 9 * * 1-5", "0 9 * * *", "0 9 * * 1"].includes(item.cron) && <option value={item.cron}>{item.cron}</option>}
        <option value="0 9 * * 1-5">Weekdays at 9:00</option><option value="0 9 * * *">Every day at 9:00</option><option value="0 9 * * 1">Mondays at 9:00</option>
      </select></div>
      <div className="field"><label htmlFor={`edit-timezone-${item.id}`}>Time zone</label><input id={`edit-timezone-${item.id}`} value={timezone} onChange={event => setTimezone(event.target.value)} required /></div>
    </div>}
    {"cron" in item && <RoutinePublicationField id={`edit-publication-${item.id}`} value={publicationMode} onChange={setPublicationMode} disabled={busy}/>}
    <Button type="submit" size="sm" disabled={busy || !name.trim() || !prompt.trim() || ("cron" in item && !timezone.trim())}>Save changes</Button>
  </form>;
}

const publicationLabels: Record<RoutinePublicationMode, string> = { auto: "If useful", always: "After every success", silent: "Silent" };
const publicationHelp: Record<RoutinePublicationMode, string> = {
  auto: "Your companion decides using the instructions. Add when it should speak up, for example: only if something needs attention.",
  always: "Every successful execution posts its result in the chat. Frequent routines can create many messages.",
  silent: "Results stay in execution details. Activity and requests for your help remain visible in the chat.",
};
function RoutinePublicationField({ id, value, onChange, disabled }: { id: string; value: RoutinePublicationMode; onChange: (value: RoutinePublicationMode) => void; disabled: boolean }) {
  return <div className="field"><label htmlFor={id}>Chat messages</label><select id={id} value={value} disabled={disabled} aria-describedby={`${id}-help`} onChange={event => onChange(event.target.value as RoutinePublicationMode)}>{Object.entries(publicationLabels).map(([mode, label]) => <option value={mode} key={mode}>{label}</option>)}</select><p id={`${id}-help`} className="automation-caption">{publicationHelp[value]} Changes apply to future executions.</p></div>;
}
