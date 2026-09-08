import { useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Code2, Search, ChartNoAxesCombined, LoaderCircle, RotateCw, X } from 'lucide-react';
import { workspaceApi, type SpecialistDraft } from '@/api';
import { CompanionAvatar, DEFAULT_AVATAR } from './CompanionAvatar';
import { Button } from './ui/button';
import './SpecialistCreation.css';
import { SpecialistPreparation } from './SpecialistPreparation';

const suggestionDetails = [
  { icon: Code2, detail: 'From an issue to a tested pull request', brief: 'Build a development specialist that picks up Linear issues, works in my GitHub repositories, and opens tested pull requests. Help me connect GitHub and Linear, then prepare the repositories and tools.' },
  { icon: Search, detail: 'Find sources. Turn them into a useful brief.', brief: 'Build a research specialist that investigates a topic, checks reliable sources, and writes a concise brief with links. Help me define the topics and the format of a good result.' },
  { icon: ChartNoAxesCombined, detail: 'Turn product questions into clear answers', brief: 'Build a product analyst that explores my data, explains what changed, and supports its conclusions with evidence. Help me choose the data sources and prepare the tools.' },
];
export const SPECIALIST_SUGGESTIONS = ['Develop with GitHub & Linear', 'Research a topic', 'Analyze product data'];

export function SpecialistCreation({ onCancel, onRefresh, onCreated }: { onCancel: () => void; onRefresh: () => Promise<void>; onCreated: (draft: SpecialistDraft) => void }) {
  const [created, setCreated] = useState<SpecialistDraft | null>(null);
  const [brief, setBrief] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || error || !brief.trim()) return;
    pending.current = true; setSaving(true);
    try {
      // Creation durably records the first onboarding message on the server.
      const result = await workspaceApi.createTemplateDraft({ name: 'New specialist', instructions: brief.trim(), avatar: DEFAULT_AVATAR });
      setCreated(result.draft);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create the draft.'); }
    finally { pending.current = false; setSaving(false); }
  }
  if (saving || created) return <SpecialistPreparation brief={brief} companionId={created?.companionId} onReady={() => { if (created) onCreated(created); }} onBack={created ? () => void onRefresh() : undefined} onOpenDraft={created ? () => onCreated(created) : undefined}/>;
  return <section className="specialist-creation" aria-label="Create a specialist">
    <header className="specialist-studio-header"><div><CompanionAvatar name="New specialist" size={28}/><strong>New specialist</strong><span className="specialist-studio-status">Draft</span></div><div><Button disabled>Publish</Button><Button variant="ghost" size="icon" onClick={onCancel} disabled={saving} aria-label="Close new specialist"><X/></Button></div></header>
    <div className="specialist-creation__body"><div className="specialist-creation__main">
      <div className="specialist-creation__welcome"><CompanionAvatar className="specialist-unformed" name="New specialist" size={80}/><h1>Who’s missing from your team?</h1><p>Describe the work. Your specialist will help you connect its apps, prepare its computer, and try a first mission.</p></div>
      <div className="specialist-creation__suggestions" aria-label="Ideas for your specialist">{SPECIALIST_SUGGESTIONS.map((suggestion, index) => { const item = suggestionDetails[index]; const Icon = item.icon; return <button key={suggestion} disabled={saving || Boolean(error)} onClick={() => { setBrief(item.brief); input.current?.focus(); }}><Icon aria-hidden="true"/><span><strong>{suggestion}</strong><small>{item.detail}</small></span></button>; })}</div>
      <form className="specialist-creation__composer" onSubmit={submit}>
        {error ? <div role="alert" className="specialist-creation__error"><strong>We couldn’t confirm whether this specialist was created.</strong><p>{error}</p><p>Refresh specialists before creating another to avoid a duplicate.</p><Button type="button" variant="outline" onClick={() => void onRefresh()}><RotateCw/>Refresh specialists</Button></div> : <><textarea ref={input} autoFocus aria-label="Specialist brief" placeholder="I need a specialist that…" value={brief} maxLength={20_000} rows={3} disabled={saving} onChange={event => setBrief(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/><div><span>{saving ? 'Creating your private draft…' : 'Nothing to configure upfront. Just start the conversation.'}</span><Button type="submit" aria-label="Create specialist" disabled={saving || !brief.trim()}>{saving ? <LoaderCircle className="spin"/> : <><span>Meet your specialist</span><ArrowUp/></>}</Button></div></>}
      </form>
    </div><aside className="specialist-studio-summary specialist-creation__summary" aria-label="Specialist summary"><CompanionAvatar className="specialist-unformed" name="New specialist" size={88}/><strong>New specialist</strong><p>A focused role, shaped together.</p><ul>{['Define its role', 'Prepare its environment', 'Try a mission'].map(label => <li key={label}><span className="specialist-check"/>{label}</li>)}</ul><p className="specialist-studio-summary__note">Prepare once. Your companions use a fresh copy for each mission.</p></aside></div>
  </section>;
}
