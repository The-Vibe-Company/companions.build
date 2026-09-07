import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight, Computer, CalendarClock, LoaderCircle, Pencil, UserRound, Waypoints, Send, Trash2, X } from 'lucide-react';
import { api, type CompanionDetail, type AppConfig } from '@/api';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { AvatarPicker, CompanionAvatar, DEFAULT_AVATAR } from './CompanionAvatar';
import { DeliverySettings } from './ProductPanels';
import './SettingsSheet.css';

type Page = 'home' | 'identity' | 'connections' | 'delivery' | 'delete' | 'activity' | 'computer';
const titles: Record<Page, string> = {
  home: 'Settings', identity: 'Personality', connections: 'Applications', delivery: 'Client delivery', delete: 'Delete companion', activity: 'Activity', computer: 'Computer',
};

type Props = {
  embedded?: boolean;
  active?: boolean;
  activity?: ReactNode;
  computer?: ReactNode;
  initialPage?: Page;
  onPageChange?: (page: Page) => void;
  detail: CompanionDetail;
  models: AppConfig['models'];
  onClose: () => void;
  onDeleted: (ids: string[]) => void;
  onSaved: () => Promise<void>;
  onActivity: () => void;
  onDesktop: () => void;
  connections: ReactNode;
};

export type SettingsSheetHandle = { requestLeave: (action: () => void) => boolean };

export const SettingsSheet = forwardRef<SettingsSheetHandle, Props>(function SettingsSheet({ embedded = false, active = true, activity, computer, detail, models, initialPage = 'home', onPageChange, onClose, onDeleted, onSaved, onActivity, onDesktop, connections }, ref) {
  const [deliveryExpanded, setDeliveryExpanded] = useState(false);
  const appearance = useRef<HTMLDetailsElement>(null);
  const [page, setPage] = useState<Page>(embedded && initialPage === 'home' ? 'identity' : initialPage);
  const [name, setName] = useState(detail.companion.name);
  const [instructions, setInstructions] = useState(detail.companion.instructions);
  const [avatar, setAvatar] = useState(detail.companion.avatar ?? DEFAULT_AVATAR);
  const [modelId, setModelId] = useState(detail.companion.modelId ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const keepCompanion = useRef<HTMLButtonElement>(null);
  const deletingRef = useRef(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [baseline, setBaseline] = useState(() => ({ name, instructions, avatar, modelId }));
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const dirty = name !== baseline.name || instructions !== baseline.instructions || JSON.stringify(avatar) !== JSON.stringify(baseline.avatar) || modelId !== baseline.modelId;
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (embedded) return;
    const el = dialog.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (el.showModal) el.showModal(); else el.setAttribute('open', '');
    return () => { if (el.close) el.close(); if (opener?.isConnected) opener.focus(); };
  }, [embedded]);
  useEffect(() => { if (embedded) setPage(initialPage === 'home' ? 'identity' : initialPage); }, [embedded, initialPage]);
  useEffect(() => { if (!active) return; if (page === 'delete' && !pendingAction) keepCompanion.current?.focus(); else heading.current?.focus(); }, [page, pendingAction, active]);
  useEffect(() => {
    const next = { name: detail.companion.name, instructions: detail.companion.instructions, avatar: detail.companion.avatar ?? DEFAULT_AVATAR, modelId: detail.companion.modelId ?? '' };
    setName(current => current === baseline.name ? next.name : current);
    setInstructions(current => current === baseline.instructions ? next.instructions : current);
    setAvatar(current => JSON.stringify(current) === JSON.stringify(baseline.avatar) ? next.avatar : current);
    setModelId(current => current === baseline.modelId ? next.modelId : current);
    setBaseline(next);
  }, [detail.companion.name, detail.companion.instructions, detail.companion.avatar, detail.companion.modelId]);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [dirty]);

  function goToPage(next: Page) {
    setPage(next);
    onPageChange?.(next);
  }

  function leave(action: () => void) {
    if (saving || deletingRef.current) return;
    if (dirty) setPendingAction(() => action); else action();
  }

  useImperativeHandle(ref, () => ({
    requestLeave(action) {
      if (saving || deletingRef.current) return true;
      if (dirty) { setPendingAction(() => action); return true; }
      action(); return false;
    },
  }), [dirty, saving]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true); setError(''); setSaved(false);
    const nameChanged = name !== baseline.name;
    const instructionsChanged = instructions !== baseline.instructions;
    const avatarChanged = JSON.stringify(avatar) !== JSON.stringify(baseline.avatar);
    const modelChanged = modelId !== baseline.modelId;
    const changes = {
      ...(nameChanged ? { name: name.trim() } : {}),
      ...(instructionsChanged ? { instructions: instructions.trim() } : {}),
      ...(avatarChanged ? { avatar } : {}),
      ...(modelChanged ? { modelId: modelId || null } : {}),
    };
    try {
      const result = await api.updateCompanion(detail.companion.id, changes);
      const saved = { name: result.companion.name, instructions: result.companion.instructions, avatar: result.companion.avatar ?? DEFAULT_AVATAR, modelId: result.companion.modelId ?? '' };
      setName(saved.name); setInstructions(saved.instructions); setAvatar(saved.avatar); setModelId(saved.modelId);
      setBaseline(saved);
      setSaved(true);
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save changes.');
    } finally { setSaving(false); }
  }

  async function deleteCompanion() {
    if (deletingRef.current) return;
    deletingRef.current = true; setDeleting(true); setDeleteError('');
    try {
      const result = await api.deleteCompanion(detail.companion.id);
      onDeleted(result.companionIds ?? [detail.companion.id]);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : 'Could not delete this companion. Try again.');
    } finally { deletingRef.current = false; setDeleting(false); }
  }

  function row(target: Page, Icon: typeof UserRound, description: string) {
    return <button type="button" className="settings-entry" onClick={() => goToPage(target)}>
      <Icon /><span><strong>{titles[target]}</strong><small>{description}</small></span><ChevronRight />
    </button>;
  }

  const surface = <div className="settings-surface">
      <header className="sheet-header">
        <div className="settings-heading">
          {(embedded ? page === 'delete' : page !== 'home') && !pendingAction && <Button variant="ghost" size="icon" aria-label="Back to settings" disabled={saving || deleting} onClick={() => goToPage(embedded ? 'identity' : 'home')}><ArrowLeft /></Button>}
          <h2 ref={heading} tabIndex={-1} id="settings-title">{pendingAction ? 'Keep your changes?' : page === 'home' ? `Make ${detail.companion.name} yours` : embedded && page === 'identity' ? 'Settings' : titles[page]}</h2>
        </div>
        {!embedded && !pendingAction && <Button variant="ghost" size="icon" disabled={saving || deleting} onClick={() => leave(onClose)} aria-label="Close settings"><X /></Button>}
      </header>
      <div className="sheet-content maison-settings-content">
        {pendingAction ? <div className="settings-unsaved">
          <CompanionAvatar name={name || detail.companion.name} avatar={avatar} size={64} />
          <p>Your personality changes haven’t been saved yet.</p>
          <div><Button onClick={() => { setPendingAction(null); goToPage('identity'); }}>Keep editing</Button><Button variant="ghost" onClick={() => { const action = pendingAction; setPendingAction(null); action(); }}>Discard changes</Button></div>
        </div> : <>
          {page === 'home' && <>
            <button className="settings-profile" onClick={() => goToPage('identity')}>
              <CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={58} />
              <span><strong>{detail.companion.name}</strong><small>{dirty ? 'Personality changes not saved' : 'A companion, with your touch.'}</small></span><ChevronRight />
            </button>
            <div className="settings-directory">
              {row('identity', UserRound, 'Name, look and purpose')}
              {row('connections', Waypoints, 'Choose the apps they can use')}
              {row('delivery', Send, 'Prepare a companion for a client')}
            </div>
            <div className="settings-utilities">
              <button onClick={() => leave(onActivity)}><CalendarClock />Activity & history<ChevronRight /></button>
              {detail.companion.provider === 'box' && <button onClick={() => leave(onDesktop)}><Computer />Open computer<ChevronRight /></button>}
            </div>
            <button type="button" className="settings-delete-entry" disabled={saving || deleting} onClick={() => { setDeleteError(''); goToPage('delete'); }}><Trash2 />Delete companion</button>
          </>}
          {page === 'delete' && <div className="settings-delete-confirm">
            <CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={64} />
            <h3>Delete {detail.companion.name}?</h3>
            <p>This removes this companion and its temporary specialists from your companions. Their routines and triggers will stop, and their computers will shut down in the background.</p>
            <p className="muted-copy">Saved specialist profiles and connected accounts are kept. You cannot undo this from the app.</p>
            {deleteError && <p className="field-error" role="alert">{deleteError}</p>}
            <div><Button ref={keepCompanion} variant="outline" disabled={deleting} onClick={() => goToPage(embedded ? 'identity' : 'home')}>Keep companion</Button><Button variant="destructive" disabled={deleting} onClick={() => void deleteCompanion()}>{deleting && <LoaderCircle className="spin" />}{deleting ? 'Deleting…' : 'Delete companion'}</Button></div>
          </div>}
          {page === 'identity' && <>
            <form id="companion-identity-form" className="identity-form" onSubmit={save} onChange={() => setSaved(false)}>
              <fieldset className="identity-fields" disabled={saving}>
                <div className="settings-identity-row">
                  <button type="button" className="settings-avatar-button" aria-label="Change appearance" onClick={() => { if (appearance.current) { appearance.current.open = true; appearance.current.querySelector('summary')?.focus(); } }}><CompanionAvatar name={name || detail.companion.name} avatar={avatar} size={78}/><span aria-hidden="true"><Pencil/></span></button>
                  <div className="field"><label htmlFor="identity-name">Name</label><input id="identity-name" value={name} onChange={event => setName(event.target.value)} maxLength={80}/></div>
                  <div className="field"><label htmlFor="identity-mission">Purpose</label><Textarea id="identity-mission" value={instructions} onChange={event => setInstructions(event.target.value)} rows={2} maxLength={20000}/></div>
                  <Button type="submit" className="settings-save" aria-label="Save changes" disabled={saving || !name.trim() || !dirty}>{saving && <LoaderCircle className="spin"/>}Save</Button>
                </div>
                <details ref={appearance} className="settings-appearance"><summary><span>Appearance</span><ChevronRight/></summary><AvatarPicker value={avatar} onChange={value => { setAvatar(value); setSaved(false); }}/></details>
              </fieldset>
              {error && <p className="field-error" role="alert">{error}</p>}
              <p className="settings-save-status" role="status">{saving ? 'Saving…' : saved ? 'Changes saved' : dirty ? 'Unsaved changes' : ''}</p>
            </form>
            {active && connections && <section className="settings-applications" aria-label="Applications"><h3>Apps & accounts</h3>{connections}</section>}
            <div className="settings-columns">
              <section className="settings-computer" aria-labelledby="settings-computer-title">
                <h3 id="settings-computer-title">Computer & model</h3>
                <div className="settings-computer-state"><Computer/><span>{detail.companion.status === 'ready' ? 'Ready' : detail.companion.status === 'archived' ? 'Sleeping' : detail.companion.status === 'preparing' ? 'Preparing…' : detail.companion.status === 'error' ? 'Unavailable' : 'Not started'}</span>{detail.companion.provider === 'box' && <button type="button" onClick={() => leave(onDesktop)}>Open computer<ChevronRight/></button>}</div>
                {!!models?.length && <div className="field"><label htmlFor="identity-model">Model</label><select id="identity-model" form="companion-identity-form" disabled={saving} value={modelId} onChange={event => { setModelId(event.target.value); setSaved(false); }}><option value="">Default model</option>{models.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}</select></div>}
              </section>
              <section className="settings-client" aria-labelledby="settings-client-title"><h3 id="settings-client-title">Client delivery</h3><p>Send an independent copy to a client.</p><details className="settings-delivery" onToggle={event => setDeliveryExpanded(event.currentTarget.open)}><summary><span>Prepare delivery</span><ChevronRight/></summary>{deliveryExpanded && <DeliverySettings companionId={detail.companion.id}/>}</details></section>
            </div>
            <button type="button" className="settings-delete-entry" disabled={saving || deleting} onClick={() => { setDeleteError(''); goToPage('delete'); }}><Trash2/>Delete companion</button>
          </>}
          {page === 'activity' && activity}
          {active && page === 'computer' && computer}
          {page === 'connections' && connections}
          {page === 'delivery' && <DeliverySettings companionId={detail.companion.id} />}
        </>}
      </div>
    </div>;
  if (embedded) return <section className={`settings-page${page === 'computer' ? ' settings-page-computer' : ''}`} aria-label="Companion settings">{surface}</section>;
  return <dialog ref={dialog} className="maison-settings" aria-labelledby="settings-title"
    onCancel={event => { event.preventDefault(); if (deletingRef.current) return; if (page === 'delete' && !pendingAction) { goToPage('home'); return; } if (pendingAction) { setPendingAction(null); goToPage('identity'); } else leave(onClose); }}
    onClick={event => { if (event.target === event.currentTarget && !pendingAction) leave(onClose); }}>
{surface}</dialog>;
});
