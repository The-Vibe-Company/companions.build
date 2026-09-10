import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/api';
import { Button } from './ui/button';
import type { MemoryRecord } from '../../../../packages/agent/src/memory-protocol';
import './MemoryPanel.css';

export function MemoryPanel({ companionId }: { companionId: string }) {
  const [opened,setOpened]=useState(false);
  const [records,setRecords]=useState<MemoryRecord[]>([]);
  const [cursor,setCursor]=useState<string>();
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [pending,setPending]=useState<string>();
  const epoch=useRef(0);
  useEffect(()=>{epoch.current++;setOpened(false);setRecords([]);setCursor(undefined);setError('');setNotice('');setPending(undefined);setLoading(false);return()=>{epoch.current++;};},[companionId]);
  async function load(after?:string) {
    const current=epoch.current;setLoading(true);setError('');
    try {
      const page=await api.getMemory(companionId,after);
      if(current!==epoch.current)return;
      setRecords(previous=>after?[...previous,...page.memories]:page.memories);setCursor(page.nextCursor);
    } catch(cause){if(current===epoch.current)setError(cause instanceof Error?cause.message:'Could not load memory.');}
    finally{if(current===epoch.current)setLoading(false);}
  }
  async function change(record:MemoryRecord,action:'approve'|'retire'|'adopt-legacy') {
    if(pending)return;
    const current=epoch.current,operationId=crypto.randomUUID();setPending(operationId);setError('');setNotice('Submitting memory request…');
    try {
      if(action==='adopt-legacy')await api.adoptLegacyMemory(companionId,operationId);
      else await api.changeMemory(companionId,action,{operationId,id:record.id,expectedVersion:record.version});
      if(current===epoch.current)setNotice('Request saved. Waiting for the Companion to apply it.');
    } catch(cause){if(current===epoch.current){setError(cause instanceof Error?cause.message:'Request status is unknown.');if(cause instanceof ApiError && cause.status>=400 && cause.status<500){setPending(undefined);setNotice('');}else setNotice('Checking the saved request before any retry.');}}
  }
  useEffect(()=>{
    if(!pending)return;
    let cancelled=false;
    const poll=async()=>{
      try {
        const result=await api.memoryCommand(companionId,pending);
        if(cancelled||!result.command.settledAt)return;
        setPending(undefined);
        if(result.command.response?.status==='ok'){setNotice('Memory updated.');void load();}
        else{setNotice('');setError('Memory changed or the request could not be applied. Refresh and review its current version.');}
      } catch {if(!cancelled)setNotice('Request status is unavailable. It may still be pending; refresh before submitting another change.');}
    };
    const timer=setInterval(()=>void poll(),2000);void poll();return()=>{cancelled=true;clearInterval(timer);};
  },[pending,companionId]);
  return <section className="memory-panel" aria-labelledby="memory-title">
    <h3 id="memory-title">Memory</h3>
    <p>See what your Companion remembers, where it came from, and what needs your approval. Memories are leads to verify at their source.</p>
    <Button variant="outline" disabled={loading} aria-expanded={opened} onClick={()=>{setOpened(true);void load();}}>{opened?'Refresh memory':'Inspect memory'}</Button>
    {loading&&<p role="status">Reading memory…</p>}
    {error&&<p role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {opened&&!loading&&!error&&records.length===0&&<p>No memory records yet. Useful context appears here when saved.</p>}
    {opened&&records.map(record=><article key={record.id} className="memory-record" aria-label={`Memory ${record.id}`}>
      <div className="memory-record-status"><strong>{record.status==='active'&&record.approval==='pending'?'Proposed':record.status}</strong><span>{record.scope} · {record.kind} · version {record.version}</span></div>
      <p>{record.content}</p>
      <dl>
        <dt>Source</dt><dd>{record.source?.type??'legacy'}: {record.source?.ref??record.provenance}</dd>
        <dt>Why it was saved</dt><dd>{record.provenance}</dd>
        <dt>Asserted</dt><dd>{record.assertedAt??record.createdAt}</dd>
        {record.reviewAfter&&<><dt>Review after</dt><dd>{record.reviewAfter}</dd></>}
        {record.expiresAt&&<><dt>Expires</dt><dd>{record.expiresAt}{Date.parse(record.expiresAt)<=Date.now()?' (expired)':''}</dd></>}
        {record.verification&&<><dt>Source check</dt><dd>{record.verification}</dd></>}
        {!!record.supersedes?.length&&<><dt>Supersedes</dt><dd>{record.supersedes.join(', ')}</dd></>}
        {!!record.supersededBy?.length&&<><dt>Superseded by</dt><dd>{record.supersededBy.join(', ')}</dd></>}
        {record.mission&&<><dt>Tracked work</dt><dd>{record.mission.ticket} · {record.mission.workspace}{record.mission.pr&&` · ${record.mission.pr}`}</dd></>}
      </dl>
      {record.status==='active'&&<div className="memory-record-actions">
        {record.approval==='pending'&&<Button disabled={!!pending} onClick={()=>void change(record,'approve')}>Approve memory</Button>}
        {record.id==='legacy-shared-memory'&&record.source?.ref.startsWith('legacy:')
          ? <Button variant="outline" disabled={!!pending} onClick={()=>void change(record,'adopt-legacy')}>Add lifecycle metadata</Button>
          : <Button variant="outline" disabled={!!pending} onClick={()=>void change(record,'retire')}>Retire memory</Button>}
      </div>}
      {record.id==='legacy-shared-memory'&&<p>Legacy file: adding lifecycle metadata preserves its content and enables retirement. Versioned replacements require approval through the memory API.</p>}
    </article>)}
    {opened&&cursor&&<Button variant="outline" disabled={loading} onClick={()=>void load(cursor)}>Load more memories</Button>}
  </section>;
}
