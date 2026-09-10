import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, LoaderCircle, Plus } from "lucide-react";
import {
  api,
  ApiError,
  workspaceApi,
  type AgentTemplate,
  type AppConfig,
  type Companion,
  type PluginAccount,
  type PluginServer,
} from "@/api";
import { AccountTiles } from "@/components/ApplicationAccess";
import {
  AVATAR_COLORS,
  CompanionAvatar,
  CompanionShape,
  randomizeAvatar,
  type CompanionAvatarValue,
} from "@/components/CompanionAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import "./CreateCompanion.css";
import { isProfileId, profiles, type ProfileId } from "../../../../packages/workbench/profiles";

type CreateCompanionProps = {
  config: AppConfig;
  onCreated: (companion: Companion) => void;
  compact?: boolean;
  ownerId?: string;
  onSetupLockedChange?: (locked: boolean) => void;
};

type FrozenCreation = Parameters<typeof api.createCompanion>[0];
type StoredCreation = {
  request: FrozenCreation;
  accountIds: string[];
  specialistIds: string[];
  completedAccountIds: string[];
  completedSpecialistIds: string[];
  createdCompanionId?: string;
  legacyPreparationRequested?: boolean;
};

function storageKey(ownerId: string) { return `companions.create.pending.${ownerId}`; }

function readStoredCreation(ownerId?: string): StoredCreation | null {
  if (!ownerId || typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(storageKey(ownerId)) ?? "null") as StoredCreation | null;
    if (!value?.request || typeof value.request.clientCreationId !== "string" || !Array.isArray(value.accountIds) || !Array.isArray(value.specialistIds)) return null;
    return value;
  } catch { return null; }
}

function failureMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export function CreateCompanion({ config, onCreated, compact = false, ownerId, onSetupLockedChange }: CreateCompanionProps) {
  const restored = useRef(readStoredCreation(ownerId));
  const appearanceId = useId();
  const [appearanceExpanded, setAppearanceExpanded] = useState(false);
  const firstProvider: "local" | "box" = config.defaultProvider ?? (config.localAvailable && !config.boxAvailable ? "local" : "box");
  const [name, setName] = useState(restored.current?.request.name ?? "");
  const savedProfileId = restored.current?.request.profileId;
  const unsupportedProfile = savedProfileId != null && !isProfileId(savedProfileId);
  const [profileId, setProfileId] = useState<ProfileId>(isProfileId(savedProfileId) ? savedProfileId : "default-v1");
  const [instructions, setInstructions] = useState(restored.current?.request.instructions ?? "");
  const [provider, setProvider] = useState<"local" | "box">(restored.current?.request.provider ?? firstProvider);
  const [avatar, setAvatar] = useState<CompanionAvatarValue>(() => restored.current?.request.avatar ?? randomizeAvatar());
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [accounts, setAccounts] = useState<PluginAccount[]>([]);
  const [catalog, setCatalog] = useState<PluginServer[]>([]);
  const [sourceTemplateId, setSourceTemplateId] = useState(restored.current?.request.templateId ?? "");
  const [accountIds, setAccountIds] = useState<Set<string>>(() => new Set(restored.current?.accountIds ?? []));
  const [specialistIds, setSpecialistIds] = useState<Set<string>>(() => new Set(restored.current?.specialistIds ?? []));
  const [loadingSetup, setLoadingSetup] = useState(true);
  const [setupError, setSetupError] = useState("");
  const [attempted, setAttempted] = useState(Boolean(restored.current));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [mayLeaveToResolve, setMayLeaveToResolve] = useState(false);
  const [createdId, setCreatedId] = useState(restored.current?.createdCompanionId ?? "");
  const creationId = useRef(restored.current?.request.clientCreationId ?? crypto.randomUUID());
  const frozenCreation = useRef<FrozenCreation | null>(restored.current?.request ?? null);
  const createdCompanion = useRef<Companion | null>(null);
  const legacyPreparationRequested = useRef(restored.current?.legacyPreparationRequested ?? false);
  const completedAccounts = useRef(new Set(restored.current?.completedAccountIds ?? []));
  const completedSpecialists = useRef(new Set(restored.current?.completedSpecialistIds ?? []));
  const submissionPending = useRef(false);
  const mounted = useRef(true);
  const setupLockCallback = useRef(onSetupLockedChange);
  setupLockCallback.current = onSetupLockedChange;

  function persistProgress(companionId = createdCompanion.current?.id) {
    if (!ownerId || !frozenCreation.current) return;
    const progress: StoredCreation = {
      request: frozenCreation.current,
      accountIds: [...accountIds],
      specialistIds: [...specialistIds],
      completedAccountIds: [...completedAccounts.current],
      completedSpecialistIds: [...completedSpecialists.current],
      legacyPreparationRequested: legacyPreparationRequested.current,
      ...(companionId ? { createdCompanionId: companionId } : {}),
    };
    try { window.sessionStorage.setItem(storageKey(ownerId), JSON.stringify(progress)); } catch { /* Storage is an optional recovery aid. */ }
  }

  function finishSetup(companion: Companion) {
    if (ownerId) {
      try { window.sessionStorage.removeItem(storageKey(ownerId)); } catch { /* Ignore unavailable storage. */ }
    }
    setAttempted(false);
    setupLockCallback.current?.(false);
    if (mounted.current) onCreated(companion);
  }

  const loadSetup = useCallback(async () => {
    setLoadingSetup(true);
    setSetupError("");
    try {
      const [templateResult, pluginResult] = await Promise.all([workspaceApi.templates(), workspaceApi.plugins()]);
      if (!mounted.current) return;
      setTemplates(templateResult.templates);
      setAccounts(pluginResult.accounts);
      setCatalog(pluginResult.catalog);
    } catch (cause) {
      if (mounted.current) setSetupError(failureMessage(cause, "Could not load setup choices."));
    } finally {
      if (mounted.current) setLoadingSetup(false);
    }
  }, []);

  useEffect(() => { void loadSetup(); }, [loadSetup]);
  useEffect(() => {
    mounted.current = true;
    if (restored.current) setupLockCallback.current?.(true);
    return () => { mounted.current = false; setupLockCallback.current?.(false); };
  }, []);
  useEffect(() => {
    if (!restored.current?.createdCompanionId) return;
    void api.getCompanion(restored.current.createdCompanionId).then(result => {
      if (!mounted.current) return;
      createdCompanion.current = result.companion;
      setCreatedId(result.companion.id);
    }).catch(() => { /* Retrying the frozen create safely recovers an uncertain response. */ });
  }, []);
  useEffect(() => {
    if (!attempted) return;
    const preventClose = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventClose);
    return () => window.removeEventListener("beforeunload", preventClose);
  }, [attempted]);

  const sourceTemplate = templates.find(template => template.id === sourceTemplateId);
  const selectionLocked = attempted || submitting;
  const selectedAccountIds = useMemo(() => accountIds, [accountIds]);

  function chooseSourceTemplate(id: string) {
    if (selectionLocked) return;
    setSourceTemplateId(id);
    const template = templates.find(item => item.id === id);
    if (!template) return;
    setName(template.name);
    setInstructions(template.instructions);
    setAvatar(template.avatar);
    if ((template.hasSnapshot || template.softwareBuildId || template.softwareResultId) && config.boxAvailable) setProvider("box");
  }

  function toggleAccount(id: string) {
    if (selectionLocked) return;
    setAccountIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSpecialist(id: string) {
    if (selectionLocked) return;
    setSpecialistIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (unsupportedProfile || !name.trim() || !instructions.trim() || loadingSetup || setupError || submissionPending.current) return;
    submissionPending.current = true;
    setAttempted(true);
    setupLockCallback.current?.(true);
    setSubmitting(true);
    setError("");
    setMayLeaveToResolve(false);
    if (!frozenCreation.current) {
      frozenCreation.current = {
        name: name.trim(),
        instructions: instructions.trim(),
        provider,
        avatar,
        prepare: true,
        clientCreationId: creationId.current,
        profileId,
        ...(sourceTemplate ? { templateId: sourceTemplate.id, templateRevision: sourceTemplate.revision } : {}),
      };
    }
    persistProgress();
    try {
      if (!createdCompanion.current) {
        const result = await api.createCompanion(frozenCreation.current);
        createdCompanion.current = result.companion;
        persistProgress(result.companion.id);
        if (!mounted.current) return;
        setCreatedId(result.companion.id);
      }
      const companion = createdCompanion.current;
      // Keep pre-upgrade requests identical for creation idempotency, then enqueue
      // their preparation through the existing durable lifecycle admission.
      if (frozenCreation.current?.prepare === false && !legacyPreparationRequested.current) {
        await workspaceApi.prepare(companion.id);
        legacyPreparationRequested.current = true;
        persistProgress(companion.id);
        if (!mounted.current) return;
      }
      for (const accountId of accountIds) {
        if (completedAccounts.current.has(accountId)) continue;
        await workspaceApi.selectPlugin(companion.id, accountId);
        completedAccounts.current.add(accountId);
        persistProgress(companion.id);
        if (!mounted.current) return;
      }
      for (const templateId of specialistIds) {
        if (completedSpecialists.current.has(templateId)) continue;
        await workspaceApi.setTemplatePermission(companion.id, templateId, 2);
        completedSpecialists.current.add(templateId);
        persistProgress(companion.id);
        if (!mounted.current) return;
      }
      finishSetup(companion);
    } catch (cause) {
      if (mounted.current) {
        setError(failureMessage(cause, "Could not finish creating this companion."));
        if (!createdCompanion.current && cause instanceof ApiError && [400, 401, 402, 403, 404, 409].includes(cause.status)) {
          setMayLeaveToResolve(true);
          setupLockCallback.current?.(false);
        }
      }
    } finally {
      submissionPending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  const canCreate = Boolean(!unsupportedProfile && name.trim() && instructions.trim() && !loadingSetup && !setupError && (config.localAvailable || config.boxAvailable));

  return <form className={cn("create-companion", compact && "create-companion--compact")} onSubmit={submit}>
    <section className="create-companion-preview" aria-label="Companion preview">
      <CompanionAvatar name={name.trim() || "Your companion"} avatar={avatar} size={200}/>
      <div className="create-companion-preview-copy">
        <h2>{name.trim() || "Your companion"}</h2>
        <p>{instructions.trim() || "What would you like them to take care of?"}</p>
      </div>
      <button className="create-appearance-toggle" type="button" aria-expanded={appearanceExpanded} aria-controls={appearanceId} onClick={() => setAppearanceExpanded(value => !value)}>Customize appearance<ChevronRight /></button>
      <div id={appearanceId} className={cn("create-appearance-controls", appearanceExpanded && "is-expanded")}>
      <fieldset disabled={selectionLocked} className="create-avatar-choice create-avatar-colors">
        <legend>Color</legend>
        <div>{[2, 4, 7, 5, 6, 9].map(index => <button key={index} type="button" aria-label={`Color ${index + 1}`} aria-pressed={avatar.color === index} onClick={() => setAvatar(current => ({ ...current, color: index }))}><span style={{ background: AVATAR_COLORS[index] }}/></button>)}</div>
      </fieldset>
      <fieldset disabled={selectionLocked} className="create-avatar-choice create-avatar-icons">
        <legend>Shape</legend>
        <div>{Array.from({ length: 8 }, (_, shape) => <button key={shape} type="button" aria-label={`Shape ${shape + 1}`} aria-pressed={avatar.shape === shape} onClick={() => setAvatar(current => ({ ...current, shape }))}><CompanionShape shape={shape}/></button>)}</div>
      </fieldset>
      <details className="create-face-options"><summary>More colors &amp; expressions</summary><fieldset disabled={selectionLocked} className="create-avatar-choice create-avatar-colors"><legend>More colors</legend><div>{[0, 1, 3, 8, 10].map(index => <button key={index} type="button" aria-label={`Color ${index + 1}`} aria-pressed={avatar.color === index} onClick={() => setAvatar(current => ({ ...current, color: index }))}><span style={{ background: AVATAR_COLORS[index] }}/></button>)}</div></fieldset><fieldset disabled={selectionLocked} className="create-avatar-choice create-avatar-icons">
        <legend>Face</legend>
        <div>{Array.from({ length: 5 }, (_, face) => <button key={face} type="button" aria-label={`Face ${face + 1}`} aria-pressed={avatar.face === face} onClick={() => setAvatar(current => ({ ...current, face }))}><CompanionAvatar name={`Face ${face + 1}`} avatar={{ ...avatar, face }} size={32}/></button>)}</div>
      </fieldset></details>
      </div>
    </section>

    <section className="create-companion-fields">
      <header><h1>{compact ? "New companion" : "Create your first Companion"}</h1></header>
      <div className="field create-profile-field">
        <label htmlFor="create-companion-profile">Companion type</label>
        <select id="create-companion-profile" value={unsupportedProfile ? "unavailable" : profileId} disabled={selectionLocked} onChange={event => setProfileId(event.target.value as ProfileId)} aria-describedby="create-profile-help">
          {unsupportedProfile && <option value="unavailable">Unavailable Companion type</option>}
          {Object.values(profiles).filter(profile => profile.selectable !== false || (selectionLocked && profile.id === profileId)).map(profile => <option key={profile.id} value={profile.id}>{profile.title}</option>)}
        </select>
        <p id="create-profile-help" role={unsupportedProfile ? "alert" : undefined}>{unsupportedProfile ? "This saved creation uses a type unavailable in this app version. Its original request is kept; reopen it with a compatible version to continue." : `${profiles[profileId].description} The type is fixed after creation.`}</p>
      </div>
      <div className="create-companion-basics">
        <div className="field"><label htmlFor="create-companion-name">Name</label><input id="create-companion-name" value={name} maxLength={80} disabled={selectionLocked} onChange={event => setName(event.target.value)} placeholder="Ada" autoFocus={!compact}/></div>
        <div className="field"><label htmlFor="create-companion-purpose">Role</label><Textarea id="create-companion-purpose" value={instructions} maxLength={20_000} disabled={selectionLocked} onChange={event => setInstructions(event.target.value)} placeholder="Research customer questions and turn the findings into clear briefs." rows={1}/></div>
      </div>

      {loadingSetup ? <div className="create-setup-state" role="status"><LoaderCircle className="spin"/>Loading accounts and specialists…</div> : setupError ? <div className="create-setup-state create-setup-error" role="alert"><p>{setupError}</p><Button type="button" variant="outline" onClick={() => void loadSetup()}>Try again</Button></div> : <>
        <section className="create-option-section"><div className="create-section-heading"><h2>Apps &amp; accounts</h2><span>{accountIds.size} selected</span></div>
          {accounts.length ? <AccountTiles accounts={accounts} catalog={catalog} selectedIds={selectedAccountIds} disabled={selectionLocked} onToggle={toggleAccount}/> : <p className="create-empty-option">Connected accounts will appear here when they are available.</p>}
        </section>
        <section className="create-option-section"><div className="create-section-heading"><h2>Team</h2><span>{specialistIds.size} selected</span></div>
          {templates.length ? <div className="create-specialist-list">{templates.map(template => {
            const selected = specialistIds.has(template.id);
            return <label key={template.id} className={cn("create-specialist", selected && "create-specialist--selected")}><input type="checkbox" checked={selected} disabled={selectionLocked} onChange={() => toggleSpecialist(template.id)}/><CompanionAvatar name={template.name} avatar={template.avatar} size={32}/><span>{template.name}<small>v{template.revision}</small></span>{selected && <Check aria-hidden="true"/>}</label>;
          })}</div> : <p className="create-empty-option">Create a specialist profile to add a team here.</p>}
        </section>
      </>}

      <div className="create-companion-footer">
      <Button className="create-companion-submit" type="submit" aria-label={attempted ? "Resume setup" : "Create companion"} disabled={!canCreate || submitting}>
        {submitting ? <LoaderCircle className="spin"/> : attempted ? <><Plus/>Resume setup</> : <>Create {name.trim() || "companion"}</>}
      </Button>
      {templates.length > 0 && <details className="create-companion-advanced"><summary>Starting profile<ChevronRight/></summary>
        {templates.length > 0 && <div className="field"><label htmlFor="create-source-template">Start from</label><select id="create-source-template" value={sourceTemplateId} disabled={selectionLocked} onChange={event => chooseSourceTemplate(event.target.value)}><option value="">Blank companion</option>{templates.map(template => { const needsBox = Boolean(template.hasSnapshot || template.softwareBuildId || template.softwareResultId); return <option key={template.id} value={template.id} disabled={needsBox && !config.boxAvailable}>{template.name} · v{template.revision}{needsBox && !config.boxAvailable ? " · cloud unavailable" : ""}</option>; })}</select><span className="field-hint">Pins this companion to the profile version shown. Team access is selected separately above.</span></div>}

      </details>}</div>
      {attempted && !submitting && error && <p className="create-lock-note">Setup is locked so retrying cannot create a different companion.</p>}
      {mayLeaveToResolve && <p className="create-lock-note">You can leave this page to resolve the account issue, then return to resume this exact setup.</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {createdId && error && <Button type="button" variant="outline" onClick={() => createdCompanion.current && finishSetup(createdCompanion.current)}>Open companion and finish later</Button>}

    </section>
  </form>;
}
