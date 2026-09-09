import {useEffect,useState} from 'react';
import {Button} from './ui/button';
import {Textarea} from './ui/textarea';
export function Question({companionId,question,onAnswered}:{companionId:string;question:{id:string;question:string;options:string[];answer?:string|null;runStatus?:string};onAnswered:()=>Promise<void>}){
 const draftKey=`companions.build:question-draft:${companionId}:${question.id}`;
 const [answer,setAnswer]=useState(()=>{try{return sessionStorage.getItem(draftKey)??'';}catch{return '';}});const[busy,setBusy]=useState(false);const[error,setError]=useState('');
 useEffect(()=>{try{if(answer)sessionStorage.setItem(draftKey,answer);else sessionStorage.removeItem(draftKey);}catch{/* The in-memory draft remains available while mounted. */}},[answer,draftKey]);
 async function send(value:string){
  if(!value.trim()||busy)return;setBusy(true);setError('');
  try{const r=await fetch(`/api/companions/${companionId}/questions/${question.id}/answer`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answer:value.trim()})});if(!r.ok)throw Error((await r.json()).error??'Could not send your answer.');try{sessionStorage.removeItem(draftKey);}catch{}setAnswer('');await onAnswered();}
  catch(e){setError(e instanceof Error?e.message:'Could not send your answer.');}finally{setBusy(false);}
 }
 const resolved = question.answer != null;
 const closed = Boolean(question.runStatus && !['running','needs_input','preparing'].includes(question.runStatus));
 if(resolved || closed) return <section className="question-panel question-panel--answered" aria-label={resolved ? 'Answered question' : 'Closed question'}><strong>{resolved ? 'Answered' : 'Closed'}</strong><p>{question.question}</p>{!resolved && <p>This question is no longer waiting for an answer.</p>}{resolved && <div className="question-answer"><span>Your answer</span><p>{question.answer}</p></div>}</section>;
 return <section className="question-panel" aria-label="Waiting for your answer" aria-busy={busy}><strong>Waiting for your answer</strong><p>{question.question}</p>
  {!!question.options.length&&<div className="question-options">{question.options.map(option=><Button key={option} variant="outline" size="sm" disabled={busy} onClick={()=>void send(option)}>{option}</Button>)}</div>}
  <form onSubmit={e=>{e.preventDefault();void send(answer);}}><Textarea aria-label="Your answer" disabled={busy} placeholder={question.options.length ? "Or write your own answer…" : "Your answer…"} value={answer} onChange={e=>setAnswer(e.target.value)} rows={2}/><Button size="sm" disabled={busy||!answer.trim()}>{busy?'Sending…':'Reply'}</Button></form>
  {error&&<p role="alert" className="field-error">{error}</p>}
 </section>;
}
