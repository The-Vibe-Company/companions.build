import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, Check, CircleDollarSign, CopyPlus, LoaderCircle, MonitorUp, PackageOpen, Pause, Play, Send, ShieldCheck, Trash2, UsersRound, Wrench, X } from "lucide-react";
import { api, workspaceApi, type AccountUser, type AgentTemplate, type BillingOverview, type Companion, type DeliveryReceived, type DeliverySent, type MaintenanceAction, type MaintenanceCompanion, type MaintenanceDetail } from "@/api";
import { AvatarPicker, CompanionAvatar, DEFAULT_AVATAR, type CompanionAvatarValue } from "@/components/CompanionAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong.";

export function AccountProduct({ user, onSignOut }: { user: AccountUser; onSignOut: () => Promise<void> }) {
  const [billing, setBilling] = useState<BillingOverview | null>(null);
  const [sent, setSent] = useState<DeliverySent[]>([]);
  const [received, setReceived] = useState<DeliveryReceived[]>([]);
  const [maintenance, setMaintenance] = useState<MaintenanceCompanion[]>([]);
  const [maintaining, setMaintaining] = useState<MaintenanceCompanion | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [nextBilling, deliveries] = await Promise.all([workspaceApi.billing(), workspaceApi.deliveries()]);
      setBilling(nextBilling); setSent(deliveries.sent); setReceived(deliveries.received); setError("");
    } catch (cause) { setError(errorText(cause)); }
  }, []);
  useEffect(() => { void load(); void workspaceApi.maintenance().then(result => setMaintenance(result.companions)).catch(() => setMaintenance([])); }, [load]);
  async function billingAction(kind: "checkout" | "portal") {
    setBusy(kind); setError("");
    try { const result = kind === "checkout" ? await workspaceApi.checkout() : await workspaceApi.billingPortal(); window.location.assign(result.url); }
    catch (cause) { setError(errorText(cause)); setBusy(""); }
  }
  async function accept(item: DeliveryReceived, grantMaintenance: boolean) {
    setBusy(item.id); setError("");
    try { await workspaceApi.acceptDelivery(item.id, grantMaintenance); await load(); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(""); }
  }
  const subscriptionActive = billing?.mode === "stripe" && billing.plan === "subscription" && billing.active;
  return <div className="account-product">
    <section className="account-identity"><span className="large-initial">{user.email.slice(0, 1).toUpperCase()}</span><div><strong>{user.name || "Your account"}</strong><small>{user.email}</small></div><Button variant="outline" onClick={() => void onSignOut()}>Sign out</Button></section>
    {error && <p className="field-error" role="alert">{error}</p>}
    <section className="product-section" aria-labelledby="plan-title">
      <div className="section-heading"><div><CircleDollarSign /><span><h2 id="plan-title">Plan</h2><p>{billing?.mode === "test" ? "Local activation enabled" : subscriptionActive ? "Subscription active" : billing?.configured ? "Ready when you are" : "Unavailable on this installation"}</p></span></div>{(subscriptionActive || billing?.mode === "test") && <span className="status-pill status-pill--good"><Check />{billing?.mode === "test" ? "Test" : "Active"}</span>}</div>
      {billing ? <div className="plan-line"><div><strong>{billing.mode === "test" ? "Development access" : billing.plan === "subscription" ? "companions.build" : "No subscription"}</strong><small>{billing.status ? billing.status.replaceAll("_", " ") : billing.mode === "test" ? "No live subscription" : "Usage appears here as your team works."}</small></div>{billing.portalAvailable ? <Button variant="outline" onClick={() => void billingAction("portal")} disabled={!!busy}>{busy === "portal" ? <LoaderCircle className="spin" /> : <ArrowUpRight />}Manage</Button> : billing.configured && !billing.active ? <Button onClick={() => void billingAction("checkout")} disabled={!!busy}>{busy === "checkout" ? <LoaderCircle className="spin" /> : <ArrowUpRight />}Subscribe</Button> : null}</div> : <div className="skeleton skeleton--row" />}
      {!!billing?.usage.length && <div className="usage-lines">{billing.usage.map(item => <span key={`${item.category}-${item.unit}`}><strong>{Number(item.quantity).toLocaleString()}</strong><small>{item.category.replaceAll("_", " ")} · {item.unit}</small></span>)}</div>}
    </section>
    <section className="product-section" aria-labelledby="deliveries-title">
      <div className="section-heading"><div><PackageOpen /><span><h2 id="deliveries-title">Deliveries</h2><p>Companions shared with clients.</p></span></div></div>
      {received.filter(item => item.status === "pending").map(item => <ReceivedDelivery key={item.id} item={item} busy={busy === item.id} onAccept={accept} />)}
      {[...received.filter(item => item.status !== "pending"), ...sent].map(item => <div className="compact-row" key={`${"clientEmail" in item ? "sent" : "received"}-${item.id}`}><div><strong>{"clientEmail" in item ? item.clientEmail : item.name}</strong><small>{"clientEmail" in item ? "Sent" : "Received"} · {item.status}</small></div>{item.status === "accepted" && !("clientEmail" in item) && item.maintenanceRequested && <Button variant="ghost" size="sm" onClick={() => void workspaceApi.revokeMaintenance(item.id).then(load)}>Remove maintenance</Button>}</div>)}
      {!received.length && !sent.length && <p className="settings-empty">No deliveries yet.</p>}
    </section>
    {!!maintenance.length && <section className="product-section" aria-labelledby="maintenance-title"><div className="section-heading"><div><Wrench /><span><h2 id="maintenance-title">Maintenance</h2><p>Client Companions you can help.</p></span></div></div>{maintenance.map(item => <button className="compact-row compact-row--button" key={item.id} onClick={() => setMaintaining(item)}><span><strong>{item.name}</strong><small>{item.error || item.status}</small></span><ArrowUpRight /></button>)}</section>}
    {maintaining && <MaintenanceSheet companion={maintaining} onClose={() => setMaintaining(null)} />}
  </div>;
}

function MaintenanceSheet({ companion, onClose }: { companion: MaintenanceCompanion; onClose: () => void }) {
  const [detail, setDetail] = useState<MaintenanceDetail | null>(null); const [actions, setActions] = useState<MaintenanceAction[]>([]);
  const [name, setName] = useState(companion.name); const [instructions, setInstructions] = useState(""); const [prompt, setPrompt] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const taskIntent = useRef<{ prompt: string; id: string } | null>(null);
  const load = useCallback(async () => { try { const [next, history] = await Promise.all([workspaceApi.maintenanceDetail(companion.id), workspaceApi.maintenanceActions(companion.id)]); setDetail(next.companion); setName(next.companion.name); setInstructions(next.companion.instructions); setActions(history.actions); setError(""); } catch (cause) { setError(errorText(cause)); } }, [companion.id]);
  useEffect(() => { void load(); }, [load]);
  async function save(event: FormEvent) { event.preventDefault(); setBusy("save"); try { await workspaceApi.updateMaintenanceCompanion(companion.id, { name: name.trim(), instructions: instructions.trim(), modelId: detail?.modelId }); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  async function prepare() { setBusy("prepare"); try { await workspaceApi.prepareMaintenanceCompanion(companion.id); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  async function assign(event: FormEvent) { event.preventDefault(); const nextPrompt = prompt.trim(); if (taskIntent.current?.prompt !== nextPrompt) taskIntent.current = { prompt: nextPrompt, id: crypto.randomUUID() }; setBusy("task"); try { await workspaceApi.createMaintenanceTask(companion.id, taskIntent.current.id, nextPrompt); taskIntent.current = null; setPrompt(""); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  return <div className="sheet-layer"><button className="sheet-scrim" onClick={onClose} aria-label="Close maintenance" /><aside className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="maintenance-sheet-title"><header className="sheet-header"><div><span>Client maintenance</span><h2 id="maintenance-sheet-title">{companion.name}</h2></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close maintenance"><X /></Button></header><div className="settings-body maintenance-body"><p className="consent-note"><ShieldCheck />The client allowed configuration, diagnostics, and maintenance tasks. Their chat and files stay private.</p>{detail ? <><div className="maintenance-status"><span className={`status-dot status-dot--${detail.error ? "error" : detail.status}`} /><div><strong>{detail.error || detail.status}</strong><small>{detail.readyAt ? `Ready ${new Date(detail.readyAt).toLocaleString()}` : "Runtime status"}</small></div><Button variant="outline" size="sm" disabled={!!busy} onClick={() => void prepare()}>{busy === "prepare" ? <LoaderCircle className="spin" /> : <Play />}Prepare</Button></div><form className="inline-create" onSubmit={save}><h3>Configuration</h3><div className="field"><label htmlFor="maintenance-name">Name</label><input id="maintenance-name" value={name} onChange={event => setName(event.target.value)} /></div><div className="field"><label htmlFor="maintenance-instructions">Instructions</label><Textarea id="maintenance-instructions" rows={4} value={instructions} onChange={event => setInstructions(event.target.value)} /></div><Button disabled={!!busy || !name.trim()}>{busy === "save" ? <LoaderCircle className="spin" /> : <Check />}Save</Button></form><form className="inline-create" onSubmit={assign}><h3>Maintenance task</h3><div className="field"><label htmlFor="maintenance-task">What should improve?</label><Textarea id="maintenance-task" rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Check the setup and fix…" /></div><Button disabled={!!busy || !prompt.trim()}>{busy === "task" ? <LoaderCircle className="spin" /> : <Wrench />}Assign task</Button></form><div className="maintenance-history"><span className="detail-label">Recent actions</span>{actions.length ? actions.map(action => <div className="history-row" key={action.id}><span className={`history-dot history-dot--${action.status}`} /><div><strong>{action.operation} · {action.status}</strong><small>{new Date(action.createdAt).toLocaleString()}</small>{action.error && <p>{action.error}</p>}</div></div>) : <p className="settings-empty">No maintenance actions yet.</p>}</div></> : !error && <div className="skeleton skeleton--row" />}{error && <p className="field-error" role="alert">{error}</p>}</div></aside></div>;
}

function ReceivedDelivery({ item, busy, onAccept }: { item: DeliveryReceived; busy: boolean; onAccept: (item: DeliveryReceived, grant: boolean) => Promise<void> }) {
  const [grant, setGrant] = useState(false);
  return <div className="delivery-invite"><CompanionAvatar name={item.name} size={42} /><div><strong>{item.name}</strong><small>Ready to activate</small></div>{item.maintenanceRequested && <label><input type="checkbox" checked={grant} onChange={event => setGrant(event.target.checked)} />Allow maintenance</label>}<Button size="sm" disabled={busy} onClick={() => void onAccept(item, grant)}>{busy ? <LoaderCircle className="spin" /> : <Check />}Accept</Button></div>;
}

export function SpecialistsSettings({ companionId }: { companionId: string }) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]); const [replicas, setReplicas] = useState<Companion[]>([]);
  const [templateId, setTemplateId] = useState(""); const [prompt, setPrompt] = useState(""); const [name, setName] = useState(""); const [instructions, setInstructions] = useState(""); const [avatar, setAvatar] = useState<CompanionAvatarValue>(DEFAULT_AVATAR);
  const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  const load = useCallback(async () => { try { const [a, b] = await Promise.all([workspaceApi.templates(), workspaceApi.replicas(companionId)]); setTemplates(a.templates); setReplicas(b.replicas); setTemplateId(current => current || a.templates[0]?.id || ""); setError(""); } catch (cause) { setError(errorText(cause)); } }, [companionId]);
  useEffect(() => { void load(); }, [load]);
  async function createTemplate(event: FormEvent) { event.preventDefault(); setBusy("template"); try { await workspaceApi.createTemplate({ name: name.trim(), instructions: instructions.trim(), avatar }); setName(""); setInstructions(""); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  async function spawn(event: FormEvent) { event.preventDefault(); setBusy("spawn"); try { await workspaceApi.setTemplatePermission(companionId, templateId, 2); await workspaceApi.spawnReplica(companionId, templateId, prompt.trim()); setPrompt(""); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  return <div className="settings-stack"><div className="settings-intro"><UsersRound /><div><h3>Specialists</h3><p>Reusable profiles for focused work.</p></div></div>
    {replicas.map(item => <div className="settings-item replica-row" key={item.id}><CompanionAvatar name={item.name} avatar={item.avatar} size={34} /><div><strong>{item.name}</strong><small>{item.status}{item.retiredAt ? " · finished" : ""}</small></div></div>)}
    {!!templates.length && <form className="inline-create" onSubmit={spawn}><h3>Launch a specialist</h3><div className="field"><label htmlFor="replica-template">Profile</label><select id="replica-template" value={templateId} onChange={event => setTemplateId(event.target.value)}>{templates.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div><div className="field"><label htmlFor="replica-prompt">Task</label><Textarea id="replica-prompt" rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} /></div><Button disabled={!templateId || !prompt.trim() || !!busy}>{busy === "spawn" ? <LoaderCircle className="spin" /> : <CopyPlus />}Launch</Button></form>}
    <form className="inline-create" onSubmit={createTemplate}><h3>New profile</h3><AvatarPicker value={avatar} onChange={setAvatar} /><div className="field"><label htmlFor="template-name">Name</label><input id="template-name" value={name} onChange={event => setName(event.target.value)} placeholder="Researcher" /></div><div className="field"><label htmlFor="template-instructions">Focus</label><Textarea id="template-instructions" rows={3} value={instructions} onChange={event => setInstructions(event.target.value)} /></div>{error && <p className="field-error">{error}</p>}<Button disabled={!name.trim() || !!busy}>{busy === "template" ? <LoaderCircle className="spin" /> : <Check />}Save profile</Button></form>
  </div>;
}

export function DeliverySettings({ companionId }: { companionId: string }) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]); const [selected, setSelected] = useState<string[]>([]); const [email, setEmail] = useState(""); const [maintenance, setMaintenance] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const deliveryIntent = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => { workspaceApi.templates().then(result => setTemplates(result.templates)).catch(cause => setMessage(errorText(cause))); }, []);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setMessage(""); const signature = JSON.stringify([companionId, email.trim().toLowerCase(), [...selected].sort(), maintenance]); if (deliveryIntent.current?.signature !== signature) deliveryIntent.current = { signature, id: crypto.randomUUID() }; try { await Promise.all(selected.map(templateId => workspaceApi.setTemplatePermission(companionId, templateId, 2))); await workspaceApi.createDelivery({ clientDeliveryId: deliveryIntent.current.id, companionId, clientEmail: email.trim(), templateIds: selected, maintenanceRequested: maintenance }); deliveryIntent.current = null; setEmail(""); setSelected([]); setMaintenance(false); setMessage("Invitation sent."); } catch (cause) { setMessage(errorText(cause)); } finally { setBusy(false); } }
  return <form className="settings-stack delivery-form" onSubmit={submit}><div className="settings-intro"><Send /><div><h3>Deliver to a client</h3><p>A fresh, independent copy.</p></div></div><div className="field"><label htmlFor="delivery-email">Client email</label><input id="delivery-email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="client@company.com" /></div>{!!templates.length && <fieldset className="template-checks"><legend>Include specialist profiles</legend>{templates.map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={() => setSelected(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])} /><CompanionAvatar name={item.name} avatar={item.avatar} size={28} />{item.name}</label>)}</fieldset>}<label className="filter-toggle"><input type="checkbox" checked={maintenance} onChange={event => setMaintenance(event.target.checked)} />Request maintenance access</label>{message && <p className={message === "Invitation sent." ? "success-copy" : "field-error"} role="status">{message}</p>}<Button disabled={!email.trim() || busy}>{busy ? <LoaderCircle className="spin" /> : <Send />}Send invitation</Button></form>;
}

export function DesktopSheet({ companion, onClose, onRefresh }: { companion: Companion; onClose: () => void; onRefresh: () => Promise<void> }) {
  const [waiting, setWaiting] = useState<"pause" | "release" | "prepare" | "">(""); const [error, setError] = useState("");
  const desktopPoll = useRef<{ cancelled: boolean; popup: Window; timer?: number } | null>(null);
  useEffect(() => () => {
    if (!desktopPoll.current) return;
    desktopPoll.current.cancelled = true;
    if (desktopPoll.current.timer) window.clearTimeout(desktopPoll.current.timer);
    if (!desktopPoll.current.popup.closed) desktopPoll.current.popup.close();
  }, []);
  useEffect(() => {
    if (!waiting || waiting === "prepare") return;
    if ((waiting === "pause" && companion.desktopPausedAt) || (waiting === "release" && !companion.desktopPausedAt)) { setWaiting(""); return; }
    if (companion.error) { setError(companion.error); setWaiting(""); return; }
    const timer = window.setInterval(() => void onRefresh(), 1_200); return () => window.clearInterval(timer);
  }, [waiting, companion.desktopPausedAt, companion.error, onRefresh]);
  async function open() {
    const popup = window.open("about:blank", "_blank"); setError("");
    if (!popup) { setError("Allow pop-ups to open the desktop."); return; }
    popup.document.title = `Preparing ${companion.name}`;
    popup.document.body.textContent = "Preparing desktop…";
    popup.document.body.style.cssText = "font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;color:#444;background:#fafafa";
    if (desktopPoll.current) { desktopPoll.current.cancelled = true; if (desktopPoll.current.timer) window.clearTimeout(desktopPoll.current.timer); }
    const poll = { cancelled: false, popup } as { cancelled: boolean; popup: Window; timer?: number };
    desktopPoll.current = poll; setWaiting("prepare"); const startedAt = Date.now();
    const attempt = async () => {
      if (poll.cancelled) return;
      if (popup.closed) { poll.cancelled = true; desktopPoll.current = null; setWaiting(""); return; }
      try {
        const result = await api.openDesktop(companion.id);
        if (poll.cancelled) return;
        if (result.url) { poll.cancelled = true; desktopPoll.current = null; popup.location.replace(result.url); setWaiting(""); void onRefresh(); return; }
        if (Date.now() - startedAt >= 5 * 60_000) { poll.cancelled = true; desktopPoll.current = null; popup.close(); setWaiting(""); setError("The desktop is taking longer than expected. Try again shortly."); return; }
        poll.timer = window.setTimeout(() => void attempt(), 2_000);
      } catch (cause) { poll.cancelled = true; desktopPoll.current = null; popup.close(); setWaiting(""); setError(errorText(cause)); }
    };
    await attempt();
  }
  async function toggle() { const releasing = !!companion.desktopTaken; setWaiting(releasing ? "release" : "pause"); setError(""); try { if (releasing) await workspaceApi.releaseDesktop(companion.id); else await workspaceApi.takeDesktop(companion.id); await onRefresh(); } catch (cause) { setWaiting(""); setError(errorText(cause)); } }
  const confirmedPaused = !!companion.desktopPausedAt;
  return <div className="sheet-layer"><button className="sheet-scrim" onClick={onClose} aria-label="Close desktop controls" /><aside className="desktop-sheet" role="dialog" aria-modal="true" aria-labelledby="desktop-title"><header className="sheet-header"><div><span>{companion.name}</span><h2 id="desktop-title">Desktop</h2></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close desktop controls"><X /></Button></header><div className="desktop-content"><div className={`desktop-state ${confirmedPaused ? "desktop-state--paused" : ""}`}><CompanionAvatar name={companion.name} avatar={companion.avatar} size={68} /><span>{confirmedPaused ? <Pause /> : <MonitorUp />}</span></div><div><h3>{confirmedPaused ? "You have control" : waiting === "prepare" ? "Preparing desktop…" : waiting === "pause" ? "Pausing safely…" : "Open the computer"}</h3><p>{confirmedPaused ? "The Companion stays paused until you release it." : waiting === "prepare" ? "This can take about a minute. The new tab will open when ready." : "View the desktop, or pause the Companion before making changes."}</p></div>{error && <p className="field-error" role="alert">{error}</p>}<div className="desktop-actions"><Button variant="outline" onClick={() => void open()} disabled={!!waiting}>{waiting === "prepare" ? <LoaderCircle className="spin" /> : <ArrowUpRight />}{waiting === "prepare" ? "Preparing…" : "Open desktop"}</Button><Button onClick={() => void toggle()} disabled={!!waiting}>{waiting && waiting !== "prepare" ? <LoaderCircle className="spin" /> : confirmedPaused ? <Play /> : <Pause />}{waiting === "release" ? "Releasing…" : waiting === "pause" ? "Pausing…" : confirmedPaused ? "Release Companion" : "Take control"}</Button></div><div className="trust-note"><ShieldCheck />Pause is shown only after the computer confirms it.</div></div></aside></div>;
}
