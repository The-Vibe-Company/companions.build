import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, Clock3, FileText, Inbox, LoaderCircle, Mail, Paperclip, Plus, RefreshCw, Send, ShieldCheck, Trash2, X } from "lucide-react";
import { mailApi, workspaceApi, type CompanionMailbox, type MailAccount, type MailAttachment, type MailMessage } from "@/api";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import "./MailPanel.css";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DRAFT_STATES = ["draft", "prepared", "quota_exceeded"];
const addressPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const aliasPattern = /^[a-z][a-z0-9-]{2,29}$/;
const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong.";
const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const tomorrowAtNine = () => {
  const value = new Date(); value.setDate(value.getDate() + 1); value.setHours(9, 0, 0, 0); return value;
};

function parseAddresses(value: string) {
  return value.split(/[;,\n]/).map(item => item.trim().toLowerCase()).filter(Boolean);
}

function fileAsAttachment(file: File): Promise<MailAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const encoded = String(reader.result).split(",", 2)[1];
      if (!encoded) reject(new Error(`Could not read ${file.name}.`));
      else resolve({ filename: file.name, contentType: file.type || "application/octet-stream", content: encoded });
    };
    reader.readAsDataURL(file);
  });
}

export function MailAccountSettings() {
  const [account, setAccount] = useState<MailAccount | null>(null);
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void mailApi.account().then(value => { setAccount(value); setAlias(value.alias ?? ""); }).catch(cause => setError(errorText(cause))); }, []);
  async function claim(event: FormEvent) {
    event.preventDefault(); if (!aliasPattern.test(alias.trim()) || busy) return;
    setBusy(true); setError("");
    try { const value = await mailApi.setAlias(alias.trim().toLowerCase()); setAccount(value); setAlias(value.alias ?? ""); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <section className="product-section mail-account" aria-labelledby="mail-account-title">
    <div className="section-heading"><div><Mail /><span><h2 id="mail-account-title">Companion email</h2><p>One permanent address prefix for all your Companions.</p></span></div></div>
    {!account && !error ? <div className="skeleton skeleton--row" /> : account && !account.configured ? <p className="mail-unavailable">Email is not configured on this installation.</p> : account?.alias ? <div className="mail-account-address"><div><strong>{account.alias}.…@{account.domain}</strong><small>Your account alias is permanent. Each Companion gets a unique name after it.</small></div><span><Check /> Active</span></div> : <form className="mail-alias-form" onSubmit={claim}><div className="field"><label htmlFor="mail-account-alias">Choose your permanent alias</label><div className="mail-address-input"><input id="mail-account-alias" value={alias} onChange={event => setAlias(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} autoCapitalize="none" autoComplete="off" placeholder="stan" minLength={3} maxLength={30} pattern="[a-z][a-z0-9-]{2,29}" /><span>.companion@{account?.domain ?? "mail.companions.build"}</span></div><small>3–30 characters, starting with a letter. This cannot be changed after you claim it.</small></div><Button disabled={busy || !aliasPattern.test(alias.trim())}>{busy ? <LoaderCircle className="spin" /> : <Check />}Claim alias</Button></form>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}

type MailView = "inbox" | "sent" | "drafts";

export function MailPanel({ companionId, companionName }: { companionId: string; companionName: string }) {
  const [data, setData] = useState<CompanionMailbox | null>(null);
  const [view, setView] = useState<MailView>("inbox");
  const [selectedId, setSelectedId] = useState("");
  const [composing, setComposing] = useState(false);
  const [localName, setLocalName] = useState(companionName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  const [sender, setSender] = useState("");
  const [to, setTo] = useState(""); const [cc, setCc] = useState(""); const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(""); const [body, setBody] = useState(""); const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const draftIntent = useRef<{ signature: string; id: string } | null>(null);
  const loadRequest = useRef(0);
  const load = useCallback(async () => { const request = ++loadRequest.current; try { const next = await mailApi.mailbox(companionId); if (request === loadRequest.current) { setData(next); setError(""); } } catch (cause) { if (request === loadRequest.current) setError(errorText(cause)); } }, [companionId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 4_000);
    return () => { window.clearInterval(timer); loadRequest.current++; };
  }, [load]);
  const messages = useMemo(() => [...(data?.messages ?? [])].filter(message => view === "inbox" ? message.direction === "inbound" : view === "drafts" ? DRAFT_STATES.includes(message.state) : message.direction === "outbound" && !DRAFT_STATES.includes(message.state)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [data?.messages, view]);
  const selected = messages.find(message => message.id === selectedId) ?? messages[0];
  const quotaLeft = Math.max(0, (data?.quota.limit ?? 50) - (data?.quota.used ?? 0));

  async function createMailbox(event: FormEvent) {
    event.preventDefault(); setBusy("mailbox"); setError("");
    try { setData(await mailApi.createMailbox(companionId, localName.trim().toLowerCase())); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(""); }
  }
  async function changeSender(email: string, remove = false) {
    setBusy(`sender:${email}`); setError("");
    try { setData(remove ? await mailApi.removeSender(companionId, email) : await mailApi.allowSender(companionId, email)); setSender(""); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(""); }
  }
  function addFiles(next: File[]) {
    if (files.length + next.length > MAX_ATTACHMENTS) { setError(`Attach up to ${MAX_ATTACHMENTS} files.`); return; }
    if (next.some(file => file.size < 1 || file.size > MAX_ATTACHMENT_BYTES) || [...files, ...next].reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) { setError("Attachments can total up to 10 MB."); return; }
    setFiles(current => [...current, ...next]); setError("");
  }
  async function prepare(event: FormEvent) {
    event.preventDefault();
    const recipients = { to: parseAddresses(to), cc: parseAddresses(cc), bcc: parseAddresses(bcc) };
    const invalid = [...recipients.to, ...recipients.cc, ...recipients.bcc].find(address => !addressPattern.test(address));
    if (!recipients.to.length) { setError("Add at least one recipient."); return; }
    if (invalid) { setError(`${invalid} is not a valid email address.`); return; }
    setBusy("prepare"); setError(""); setNotice("");
    try {
      const attachments: MailAttachment[] = [];
      for (const file of files) attachments.push(await fileAsAttachment(file));
      const signature = JSON.stringify([recipients, subject.trim(), body.trim(), attachments]);
      if (draftIntent.current?.signature !== signature) draftIntent.current = { signature, id: crypto.randomUUID() };
      const result = await mailApi.prepare(companionId, { clientId: draftIntent.current.id, ...recipients, subject: subject.trim(), text: body.trim(), attachments });
      draftIntent.current = null; setData(current => current ? { ...current, messages: [result.message, ...current.messages.filter(item => item.id !== result.message.id)] } : current);
      setTo(""); setCc(""); setBcc(""); setSubject(""); setBody(""); setFiles([]); setComposing(false); setView("drafts"); setSelectedId(result.message.id); setNotice("Draft prepared. Review it before sending.");
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); }
  }
  async function approve(message: MailMessage, tomorrow = false) {
    setBusy(`approve:${message.id}`); setError(""); setNotice("");
    try { await mailApi.approve(companionId, message.id, tomorrow ? tomorrowAtNine().toISOString() : undefined); await load(); setNotice(tomorrow ? "Email scheduled for tomorrow at 9:00." : "Email approved and queued to send."); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(""); }
  }
  async function remind(message: MailMessage) {
    setBusy(`remind:${message.id}`); setError(""); setNotice(""); const runAt = tomorrowAtNine();
    try { await workspaceApi.createRoutine(companionId, { name: `Review email: ${message.subject || "No subject"}`.slice(0, 100), prompt: `Remind me to review prepared email draft ${message.id}. Publish this reminder in the main chat using publish_to_chat. Do not send the email automatically.`, runAt: runAt.toISOString(), enabled: true }); setNotice("Reminder set for tomorrow at 9:00. The draft will not send automatically."); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(""); }
  }
  async function cancel(message: MailMessage) { setBusy(`cancel:${message.id}`); setError(""); try { await mailApi.cancel(companionId, message.id); await load(); setNotice("Draft cancelled."); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }

  if (!data && !error) return <div className="mail-loading" role="status"><div className="skeleton skeleton--title" /><div className="skeleton skeleton--message" /></div>;
  if (!data) return <div className="mail-error"><p className="field-error" role="alert">{error}</p><Button variant="outline" onClick={() => void load()}><RefreshCw />Try again</Button></div>;
  if (data.configured === false) return <div className="mail-setup"><Mail /><h2>Email unavailable</h2><p>Email is not configured on this installation.</p></div>;
  if (!data.mailbox) return <div className="mail-setup"><Mail /><h2>Give {companionName} an inbox.</h2><p>Choose the unique Companion name that follows your permanent account alias. Once created, this email address cannot be changed.</p><form onSubmit={createMailbox}><div className="field"><label htmlFor="mail-local-name">Companion email name</label><input id="mail-local-name" value={localName} onChange={event => setLocalName(event.target.value.replace(/[^a-zA-Z0-9-]/g, ""))} autoCapitalize="none" autoComplete="off" /></div><Button disabled={!localName.trim() || busy === "mailbox"}>{busy === "mailbox" ? <LoaderCircle className="spin" /> : <Plus />}Create inbox</Button></form>{error && <p className="field-error" role="alert">{error}</p>}</div>;

  return <div className="mail-panel">
    <header className="mail-toolbar"><div><h2>{data.mailbox.address}</h2><p>{quotaLeft} of {data.quota.limit} recipient units left today · resets {formatDate(data.quota.resetsAt)}</p></div><div><Button variant="ghost" size="icon" aria-label="Refresh mail" disabled={!!busy} onClick={() => void load()}><RefreshCw /></Button><Button onClick={() => setComposing(true)}><Plus />New email</Button></div></header>
    {error && <p className="field-error mail-notice" role="alert">{error}</p>}{notice && <p className="success-copy mail-notice" role="status">{notice}</p>}
    {composing && <form className="mail-compose" onSubmit={prepare}><div className="mail-compose-heading"><div><strong>New email</strong><small>Preparing saves a draft. It does not send.</small></div><Button type="button" variant="ghost" size="icon" aria-label="Close composer" onClick={() => setComposing(false)}><X /></Button></div><div className="field"><label htmlFor="mail-to">To</label><input id="mail-to" value={to} onChange={event => setTo(event.target.value)} placeholder="alex@example.com, sam@example.com" /></div><details><summary>Cc and Bcc</summary><div className="mail-address-grid"><div className="field"><label htmlFor="mail-cc">Cc</label><input id="mail-cc" value={cc} onChange={event => setCc(event.target.value)} /></div><div className="field"><label htmlFor="mail-bcc">Bcc</label><input id="mail-bcc" value={bcc} onChange={event => setBcc(event.target.value)} /></div></div></details><div className="field"><label htmlFor="mail-subject">Subject</label><input id="mail-subject" value={subject} onChange={event => setSubject(event.target.value)} /></div><div className="field"><label htmlFor="mail-body">Message</label><Textarea id="mail-body" rows={7} value={body} onChange={event => setBody(event.target.value)} /></div>{files.length > 0 && <div className="mail-files">{files.map((file, index) => <span key={`${file.name}:${file.lastModified}`}><FileText />{file.name}<button type="button" onClick={() => setFiles(current => current.filter((_, item) => item !== index))} aria-label={`Remove ${file.name}`}><X /></button></span>)}</div>}<div className="mail-compose-actions"><label className="mail-attach"><Paperclip />Attach<input type="file" multiple onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} /></label><Button disabled={busy === "prepare" || !to.trim() || !body.trim()}>{busy === "prepare" ? <LoaderCircle className="spin" /> : <FileText />}Prepare preview</Button></div></form>}
    <div className="mail-workspace">
      <aside className="mail-nav"><div role="tablist" aria-label="Mail folders"><button role="tab" aria-selected={view === "inbox"} onClick={() => { setView("inbox"); setSelectedId(""); }}><Inbox />Inbox</button><button role="tab" aria-selected={view === "sent"} onClick={() => { setView("sent"); setSelectedId(""); }}><Send />Sent</button><button role="tab" aria-selected={view === "drafts"} onClick={() => { setView("drafts"); setSelectedId(""); }}><FileText />Drafts</button></div><AllowedSenders values={data.senders} value={sender} busy={busy} onValue={setSender} onAdd={() => void changeSender(sender.trim().toLowerCase())} onRemove={email => void changeSender(email, true)} /></aside>
      <section className="mail-list" aria-label={`${view} messages`}>{messages.length ? messages.map(message => <button key={message.id} className={message.id === selected?.id ? "mail-row mail-row--selected" : "mail-row"} onClick={() => setSelectedId(message.id)}><span><strong>{view === "inbox" ? message.sender : message.to.join(", ")}</strong><time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time></span><b>{message.subject || "(No subject)"}</b><small>{message.text}</small><em>{message.state.replaceAll("_", " ")}</em></button>) : <div className="mail-empty"><Mail /><strong>No {view} yet</strong><span>{view === "inbox" ? "Messages from allowed senders will appear here." : view === "drafts" ? "Prepare an email to review it before sending." : "Approved emails and their delivery state appear here."}</span></div>}</section>
      <section className="mail-preview" aria-label="Email preview">{selected ? <MailPreview companionId={companionId} message={selected} busy={busy} onApprove={approve} onRemind={remind} onCancel={cancel} /> : <div className="mail-preview-empty">Select an email to read it.</div>}</section>
    </div>
  </div>;
}

function AllowedSenders({ values, value, busy, onValue, onAdd, onRemove }: { values: string[]; value: string; busy: string; onValue: (value: string) => void; onAdd: () => void; onRemove: (email: string) => void }) {
  return <details className="mail-senders"><summary><ShieldCheck />Allowed senders</summary><p>Your account email, these addresses, and recipients replying within an approved thread can reach this Companion.</p>{values.map(email => <div key={email}><span>{email}</span><button aria-label={`Remove ${email}`} disabled={!!busy} onClick={() => onRemove(email)}><Trash2 /></button></div>)}<form onSubmit={event => { event.preventDefault(); if (addressPattern.test(value.trim())) onAdd(); }}><label className="sr-only" htmlFor="allowed-sender">Allowed sender email</label><input id="allowed-sender" type="email" value={value} onChange={event => onValue(event.target.value)} placeholder="person@example.com" /><Button size="icon" variant="outline" aria-label="Add allowed sender" disabled={!addressPattern.test(value.trim()) || !!busy}>{busy === `sender:${value.trim().toLowerCase()}` ? <LoaderCircle className="spin" /> : <Plus />}</Button></form></details>;
}

function MailPreview({ companionId, message, busy, onApprove, onRemind, onCancel }: { companionId: string; message: MailMessage; busy: string; onApprove: (message: MailMessage, tomorrow?: boolean) => void; onRemind: (message: MailMessage) => void; onCancel: (message: MailMessage) => void }) {
  const prepared = DRAFT_STATES.includes(message.state);
  const recipients = [message.to.length && `To: ${message.to.join(", ")}`, message.cc.length && `Cc: ${message.cc.join(", ")}`, message.bcc.length && `Bcc: ${message.bcc.join(", ")}`].filter(Boolean);
  return <article><header><span>{message.direction === "inbound" ? message.sender : message.sender || "Companion email"}</span><time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time><h3>{message.subject || "(No subject)"}</h3>{recipients.map(value => <small key={String(value)}>{value}</small>)}</header>{message.html ? <iframe className="mail-html-preview" title="Email content" sandbox="" srcDoc={message.html} /> : <div className="mail-preview-body">{message.text}</div>}{message.attachments.length > 0 && <div className="mail-preview-files">{message.attachments.map((file, index) => <a href={mailApi.attachmentUrl(companionId, message.id, file.index ?? index)} key={`${file.filename}:${file.index ?? index}`}><FileText />{file.filename}{typeof file.size === "number" ? ` · ${Math.max(1, Math.ceil(file.size / 1024))} KB` : ""}</a>)}</div>}{message.sendAfter && <p className="mail-scheduled"><Clock3 />Scheduled {formatDate(message.sendAfter)}</p>}{(message.errorCode || message.state === "quota_exceeded") && <p className="field-error" role="alert">{(message.errorCode || message.state).replaceAll("_", " ")}. This email will not retry automatically.</p>}{message.state === "queued" && <footer><Button variant="outline" disabled={!!busy} onClick={() => onCancel(message)}>Cancel scheduled send</Button></footer>}{prepared && <footer><p>Review every recipient and attachment. Sending uses one daily unit per recipient.</p><div>{message.state !== "quota_exceeded" && <Button disabled={!!busy} onClick={() => onApprove(message)}>{busy === `approve:${message.id}` ? <LoaderCircle className="spin" /> : <Send />}Send now</Button>}<Button variant="outline" disabled={!!busy} onClick={() => onApprove(message, true)}><Clock3 />Send tomorrow</Button><Button variant="ghost" disabled={!!busy} onClick={() => onRemind(message)}>Remind me tomorrow</Button><Button variant="ghost" disabled={!!busy} onClick={() => onCancel(message)}>Cancel draft</Button></div></footer>}</article>;
}
