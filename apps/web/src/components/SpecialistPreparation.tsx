import { useEffect, useRef, useState } from 'react';
import { CircleAlert, RotateCw } from 'lucide-react';
import { api, type Companion } from '@/api';
import { CompanionAvatar } from './CompanionAvatar';
import { Button } from './ui/button';
import './SpecialistCreation.css';

export function SpecialistPreparation({ brief, companionId, onReady, onBack, onOpenDraft }: { brief?: string; companionId?: string; onReady: () => void; onBack?: () => void; onOpenDraft?: () => void }) {
  const [companion, setCompanion] = useState<Companion | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    if (!companionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setError('');
    const observe = async () => {
      try {
        const detail = await api.getCompanion(companionId);
        if (cancelled) return;
        setCompanion(detail.companion);
        if (detail.companion.status === 'ready') { ready.current(); return; }
        if (detail.companion.status === 'error' || detail.companion.retiredAt) return;
        timer = setTimeout(observe, 1_500);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not check the environment.');
      }
    };
    void observe();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [companionId, attempt]);
  const failed = companion?.status === 'error' || Boolean(companion?.retiredAt);
  const title = error ? 'Couldn’t check its environment' : failed ? 'Its environment needs attention' : !companionId ? 'Creating your specialist' : companion?.status === 'new' ? 'Waiting for an available machine' : 'Preparing its environment';
  return <section className="specialist-preparation" aria-label="Preparing specialist">
    <div className={`specialist-preparation__character${failed || error ? ' is-paused' : ''}`}><CompanionAvatar name={companion?.name ?? 'New specialist'} avatar={companion?.avatar} size={104}/></div>
    <h1>{title}</h1>
    {brief && <blockquote className="specialist-preparation__brief">{brief}</blockquote>}
    {error || failed ? <p role="alert"><CircleAlert/>{error || companion?.error || 'Open the draft to inspect its status.'}</p> : <p role="status">{!companionId ? 'Saving your brief and setting up a private draft.' : 'Your specialist is getting its own computer. The chat will open when it’s ready.'}</p>}
    {(error || failed) && <Button variant="outline" onClick={() => setAttempt(value => value + 1)}><RotateCw/>Check status</Button>}
    <div className="specialist-preparation__actions">{onBack && <Button variant="ghost" onClick={onBack}>Back to specialists</Button>}{(error || failed) && onOpenDraft && <Button variant="outline" onClick={onOpenDraft}>Open draft</Button>}</div>
    {companionId && <small>Your draft is saved. You can come back later.</small>}
  </section>;
}
