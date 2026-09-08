import {useState} from 'react';
import {Button} from './ui/button';
import {Textarea} from './ui/textarea';
export function Question({companionId,question,onAnswered}:{companionId:string;question:{id:string;question:string;options:string[];answer?:string|null;runStatus?:string};onAnswered:()=>Promise<void>}){
 const [answer,setAnswer]=useState('');const[busy,setBusy]=useState(false);const[error,setError]=useState('');
 async function send(value:string){
  if(!value.trim()||busy)return;setBusy(true);setError('');
  try{const r=await fetch(`/api/companions/${companionId}/questions/${question.id}/answer`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answer:value.trim()})});if(!r.ok)throw Error((await r.json()).error??'Could not send your answer.');await onAnswered();}
  catch(e){setError(e instanceof Error?e.message:'Could not send your answer.');}finally{setBusy(false);}
 }
 const resolved = question.answer != null;
 const closed = Boolean(question.runStatus && !['running','needs_input','preparing'].includes(question.runStatus));
 if(resolved || closed) return <section className="question-panel question-panel--answered" aria-label={resolved ? 'Answered question' : 'Closed question'}><strong>{resolved ? 'Answered' : 'Closed'}</strong><p>{question.question}</p>{resolved && <div className="question-answer"><span>Your answer</span><p>{question.answer}</p></div>}</section>;
 return <section className="question-panel" aria-label="Needs you"><strong>Needs you</strong><p>{question.question}</p>
  {!!question.options.length&&<div className="question-options">{question.options.map(option=><Button key={option} variant="outline" size="sm" disabled={busy} onClick={()=>void send(option)}>{option}</Button>)}</div>}
  <form onSubmit={e=>{e.preventDefault();void send(answer);}}><Textarea aria-label="Your answer" placeholder="Your answer…" value={answer} onChange={e=>setAnswer(e.target.value)} rows={2}/><Button size="sm" disabled={busy||!answer.trim()}>{busy?'Sending…':'Reply'}</Button></form>
  {error&&<p role="alert" className="field-error">{error}</p>}
 </section>;
}
