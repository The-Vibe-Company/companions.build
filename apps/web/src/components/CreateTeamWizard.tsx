import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Check, ChevronRight, LoaderCircle, Plus, UsersRound, X } from "lucide-react";
import { api, workspaceApi, type AgentTemplate, type AppConfig, type Companion } from "@/api";
import { AvatarPicker, CompanionAvatar, randomizeAvatar, type CompanionAvatarValue } from "@/components/CompanionAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import "./CreateTeamWizard.css";

interface CreateTeamWizardProps {
  config: AppConfig;
  companions: Companion[];
  onCreated: (companion: Companion) => void;
  onCancel: () => void;
}

type Step = "coordinator" | "specialists" | "review";
type CoordinatorChoice = { kind: "existing"; id: string } | { kind: "new" };

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "Something went wrong. Please try again.";

export function CreateTeamWizard({ config, companions, onCreated, onCancel }: CreateTeamWizardProps) {
  const [step, setStep] = useState<Step>("coordinator");
  const [choice, setChoice] = useState<CoordinatorChoice>(companions[0] ? { kind: "existing", id: companions[0].id } : { kind: "new" });
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [avatar, setAvatar] = useState<CompanionAvatarValue>(randomizeAvatar);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templateError, setTemplateError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [creationStarted, setCreationStarted] = useState(false);
  const [permissionWriteCommitted, setPermissionWriteCommitted] = useState(false);
  const creationId = useRef(crypto.randomUUID());
  const createdCoordinator = useRef<Companion | null>(null);
  const grantedTemplateIds = useRef(new Set<string>());

  const provider = config.boxAvailable ? "box" : "local";
  const providerAvailable = config.localAvailable || config.boxAvailable;
  const existingCoordinator = choice.kind === "existing" ? companions.find(item => item.id === choice.id) : undefined;
  const coordinator = createdCoordinator.current ?? existingCoordinator;
  const selectedTemplates = useMemo(
    () => selectedTemplateIds.map(id => templates.find(template => template.id === id)).filter((template): template is AgentTemplate => Boolean(template)),
    [selectedTemplateIds, templates],
  );
  const committed = creationStarted || permissionWriteCommitted;
  const interactionLocked = saving || committed;

  async function loadTemplates() {
    setLoadingTemplates(true);
    setTemplateError("");
    try {
      const result = await workspaceApi.templates();
      setTemplates(result.templates);
    } catch (cause) {
      setTemplateError(errorText(cause));
    } finally {
      setLoadingTemplates(false);
    }
  }

  useEffect(() => { void loadTemplates(); }, []);

  function continueFromCoordinator(event: FormEvent) {
    event.preventDefault();
    if (choice.kind === "new" && (!name.trim() || !instructions.trim() || !providerAvailable)) return;
    if (choice.kind === "existing" && !existingCoordinator) return;
    setStep("specialists");
  }

  function toggleTemplate(id: string) {
    setSelectedTemplateIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  }

  async function createTeam() {
    setSaving(true);
    setSaveError("");
    try {
      let target = createdCoordinator.current ?? existingCoordinator;
      if (choice.kind === "new" && !target) {
        setCreationStarted(true);
        const result = await api.createCompanion({
          clientCreationId: creationId.current,
          name: name.trim(),
          instructions: instructions.trim(),
          provider,
          avatar,
          prepare: true,
        });
        target = result.companion;
        createdCoordinator.current = target;
      }
      if (!target) throw new Error("Choose a coordinator before creating the team.");

      if (selectedTemplates.length > 0) {
        const currentPermissions = await workspaceApi.companionTemplates(target.id);
        for (const permission of currentPermissions.templates) {
          if (permission.maxChildren > 0 && selectedTemplateIds.includes(permission.templateId)) {
            grantedTemplateIds.current.add(permission.templateId);
          }
        }
      }
      for (const template of selectedTemplates) {
        if (grantedTemplateIds.current.has(template.id)) continue;
        await workspaceApi.setTemplatePermission(target.id, template.id, 2);
        grantedTemplateIds.current.add(template.id);
        setPermissionWriteCommitted(true);
      }
      onCreated(target);
    } catch (cause) {
      setSaveError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  const remainingPermissions = selectedTemplateIds.filter(id => !grantedTemplateIds.current.has(id)).length;
  const creationOutcomeUnknown = choice.kind === "new" && creationStarted && !createdCoordinator.current;

  return (
    <section className="team-wizard" aria-labelledby="team-wizard-title">
      <header className="team-wizard__header">
        <div>
          <span>Create a team</span>
          <h1 id="team-wizard-title">{step === "coordinator" ? "Who will lead?" : step === "specialists" ? "Who can help?" : "Your team, at a glance"}</h1>
        </div>
        <button className="team-wizard__close" type="button" onClick={onCancel} disabled={interactionLocked} aria-label={interactionLocked ? "Finish saving before closing" : "Close team creation"}><X /></button>
      </header>

      <ol className="team-wizard__progress" aria-label="Team creation progress">
        {["coordinator", "specialists", "review"].map((item, index) => (
          <li key={item} className={step === item ? "is-current" : (["coordinator", "specialists", "review"].indexOf(step) > index ? "is-complete" : "")} aria-current={step === item ? "step" : undefined}>
            <span>{index + 1}</span>{item === "coordinator" ? "Coordinator" : item === "specialists" ? "Specialists" : "Review"}
          </li>
        ))}
      </ol>

      {step === "coordinator" && <form className="team-wizard__body" onSubmit={continueFromCoordinator}>
        <p className="team-wizard__lede">Choose the Companion you’ll talk to. They can call on the specialists you add next.</p>
        {companions.length > 0 && <fieldset className="team-wizard__choices">
          <legend>Use an existing Companion</legend>
          {companions.map(companion => <label className="team-wizard__choice" key={companion.id}>
            <input type="radio" name="coordinator" checked={choice.kind === "existing" && choice.id === companion.id} onChange={() => setChoice({ kind: "existing", id: companion.id })} />
            <CompanionAvatar name={companion.name} avatar={companion.avatar} size={48} />
            <span><strong>{companion.name}</strong><small>{companion.instructions}</small></span>
            <Check className="team-wizard__check" />
          </label>)}
        </fieldset>}

        <label className="team-wizard__new-choice">
          <input type="radio" name="coordinator" checked={choice.kind === "new"} onChange={() => setChoice({ kind: "new" })} />
          <span className="team-wizard__new-icon"><Plus /></span>
          <span><strong>Create a new Companion</strong><small>Give your coordinator a name and purpose.</small></span>
        </label>

        {choice.kind === "new" && <div className="team-wizard__new-fields">
          <div className="field"><label htmlFor="team-coordinator-name">Name</label><input id="team-coordinator-name" value={name} onChange={event => setName(event.target.value)} placeholder="Ada" maxLength={80} autoFocus /></div>
          <div className="field"><label htmlFor="team-coordinator-purpose">Purpose</label><Textarea id="team-coordinator-purpose" value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Help me develop and maintain my application" rows={3} maxLength={20000} /></div>
          <details className="team-wizard__appearance"><summary><CompanionAvatar name="Appearance preview" avatar={avatar} size={44} /><span><strong>Appearance</strong><small>Optional · make them easy to recognize</small></span><ChevronRight /></summary><AvatarPicker value={avatar} onChange={setAvatar} /></details>
          {!providerAvailable && <p className="team-wizard__error" role="alert">No Companion computer is available right now.</p>}
        </div>}
        <div className="team-wizard__actions"><Button type="submit" disabled={(choice.kind === "new" && (!name.trim() || !instructions.trim() || !providerAvailable)) || (choice.kind === "existing" && !existingCoordinator)}>Continue<ChevronRight /></Button></div>
      </form>}

      {step === "specialists" && <div className="team-wizard__body">
        <p className="team-wizard__lede">Add reusable specialists now, or start with just your coordinator. Nothing starts running when you create the team.</p>
        {loadingTemplates ? <div className="team-wizard__loading" role="status"><LoaderCircle className="spin" />Loading specialists…</div> : templateError ? <div className="team-wizard__load-error" role="alert"><p>{templateError}</p><Button type="button" variant="outline" onClick={() => void loadTemplates()}>Try again</Button></div> : templates.length ? <fieldset className="team-wizard__templates">
          <legend>Available specialists</legend>
          {templates.map(template => <label className="team-wizard__template" key={template.id}>
            <input type="checkbox" checked={selectedTemplateIds.includes(template.id)} onChange={() => toggleTemplate(template.id)} />
            <CompanionAvatar name={template.name} avatar={template.avatar} size={48} />
            <span><strong>{template.name}</strong><small>{template.instructions}</small></span>
            <Check className="team-wizard__check" />
          </label>)}
        </fieldset> : <div className="team-wizard__empty"><UsersRound /><strong>No specialist profiles yet</strong><p>You can create one later from the Team page.</p></div>}
        {templates.length > 0 && <p className="team-wizard__later"><Plus /> Need a new profile? You can create it later from the Team page.</p>}
        <div className="team-wizard__actions"><Button type="button" variant="ghost" onClick={() => setStep("coordinator")}><ArrowLeft />Back</Button><Button type="button" onClick={() => setStep("review")}>Review team<ChevronRight /></Button></div>
      </div>}

      {step === "review" && <div className="team-wizard__body">
        <p className="team-wizard__lede">{choice.kind === "new"
          ? "Your new coordinator’s computer will start preparing as soon as you create the team. Specialists start when given a task."
          : "This gives your coordinator permission to call on these specialists. It won’t start a task or wake a computer."}</p>
        <div className="team-wizard__review">
          <div className="team-wizard__review-lead"><span>Coordinator</span>{coordinator ? <><CompanionAvatar name={coordinator.name} avatar={coordinator.avatar} size={64} /><div><strong>{coordinator.name}</strong><small>{coordinator.instructions}</small></div></> : <><CompanionAvatar name={name} avatar={avatar} size={64} /><div><strong>{name}</strong><small>{instructions}</small></div></>}</div>
          <div className="team-wizard__review-specialists"><span>Can ask for help from</span>{selectedTemplates.length ? selectedTemplates.map(template => <div key={template.id}><CompanionAvatar name={template.name} avatar={template.avatar} size={44} /><p><strong>{template.name}</strong><small>{template.instructions}</small></p>{grantedTemplateIds.current.has(template.id) && <em><Check />Added</em>}</div>) : <p className="team-wizard__solo">No specialists yet. You can add them later.</p>}</div>
        </div>
        {saveError && <div className="team-wizard__save-error" role="alert"><strong>{creationOutcomeUnknown ? "We couldn’t confirm what was saved." : committed ? "Your progress is saved." : "The team couldn’t be saved."}</strong><p>{saveError}</p>{creationOutcomeUnknown ? <small>Retry to continue safely with the same creation request.</small> : committed && remainingPermissions > 0 ? <small>{remainingPermissions} specialist{remainingPermissions === 1 ? "" : "s"} still to add. Retry to continue without duplicating your coordinator.</small> : null}</div>}
        <div className="team-wizard__actions">
          {!committed && <Button type="button" variant="ghost" disabled={saving} onClick={() => setStep("specialists")}><ArrowLeft />Back</Button>}
          <Button type="button" disabled={saving} onClick={() => void createTeam()}>{saving ? <><LoaderCircle className="spin" />Creating team…</> : saveError ? "Try again" : "Create team"}</Button>
        </div>
      </div>}
    </section>
  );
}
