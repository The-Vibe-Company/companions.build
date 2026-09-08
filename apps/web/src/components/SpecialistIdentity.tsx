import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Check,LoaderCircle,X} from 'lucide-react';
import {workspaceApi,type SpecialistDraft} from '@/api';
import {AvatarPicker,DEFAULT_AVATAR} from './CompanionAvatar';
import {Button} from './ui/button';

export function SpecialistIdentity({draft,onSaved,onClose}:{draft:SpecialistDraft;onSaved:(draft:SpecialistDraft)=>void;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 const [name,setName]=useState(draft.name);
 const [avatar,setAvatar]=useState(draft.avatar??DEFAULT_AVATAR);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 useEffect(()=>{const el=dialog.current;if(el?.showModal)el.showModal();else el?.setAttribute('open','');},[]);
 async function save(event:FormEvent){
  event.preventDefault();if(busy||!name.trim())return;
  setBusy(true);setError('');
  try{const result=await workspaceApi.updateTemplateDraft(draft.templateId,{expectedGeneration:draft.generation,expectedIdentityRevision:draft.identityRevision??1,name:name.trim(),avatar});onSaved(result.draft);onClose();}
  catch(cause){setError(cause instanceof Error?cause.message:'Could not save this profile.');}finally{setBusy(false);}
 }
 return <dialog ref={dialog} className="specialist-identity" aria-labelledby="specialist-identity-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
  <header><h2 id="specialist-identity-title">Name &amp; appearance</h2><Button variant="ghost" size="icon" aria-label="Close profile editor" disabled={busy} onClick={onClose}><X/></Button></header>
  <form onSubmit={save}><p>Name and appearance apply immediately. No publication needed.</p><label htmlFor="specialist-identity-name">Name</label><input id="specialist-identity-name" autoFocus value={name} maxLength={80} disabled={busy} onChange={event=>setName(event.target.value)}/><fieldset disabled={busy}><legend>Make it yours</legend><AvatarPicker value={avatar} onChange={setAvatar}/></fieldset>{error&&<p role="alert">{error}</p>}<footer><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy||!name.trim()}>{busy?<LoaderCircle className="spin"/>:<Check/>}{busy?'Saving…':'Save profile'}</Button></footer></form>
 </dialog>;
}
