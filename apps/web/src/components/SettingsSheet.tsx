import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, ChevronRight, Computer, CalendarClock, LoaderCircle, UserRound, Waypoints, Send, X } from 'lucide-react';
import { api, type CompanionDetail, type AppConfig } from '@/api';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { AvatarPicker, CompanionAvatar, DEFAULT_AVATAR } from './CompanionAvatar';
import { DeliverySettings } from './ProductPanels';

type Page = 'home' | 'identity' | 'connections' | 'delivery';
const titles: Record<Page, string> = {home:'Settings',identity:'Personality',connections:'Applications',delivery:'Client delivery'};


export function SettingsSheet({ detail, models, initialPage = "home", onClose, onSaved, onActivity, onDesktop, connections }: {
 initialPage?: Page; detail: CompanionDetail; models: AppConfig['models']; onClose:()=>void; onSaved:()=>Promise<void>;
 onActivity:()=>void; onDesktop:()=>void; connections: React.ReactNode;
}) {
 const [page,setPage]=useState<Page>(initialPage);
 const [name,setName]=useState(detail.companion.name);
 const [instructions,setInstructions]=useState(detail.companion.instructions);
 const [avatar,setAvatar]=useState(detail.companion.avatar??DEFAULT_AVATAR);
 const [modelId,setModelId]=useState(detail.companion.modelId??'');
 const [saving,setSaving]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null);
 useEffect(() => {
  const el = dialog.current!;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (el.showModal) el.showModal(); else el.setAttribute('open', '');
  return () => { if (el.close) el.close(); if (opener?.isConnected) opener.focus(); };
 }, []);
 useEffect(()=>{heading.current?.focus();},[page]);
 async function save(event:FormEvent){event.preventDefault();setSaving(true);setError('');setSaved(false);
  try{await api.updateCompanion(detail.companion.id,{name:name.trim(),instructions:instructions.trim(),avatar,modelId:modelId||null});await onSaved();setSaved(true);}
  catch(cause){setError(cause instanceof Error?cause.message:'Could not save changes.');}finally{setSaving(false);}}
 function row(target:Page,Icon:typeof UserRound,description:string){return <button type="button" className="settings-entry" onClick={()=>setPage(target)}><Icon/><span><strong>{titles[target]}</strong><small>{description}</small></span><ChevronRight/></button>;}
 return <dialog ref={dialog} className="maison-settings" aria-labelledby="settings-title" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
  <div className="settings-surface">
   <header className="sheet-header"><div className="settings-heading">{page!=='home'&&<Button variant="ghost" size="icon" aria-label="Back to settings" onClick={()=>setPage('home')}><ArrowLeft/></Button>}<h2 ref={heading} tabIndex={-1} id="settings-title">{page==='home'?`Make ${detail.companion.name} yours`:titles[page]}</h2></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close settings"><X/></Button></header>
   <div className="sheet-content maison-settings-content">
    {page==='home'&&<><button className="settings-profile" onClick={()=>setPage('identity')}><CompanionAvatar name={detail.companion.name} avatar={detail.companion.avatar} size={58}/><span><strong>{detail.companion.name}</strong><small>A companion, with your touch.</small></span><ChevronRight/></button><div className="settings-directory">{row('identity',UserRound,'Name, look and purpose')}{row('connections',Waypoints,'Choose the apps they can use')}{row('delivery',Send,'Prepare a companion for a client')}</div><div className="settings-utilities"><button onClick={onActivity}><CalendarClock/>Activity & history<ChevronRight/></button>{detail.companion.provider==='box'&&<button onClick={onDesktop}><Computer/>Open computer<ChevronRight/></button>}</div></>}
    {page==='identity'&&<form className="identity-form" onSubmit={save} onChange={()=>setSaved(false)}><AvatarPicker value={avatar} onChange={v=>{setAvatar(v);setSaved(false);}}/><div className="field"><label htmlFor="identity-name">Name</label><input id="identity-name" value={name} onChange={e=>setName(e.target.value)} maxLength={80}/></div><div className="field"><label htmlFor="identity-mission">Purpose</label><Textarea id="identity-mission" value={instructions} onChange={e=>setInstructions(e.target.value)} rows={5} maxLength={20000}/></div>{!!models?.length&&<details className="advanced-panel"><summary>Model preferences</summary><div className="field"><label htmlFor="identity-model">Model</label><select id="identity-model" value={modelId} onChange={e=>setModelId(e.target.value)}><option value="">Default model</option>{models.map(m=><option value={m.id} key={m.id}>{m.name}</option>)}</select></div></details>}{error&&<p className="field-error" role="alert">{error}</p>}<div className="sheet-actions"><span role="status">{saved?'Changes saved':''}</span><Button type="submit" disabled={saving||!name.trim()}>{saving?<LoaderCircle className="spin"/>:<Check/>}Save changes</Button></div></form>}
    {page==='connections'&&connections}
    {page==='delivery'&&<DeliverySettings companionId={detail.companion.id}/>}
   </div>
  </div>
 </dialog>;
}
