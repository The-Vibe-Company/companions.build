import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, CircleAlert, FlaskConical, LoaderCircle, RotateCw, Send, X } from "lucide-react";
import { workspaceApi, type SpecialistDraft } from "@/api";
import { ApplicationAccess } from "@/components/ApplicationAccess";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import "./SpecialistDraftPanel.css";

const messageFor = (cause: unknown) => cause instanceof Error ? cause.message : "Something went wrong.";

function testStatus(draft: SpecialistDraft) {
  const test = draft.lastTest;
  if (!test) return "Not tested";
  if (test.status === "succeeded" || test.status === "ready") return "Test finished";
  if (test.status === "failed" || test.status === "interrupted" || test.status === "cancelled") return "Test did not finish";
  return "Test in progress";
}

export function SpecialistDraftPanel({ templateId, companionId, onClose, onConnections }: {
  templateId: string;
  companionId: string;
  onClose: () => void;
  onConnections: () => void;
}) {
  const [draft, setDraft] = useState<SpecialistDraft | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [initScript, setInitScript] = useState("");
  const [testPrompt, setTestPrompt] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | "publish" | "assessment" | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef(0);

  const apply = useCallback((value: SpecialistDraft) => {
    setDraft(value);
    setName(value.name);
    setInstructions(value.instructions);
    setInitScript(value.initScript ?? "");
    setReviewed(false);
  }, []);

  const load = useCallback(async () => {
    const sequence = ++request.current;
    setLoading(true); setError("");
    try {
      const result = await workspaceApi.templateDraft(templateId);
      if (request.current === sequence) apply(result.draft);
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

  const dirty = Boolean(draft) && (name !== draft!.name || instructions !== draft!.instructions || initScript !== draft!.initScript);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy || !name.trim()) return;
    setBusy("save"); setError(""); setNotice("");
    try {
      const result = await workspaceApi.updateTemplateDraft(templateId, {
        expectedGeneration: draft.generation,
        name: name.trim(), instructions: instructions.trim(), initScript,
      });
      apply(result.draft); setNotice("Configuration saved.");
    } catch (cause) { setError(messageFor(cause)); }
    finally { setBusy(""); }
  }

  async function runTest(event: FormEvent) {
    event.preventDefault();
    if (!draft || dirty || busy || !testPrompt.trim()) return;
    setBusy("test"); setError(""); setNotice("");
    try {
      const result = await workspaceApi.testTemplateDraft(templateId, { expectedGeneration: draft.generation, prompt: testPrompt.trim() });
      apply(result.draft); setTestPrompt(""); setNotice("Test requested. Its persisted status appears below.");
    } catch (cause) { setError(messageFor(cause)); }
    finally { setBusy(""); }
  }

  async function assess(assessment: "satisfactory" | "needs_changes") {
    if (!draft?.lastTest || busy) return;
    setBusy("assessment"); setError(""); setNotice("");
    try {
      const result = await workspaceApi.assessTemplateTest(templateId, draft.lastTest.id, assessment);
      apply(result.draft); setNotice(assessment === "satisfactory" ? "Test marked satisfactory." : "Test marked for correction.");
    } catch (cause) { setError(messageFor(cause)); }
    finally { setBusy(""); }
  }

  async function publish() {
    if (!draft || dirty || busy || !reviewed) return;
    setBusy("publish"); setError(""); setNotice("");
    try {
      const result = await workspaceApi.publishTemplateDraft(templateId, draft.generation);
      if (result.draft) apply(result.draft); else await load();
      setNotice("Publication requested. The status shown here comes from the saved draft.");
    } catch (cause) { setError(messageFor(cause)); }
    finally { setBusy(""); }
  }

  if (loading && !draft) return <aside className="specialist-draft specialist-draft--loading" aria-label="Specialist configuration" role="status"><span/><span/><span/></aside>;
  if (!draft) return <aside className="specialist-draft specialist-draft--state" aria-label="Specialist configuration"><CircleAlert/><strong>Couldn’t open this configuration</strong><p>{error}</p><Button variant="outline" onClick={() => void load()}><RotateCw/>Try again</Button></aside>;

  const testFinished = draft.lastTest?.status === "succeeded" || draft.lastTest?.status === "ready";
  const publication = draft.publication;
  return <aside className="specialist-draft" aria-label="Specialist configuration">
    <header className="specialist-draft__header"><div><span>Draft specialist</span><h2>Configuration</h2></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close configuration"><X/></Button></header>
    <div className="specialist-draft__content">
      <p className="specialist-draft__intro">Prepare this reusable environment in chat, then save the instructions that future copies receive.</p>
      <form className="specialist-draft__form" onSubmit={save}>
        <label>Name<input value={name} maxLength={80} disabled={Boolean(busy)} onChange={event => { setName(event.target.value); setNotice(""); }}/></label>
        <label>Instructions<Textarea value={instructions} rows={7} maxLength={20_000} disabled={Boolean(busy)} onChange={event => { setInstructions(event.target.value); setNotice(""); }}/></label>
        <label>Initialization script<span className="specialist-draft__hint">Runs once when a test or intervention copy is created.</span><Textarea className="specialist-draft__script" value={initScript} rows={7} spellCheck={false} disabled={Boolean(busy)} placeholder="Optional shell script" onChange={event => { setInitScript(event.target.value); setNotice(""); }}/></label>
        <Button type="submit" disabled={Boolean(busy) || !dirty || !name.trim()}>{busy === "save" ? <LoaderCircle className="spin"/> : <Check/>}{busy === "save" ? "Saving…" : "Save configuration"}</Button>
      </form>

      <section className="specialist-draft__section"><div className="specialist-draft__section-title"><div><h3>Apps &amp; accounts</h3><p>Select the real accounts used while preparing this draft.</p></div></div><ApplicationAccess companionId={companionId} onConnect={onConnections}/></section>

      <section className="specialist-draft__section"><div className="specialist-draft__section-title"><div><h3>Test a mission</h3><p>A test runs on a fresh copy of this saved generation.</p></div><span className={`specialist-draft__status specialist-draft__status--${draft.lastTest?.status ?? "none"}`}>{testStatus(draft)}</span></div>
        {draft.lastTest && <div className="specialist-draft__test-result"><span>Generation {draft.lastTest.generation}</span>{draft.lastTest.error && <p role="alert">{draft.lastTest.error}</p>}{testFinished && <div><Button type="button" size="sm" variant={draft.lastTest.assessment === "satisfactory" ? "default" : "outline"} disabled={Boolean(busy)} onClick={() => void assess("satisfactory")}>Satisfactory</Button><Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} aria-pressed={draft.lastTest.assessment === "needs_changes"} onClick={() => void assess("needs_changes")}>Needs changes</Button></div>}</div>}
        <form className="specialist-draft__test" onSubmit={runTest}><label htmlFor={`test-${templateId}`}>Test brief</label><Textarea id={`test-${templateId}`} value={testPrompt} rows={3} disabled={Boolean(busy)} placeholder="Give the copy a concrete mission and expected result." onChange={event => setTestPrompt(event.target.value)}/>{dirty && <p>Save this configuration before testing it.</p>}<Button type="submit" variant="outline" disabled={Boolean(busy) || dirty || !testPrompt.trim()}>{busy === "test" ? <LoaderCircle className="spin"/> : <FlaskConical/>}{busy === "test" ? "Starting…" : "Test mission"}</Button></form>
      </section>

      <section className="specialist-draft__section specialist-draft__publish"><div className="specialist-draft__section-title"><div><h3>Publish</h3><p>{publication ? `Publication ${publication.status}${publication.version ? ` · version ${publication.version}` : ""}.` : "Make an immutable version available to teams."}</p></div></div>
        {publication?.error && <p className="specialist-draft__publication-error" role="alert">{publication.error}</p>}
        <label className="specialist-draft__review"><input type="checkbox" checked={reviewed} disabled={Boolean(busy) || dirty} onChange={event => setReviewed(event.target.checked)}/><span><strong>I reviewed the shared content</strong><small>The prepared disk can include browser sessions and credentials stored in files. Managed chat history and platform connections are removed.</small></span></label>
        {!draft.lastTest && <p className="specialist-draft__warning">This generation has not been tested. You can still publish it.</p>}
        <Button type="button" disabled={Boolean(busy) || dirty || !reviewed} onClick={() => void publish()}>{busy === "publish" ? <LoaderCircle className="spin"/> : <Send/>}{busy === "publish" ? "Publishing…" : "Publish version"}</Button>
      </section>
      {error && <p className="specialist-draft__error" role="alert">{error}</p>}
      {notice && <p className="specialist-draft__notice" role="status">{notice}</p>}
    </div>
  </aside>;
}
