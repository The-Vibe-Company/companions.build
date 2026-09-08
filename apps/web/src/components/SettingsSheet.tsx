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
  const [appearanceOpen, setAppearanceOpen] = useState(false);
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
      {(!embedded || page !== 'identity' || pendingAction) && <header className="sheet-header">
        <div className="settings-heading">
          {(embedded ? page === 'delete' : page !== 'home') && !pendingAction && <Button variant="ghost" size="icon" aria-label="Back to settings" disabled={saving || deleting} onClick={() => goToPage(embedded ? 'identity' : 'home')}><ArrowLeft /></Button>}
          <h2 ref={heading} tabIndex={-1} id="settings-title">{pendingAction ? 'Keep your changes?' : page === 'home' ? `Make ${detail.companion.name} yours` : embedded && page === 'identity' ? 'Settings' : titles[page]}</h2>
        </div>
        {!embedded && !pendingAction && <Button variant="ghost" size="icon" disabled={saving || deleting} onClick={() => leave(onClose)} aria-label="Close settings"><X /></Button>}
      </header>}
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
                  <button type="button" className="settings-avatar-button" aria-label="Change appearance" aria-expanded={appearanceOpen} onClick={() => setAppearanceOpen(open => !open)}><CompanionAvatar name={name || detail.companion.name} avatar={avatar} size={78}/><span aria-hidden="true"><Pencil/></span></button>
                  <div className="settings-identity-controls">
                    <div className="field"><label htmlFor="identity-name">Name</label><input id="identity-name" value={name} onChange={event => setName(event.target.value)} maxLength={80}/></div>
                    <div className="field"><label htmlFor="identity-mission">Role</label><Textarea id="identity-mission" value={instructions} onChange={event => setInstructions(event.target.value)} rows={2} maxLength={20000}/></div>
                    <Button type="submit" className="settings-save" aria-label="Save changes" disabled={saving || !name.trim() || !dirty}>{saving && <LoaderCircle className="spin"/>}Save</Button>
                  </div>
                </div>
                {appearanceOpen && <div className="settings-appearance" aria-label="Appearance"><AvatarPicker value={avatar} onChange={value => { setAvatar(value); setSaved(false); }}/></div>}
              </fieldset>
              {error && <p className="field-error" role="alert">{error}</p>}
              <p className="settings-save-status" role="status">{saving ? 'Saving…' : saved ? 'Changes saved' : dirty ? 'Unsaved changes' : ''}</p>
            </form>
            {active && connections && <section className="settings-applications" aria-label="Applications"><h3>Apps &amp; accounts {name || detail.companion.name} can use</h3>{connections}</section>}
            <div className="settings-columns">
              <section className="settings-computer" aria-labelledby="settings-computer-title">
                <h3 id="settings-computer-title">Computer & model</h3>
                <div className="settings-computer-state"><div><strong>Own computer</strong><span>{detail.companion.provider === 'box' ? 'Box' : 'Local'} · {detail.companion.status === 'ready' ? 'ready' : detail.companion.status === 'archived' ? 'asleep' : detail.companion.status === 'preparing' ? 'preparing' : detail.companion.status === 'error' ? 'unavailable' : 'not started'}</span></div>{detail.companion.provider === 'box' && <Button type="button" variant="outline" size="sm" onClick={() => leave(onDesktop)}>Open desktop</Button>}</div>
                {!!models?.length && <div className="field"><label htmlFor="identity-model">Model</label><select id="identity-model" form="companion-identity-form" disabled={saving} value={modelId} onChange={event => { setModelId(event.target.value); setSaved(false); }}><option value="">Default model</option>{models.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}</select></div>}
              </section>
              <section className="settings-client" aria-labelledby="settings-client-title"><h3 id="settings-client-title">Share with a client</h3><p>Delivers a copy of {detail.companion.name} with its skills and specialists. Your conversation, files and accounts are never included.</p><DeliverySettings companionId={detail.companion.id} compact /></section>
            </div>
            <div className="settings-delete-row"><div><strong>Delete {detail.companion.name}</strong><span>Removes the conversation, files, automations and computer. Specialists are shared and stay.</span></div><Button type="button" variant="outline" disabled={saving || deleting} onClick={() => { setDeleteError(''); goToPage('delete'); }}>Delete…</Button></div>
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
