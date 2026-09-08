import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import { ArrowRight, Check, CircleAlert, FlaskConical, LoaderCircle, Plug, RotateCw, Send, UserRound, X } from "lucide-react";
import { api, workspaceApi, type SpecialistDraft } from "@/api";
import { SpecialistIdentity } from "./SpecialistIdentity";
import { ApplicationAccess } from "@/components/ApplicationAccess";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import "./SpecialistDraftPanel.css";
import "./SpecialistCreation.css";
import { AvatarPicker, DEFAULT_AVATAR, CompanionAvatar, type CompanionAvatarValue } from "./CompanionAvatar";

const messageFor = (cause: unknown) => cause instanceof Error ? cause.message : "Something went wrong.";

function testStatus(draft: SpecialistDraft) {
  const test = draft.lastTest;
  if (!test) return "Not tested";
  if (test.status === "succeeded" || test.status === "ready") return "Test finished";
  if (test.status === "failed" || test.status === "interrupted" || test.status === "cancelled") return "Test did not finish";
  return "Test in progress";
}

export function SpecialistDraftPanel({ templateId, companionId, onClose, onConnections, onOpenCompanion, avatar, renderChat, onComputer, onContinued }: {
  renderChat?: (cards: ReactNode, history?: Array<{id:string;runId?:string;createdAt:string;content:ReactNode}>) => ReactNode;
  avatar?: CompanionAvatarValue;
  onComputer?: () => void;
  onContinued?: () => Promise<void>;
  templateId: string;
  companionId: string;
  onClose: () => void;
  onConnections?: () => void;
  onOpenCompanion?: (id: string) => void;
}) {
  const [draft, setDraft] = useState<SpecialistDraft | null>(null);
  const fallbackAvatar = useRef(avatar ?? DEFAULT_AVATAR);
  const [appearance, setAppearance] = useState(fallbackAvatar.current);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const reviewedGeneration = useRef<number | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [initScript, setInitScript] = useState("");
  const [testPrompt, setTestPrompt] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | "publish" | "assessment" | "continue" | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [continuedStepId, setContinuedStepId] = useState<string | null>(null);
  const [publishingOpen, setPublishingOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const publicationRef = useRef<HTMLElement>(null);
  const request = useRef(0);
  const editRevision = useRef(0);

  const apply = useCallback((value: SpecialistDraft) => {
    setDraft(value);
    setAppearance(value.avatar ?? fallbackAvatar.current);
    setName(value.name);
    setInstructions(value.instructions);
    setInitScript(value.initScript ?? "");
    if (reviewedGeneration.current !== value.generation) setReviewed(false);
  }, []);

  const load = useCallback(async () => {
    const sequence = ++request.current;
    const startedAtEdit = editRevision.current;
    setLoading(true); setError("");
    try {
      const result = await workspaceApi.templateDraft(templateId);
      if (request.current === sequence && editRevision.current === startedAtEdit) apply(result.draft);
    } catch (cause) {
      if (request.current === sequence) setError(messageFor(cause));
    } finally {
      if (request.current === sequence) setLoading(false);
    }
  }, [apply, templateId]);

  useEffect(() => { void load(); return () => { request.current += 1; }; }, [load]);
  useEffect(() => {
    if (!draft || (draft.status !== "testing" && draft.status !== "publishing")) return;
    const timer = window.setTimeout(() => void load(), 2_000);
    return () => window.clearTimeout(timer);
  }, [draft, load]);

  const operationPending = draft?.status === "testing" || draft?.status === "publishing";
  const controlsDisabled = Boolean(busy) || operationPending;
  const dirty = Boolean(draft) && (name !== draft!.name || instructions !== draft!.instructions || initScript !== (draft!.initScript ?? "") || JSON.stringify(appearance) !== JSON.stringify(draft!.avatar ?? fallbackAvatar.current));
  useEffect(() => {
    if (!draft || identityOpen || dirty || busy || draft.status === "testing" || draft.status === "publishing") return;
    const timer = window.setInterval(() => void load(), 8_000);
    return () => window.clearInterval(timer);
  }, [busy, dirty, draft, identityOpen, load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || controlsDisabled || !name.trim()) return;
    setBusy("save"); setError(""); setNotice("");
    try {
      const result = await workspaceApi.updateTemplateDraft(templateId, {
        expectedGeneration: draft.generation, expectedIdentityRevision: draft.identityRevision ?? 1,
        name: name.trim(), instructions: instructions.trim(), initScript, avatar: appearance,
      });
      apply(result.draft); setNotice("Configuration saved.");
    } catch (cause) { setError(messageFor(cause)); }
    finally { setBusy(""); }
  }

  async function runTest(event: FormEvent) {
    event.preventDefault();
    if (!draft || dirty || controlsDisabled || !testPrompt.trim()) return;
    setBusy("test"); setError(""); setNotice("");
    try {
      const result = await workspaceApi.testTemplateDraft(templateId, { expectedGeneration: draft.generation, prompt: testPrompt.trim() });
      apply(result.draft); setTestPrompt(""); setNotice("Your test is queued. You can follow the mission in its chat.");
    } catch (cause) { setError(messageFor(cause)); }
    finally { setBusy(""); }
  }

  async function assess(assessment: "satisfactory" | "needs_changes") {
    if (!draft?.lastTest || controlsDisabled || dirty) return;
    setBusy("assessment"); setError(""); setNotice("");
    try {
      const result = await workspaceApi.assessTemplateTest(templateId, draft.lastTest.id, assessment);
      apply(result.draft); setNotice(assessment === "satisfactory" ? "Test marked satisfactory." : "Test marked for correction.");
    } catch (cause) { setError(messageFor(cause)); }
    finally { setBusy(""); }
  }

  async function publish() {
    if (!draft || dirty || controlsDisabled || !reviewed) return;
    setBusy("publish"); setError(""); setNotice("");
    try {
      const result = await workspaceApi.publishTemplateDraft(templateId, draft.generation);
      if (result.draft) apply(result.draft); else await load();
      setNotice("Preparing your published version. You can keep this conversation open.");
    } catch (cause) { setError(messageFor(cause)); }
    finally { setBusy(""); }
  }

  if (loading && !draft) return <aside className="specialist-draft specialist-draft--loading" aria-label="Specialist configuration" role="status"><span/><span/><span/></aside>;
  if (!draft) return <aside className="specialist-draft specialist-draft--state" aria-label="Specialist configuration"><CircleAlert/><strong>Couldn’t open this configuration</strong><p>{error}</p><Button variant="outline" onClick={() => void load()}><RotateCw/>Try again</Button></aside>;

  const testFinished = draft.lastTest?.status === "succeeded" || draft.lastTest?.status === "ready";
  const publication = draft.publication;
  const step = draft.nextStep?.respondedAt ? null : draft.nextStep;
  const stepPresentation = step ? {
    profile: { title: 'Meet your specialist', action: 'Looks good, continue', Icon: UserRound },
    connections: { title: 'Give me access to work', action: 'Accounts ready, continue', Icon: Plug },
    test: { title: 'Let’s try a real mission', action: 'Discuss the result', Icon: FlaskConical },
    publish: { title: 'Ready for your team', action: 'Continue the conversation', Icon: Send },
  }[step.kind] : null;
  const show = (kind: 'profile' | 'connections' | 'test' | 'publish') => !renderChat || step?.kind === kind;
  async function continueSetup() {
    if (!step || (dirty && step.kind !== "profile") || !name.trim() || controlsDisabled || continuedStepId === step.id) return;
    setBusy('continue'); setError('');
    try {
      if (dirty && draft) {
        const saved = await workspaceApi.updateTemplateDraft(templateId, { expectedGeneration: draft.generation, expectedIdentityRevision: draft.identityRevision ?? 1, name: name.trim(), instructions: instructions.trim(), initScript, avatar: appearance });
        apply(saved.draft);
      }
      await api.sendMessage(companionId, `I've finished this step: ${step.message}\nCheck the saved state and guide me to the next step.`);
      setContinuedStepId(step.id);
      await onContinued?.();
      setNotice('The specialist will check this step and suggest what to do next.');
    } catch (cause) { setError(messageFor(cause)); }
    finally { setBusy(''); }
  }
  const history = (draft.guidance ?? []).filter(item => item.id !== step?.id).map(item => ({
    id: item.id, runId: item.runId, createdAt: item.createdAt,
    content: <section className="specialist-action-history" aria-label="Previous specialist step"><div><span>{{profile:'Profile',connections:'Apps & accounts',test:'Trial mission',publish:'Publication'}[item.kind]}</span><small>{item.respondedAt ? 'Continued in chat' : 'Earlier suggestion'}</small></div><p>{item.message}</p>{item.providers.length > 0 && <span className="specialist-action-history__apps">{item.providers.join(' · ')}</span>}</section>,
  }));
  const cards = <div className="specialist-draft__content">
      {step && <div className="specialist-guidance-message"><CompanionAvatar name={draft.name} avatar={draft.avatar ?? avatar} size={32}/><div><strong>{draft.name}</strong><p>{step.message}</p></div></div>}
      <div hidden={Boolean(renderChat) && !step && !publishingOpen && !publication} className={step && renderChat ? 'specialist-action-card' : undefined}>
      {stepPresentation && renderChat && <header className="specialist-action-card__heading"><stepPresentation.Icon aria-hidden="true"/><h2>{stepPresentation.title}</h2></header>}
      {show("profile") && <><form className="specialist-profile-card" onSubmit={save}>
        <button type="button" className="specialist-profile-appearance" aria-label="Change appearance" aria-expanded={appearanceOpen} disabled={controlsDisabled} onClick={() => setAppearanceOpen(value => !value)}><CompanionAvatar name={name} avatar={appearance} size={64}/></button>
        <div><label className="sr-only" htmlFor="specialist-name">Name</label><input id="specialist-name" value={name} maxLength={80} disabled={controlsDisabled} onChange={event => { editRevision.current += 1; setName(event.target.value); }}/><p>{draft.instructions || 'Define its role in the conversation.'}</p></div>
        {dirty && <Button type="submit" size="sm" disabled={controlsDisabled || !name.trim()}>Save</Button>}
      </form>
      {appearanceOpen && <fieldset className="specialist-appearance-picker" disabled={controlsDisabled}><legend>Appearance</legend><AvatarPicker value={appearance} onChange={value => { editRevision.current += 1; setAppearance(value); }}/></fieldset>}
      <details className="specialist-draft__settings" open={renderChat ? undefined : true}><summary>Instructions &amp; initialization</summary>
      <form className="specialist-draft__form" onSubmit={save}>

        <label>Instructions<Textarea value={instructions} rows={7} maxLength={20_000} disabled={controlsDisabled} onChange={event => { editRevision.current += 1; setInstructions(event.target.value); setNotice(""); }}/></label>
        <label>Initialization script<span className="specialist-draft__hint">Runs once when a test or intervention copy is created.</span><Textarea className="specialist-draft__script" value={initScript} rows={7} spellCheck={false} disabled={controlsDisabled} placeholder="Optional shell script" onChange={event => { editRevision.current += 1; setInitScript(event.target.value); setNotice(""); }}/></label>
        <Button type="submit" disabled={controlsDisabled || !dirty || !name.trim()}>{busy === "save" ? <LoaderCircle className="spin"/> : <Check/>}{busy === "save" ? "Saving…" : "Save configuration"}</Button>
      </form></details></>}

      {show("connections") && <section className="specialist-draft__section"><div className="specialist-draft__section-title"><div><h3>Apps &amp; accounts</h3><p>Choose an existing account or connect a new one. You stay in control of access.</p></div></div><ApplicationAccess companionId={companionId} onConnect={onConnections} inlineConnections compact={Boolean(renderChat)} providers={step?.providers}/></section>}

      {show("test") && <section className="specialist-draft__section"><div className="specialist-draft__section-title"><div><h3>Test a mission</h3><p>See how it works on a fresh copy before adding it to your team.</p></div><span className={`specialist-draft__status specialist-draft__status--${draft.lastTest?.status ?? "none"}`}>{testStatus(draft)}</span></div>
        {draft.lastTest && <div className="specialist-draft__test-result"><span>Generation {draft.lastTest.generation}</span>{draft.lastTest.error && <p role="alert">{draft.lastTest.error}</p>}{testFinished && <div><Button type="button" size="sm" variant={draft.lastTest.assessment === "satisfactory" ? "default" : "outline"} disabled={controlsDisabled || dirty} onClick={() => void assess("satisfactory")}>Satisfactory</Button><Button type="button" size="sm" variant="outline" disabled={controlsDisabled || dirty} aria-pressed={draft.lastTest.assessment === "needs_changes"} onClick={() => void assess("needs_changes")}>Needs changes</Button></div>}{draft.lastTest.companionId && <Button type="button" size="sm" variant="ghost" onClick={() => onOpenCompanion?.(draft.lastTest!.companionId!)}>Open test chat</Button>}</div>}
        <details className="specialist-test-brief" open><summary>Try a mission</summary><form className="specialist-draft__test" onSubmit={runTest}><label htmlFor={`test-${templateId}`}>Test brief</label><Textarea id={`test-${templateId}`} value={testPrompt} rows={3} disabled={controlsDisabled} placeholder="Give the copy a concrete mission and expected result." onChange={event => setTestPrompt(event.target.value)}/>{dirty && <p>Save this configuration before testing it.</p>}<Button type="submit" variant="outline" disabled={controlsDisabled || dirty || !testPrompt.trim()}>{busy === "test" ? <LoaderCircle className="spin"/> : <FlaskConical/>}{busy === "test" ? "Starting…" : "Test mission"}</Button></form></details>
      </section>}

      <section ref={publicationRef} hidden={Boolean(renderChat) && !publishingOpen && !publication && !show("publish")} className="specialist-draft__section specialist-draft__publish"><div className="specialist-draft__section-title"><div><h3>Publish</h3><p>{publication ? `Publication ${publication.status}${publication.version ? ` · version ${publication.version}` : ""}.` : "Save this prepared specialist so your companions can call on it."}</p></div></div>
        {publication?.error && <p className="specialist-draft__publication-error" role="alert">{publication.error}</p>}
        <label className="specialist-draft__review"><input type="checkbox" checked={reviewed} disabled={controlsDisabled || dirty} onChange={event => { reviewedGeneration.current = draft.generation; setReviewed(event.target.checked); }}/><span><strong>I reviewed the shared content</strong><small>The prepared disk can include browser sessions and credentials stored in files. Managed chat history and platform connections are removed.</small></span></label>
        {(!draft.lastTest || draft.lastTest.generation !== draft.generation) && <p className="specialist-draft__warning">This generation has not been tested. You can still publish it.</p>}
        <Button type="button" disabled={controlsDisabled || dirty || !reviewed} onClick={() => void publish()}>{busy === "publish" ? <LoaderCircle className="spin"/> : <Send/>}{busy === "publish" ? "Publishing…" : "Publish version"}</Button>
      </section>
      {step && step.kind !== 'publish' && <footer className="specialist-action-card__footer"><span>{continuedStepId === step.id ? 'Sent to your specialist' : dirty ? 'Your edits will be saved when you continue.' : 'Or tell me what you’d like to change in the chat.'}</span><Button type="button" disabled={controlsDisabled || (dirty && step.kind !== 'profile') || !name.trim() || continuedStepId === step.id} onClick={() => void continueSetup()}>{busy === 'continue' ? <><LoaderCircle className="spin"/>Sending…</> : continuedStepId === step.id ? <><Check/>Sent</> : <>{stepPresentation?.action}<ArrowRight/></>}</Button></footer>}
      </div>
      {error && <p className="specialist-draft__error" role="alert">{error}</p>}
      {notice && <p className="specialist-draft__notice" role="status">{notice}</p>}
    </div>;
  if (!renderChat) return <aside className="specialist-draft" aria-label="Specialist configuration">{cards}</aside>;
  const published = publication?.status === 'succeeded' && publication.generation === draft.generation;
  const checklist = [
    { label: draft.name === 'New specialist' ? 'Shaping the role' : 'Role defined', done: Boolean(draft.instructions.trim()) && draft.name !== 'New specialist' },
    { label: draft.status === 'testing' ? 'Testing environment' : testFinished && draft.lastTest?.generation === draft.generation ? 'Environment tested' : 'Environment to prepare', done: testFinished && draft.lastTest?.generation === draft.generation },
    { label: draft.lastTest?.assessment === 'satisfactory' ? 'Mission approved' : 'Try a mission', done: draft.lastTest?.assessment === 'satisfactory' && draft.lastTest.generation === draft.generation },
  ];
  return <section className="specialist-studio" aria-label="Specialist configuration">
    {identityOpen && <SpecialistIdentity draft={draft} onClose={() => setIdentityOpen(false)} onSaved={value => { setDraft(value); setName(value.name); setAppearance(value.avatar ?? fallbackAvatar.current); }}/>}
    <header className="specialist-studio-header"><div><button className="specialist-identity-trigger" aria-label="Edit specialist name and appearance" disabled={controlsDisabled} onClick={() => { editRevision.current += 1; setIdentityOpen(true); }}><CompanionAvatar name={draft.name} avatar={draft.avatar ?? avatar} size={28}/><strong>{draft.name}</strong></button><span className="specialist-studio-status">{draft.status === 'publishing' ? 'Publishing' : draft.status === 'testing' ? 'Testing' : published ? 'Published' : 'Draft'}</span></div><div><Button className="specialist-summary-toggle" variant="ghost" aria-expanded={summaryOpen} onClick={() => setSummaryOpen(value => !value)}>Summary</Button>{onComputer && <Button variant="ghost" onClick={onComputer}>Computer</Button>}<Button disabled={controlsDisabled || dirty} onClick={() => { setPublishingOpen(true); window.setTimeout(() => { publicationRef.current?.scrollIntoView({ behavior: 'instant', block: 'center' }); publicationRef.current?.querySelector('input')?.focus(); }, 0); }}>Publish</Button><Button variant="ghost" size="icon" aria-label="Close specialist" onClick={onClose}><X/></Button></div></header>
    <div className="specialist-studio-body">{renderChat(step ? null : cards, step ? [...history, { id: step.id, runId: step.runId, createdAt: step.createdAt, content: cards }] : history)}<aside className={`specialist-studio-summary${summaryOpen ? ' is-open' : ''}`} aria-label="Specialist summary"><button className="specialist-identity-trigger specialist-identity-trigger--summary" aria-label="Change specialist appearance" disabled={controlsDisabled} onClick={() => { editRevision.current += 1; setIdentityOpen(true); }}><CompanionAvatar name={draft.name} avatar={draft.avatar ?? avatar} size={88}/><strong>{draft.name}</strong><small>Edit name &amp; appearance</small></button><p>{draft.instructions || 'A focused role, shaped together.'}</p><ul>{checklist.map(item => <li key={item.label}><span className={`specialist-check${item.done ? ' is-done' : ''}`}>{item.done && <Check/>}</span>{item.label}</li>)}</ul><p className="specialist-studio-summary__note">{published ? 'This version is available to your teams.' : 'Only a published version is available to your teams.'}</p></aside></div>
  </section>;
}
