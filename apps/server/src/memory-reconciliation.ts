import { db } from './store';
import { decrypt } from './config';
import { memoryAgentRequest, queueMemoryObservation, memoryCommandReceipt, restoreMemoryRequest } from './memory';
import type { MemoryRecord } from '../../../packages/agent/src/memory-protocol';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const github=/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/([1-9][0-9]*)\/?$/;

type Dependencies={database?:any;request?:typeof memoryAgentRequest;fetchImpl?:typeof fetch;assertActive?:()=>Promise<void>;signal?:AbortSignal};

async function credential(database:any,companion:any,provider:string) {
  const accounts=await database`SELECT a.credential_secret FROM plugin_accounts a JOIN companion_plugins p ON p.account_id=a.id
    WHERE p.companion_id=${companion.id} AND a.owner_id=${companion.owner_id} AND a.provider=${provider} LIMIT 2`;
  if(accounts.length!==1)return null;
  try {
    const value=JSON.parse(decrypt(accounts[0].credential_secret));
    if(value.kind!=='oauth'||typeof value.accessToken!=='string'||!value.accessToken||/[\r\n\0]/.test(value.accessToken)||
      value.accessExpiresAt&&Date.parse(value.accessExpiresAt)<=Date.now())return null;
    return value.accessToken as string;
  } catch{return null;}
}

/** Finite source read; no arbitrary URLs, redirects, provider payload persistence, or model calls. */
export async function completedMemorySource(ref:string,type:'pr'|'ticket'|'run',companion:any,dependencies:Dependencies={}):Promise<boolean> {
  const database=dependencies.database??db,fetchImpl=dependencies.fetchImpl??fetch;
  if(dependencies.signal?.aborted)return false;
  if(type==='run'&&uuid.test(ref)) {
    const [run]=await database`SELECT status FROM runs WHERE id=${ref} AND companion_id=${companion.id}`;
    return !!run&&['succeeded','failed','cancelled','interrupted'].includes(run.status);
  }
  const match=ref.match(github);
  let url:string,init:RequestInit;
  const signal=dependencies.signal?AbortSignal.any([dependencies.signal,AbortSignal.timeout(2000)]):AbortSignal.timeout(2000);
  if(match) {
    const token=await credential(database,companion,'github');if(!token)return false;
    url=`https://api.github.com/repos/${match[1]}/${match[2]}/${match[3]==='pull'?'pulls':'issues'}/${match[4]}`;
    init={headers:{Accept:'application/json',Authorization:`Bearer ${token}`},signal,redirect:'error'};
  } else if(type==='ticket'&&(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(ref)||/^https:\/\/linear\.app\/[^/]+\/issue\/[A-Z][A-Z0-9]*-[1-9][0-9]*(?:\/[^?#]*)?$/.test(ref))) {
    const token=await credential(database,companion,'linear');if(!token)return false;
    const issueId=ref.startsWith('https:')?ref.split('/')[5]:ref;
    url='https://api.linear.app/graphql';
    init={method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},signal,redirect:'error',
      body:JSON.stringify({query:'query MemoryWorkState($id: String!) { issue(id: $id) { state { type } } }',variables:{id:issueId}})};
  } else return false;
  try {
    const response=await fetchImpl(url,init);
    if(!response.ok){await response.body?.cancel();return false;}
    const reader=response.body?.getReader();if(!reader)return false;
    const chunks:Uint8Array[]=[];let size=0;
    try {for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>64*1024){await reader.cancel();return false;}chunks.push(part.value);}}
    finally{reader.releaseLock();}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return match ? match[3]==='pull'?result.merged===true:result.state==='closed'
      : !result.errors&&['completed','canceled'].includes(result.data?.issue?.state?.type);
  } catch{return false;}
}

/** One bounded page per pass. Never wakes or provisions machines. */
export async function reconcileCompanionMemory(companion:any,dependencies:Dependencies={}) {
  const database=dependencies.database??db,request=dependencies.request??memoryAgentRequest;
  const guard=async()=>{if(dependencies.signal?.aborted)throw Error('MEMORY_CANCELLED');await dependencies.assertActive?.();};
  const endpoint=decrypt(companion.endpoint_secret),token=decrypt(companion.agent_secret);
  // Stored commands go first, so a signed completion retires records before source polling.
  const commands=await database`SELECT operation_id,authority,request FROM memory_commands WHERE companion_id=${companion.id}
    AND settled_at IS NULL ORDER BY created_at,operation_id LIMIT 10`;
  for(const command of commands) {
    await guard();
    const result=await request(endpoint,token,restoreMemoryRequest(command.request),command.authority);
    if(['ok','conflict','invalid','forbidden','consolidation_required'].includes(result.status)) {
      await guard();
      const receipt=memoryCommandReceipt(result);
      await database`UPDATE memory_commands SET response=${receipt}::jsonb,settled_at=now()
        WHERE companion_id=${companion.id} AND operation_id=${command.operation_id} AND settled_at IS NULL`;
    } else return; // A lost response retains the identical operation ID and payload for receipt recovery.
  }
  await guard();
  const page=await request(endpoint,token,{op:'inspect',limit:5,missionsOnly:true,...(companion.memory_cursor?{cursor:companion.memory_cursor}:{})},'system');
  if(page.status!=='ok'||!Array.isArray(page.memories))return;
  for(const memory of page.memories.slice(0,5) as MemoryRecord[]) {
    if(memory.status!=='active')continue;
    const targets:Array<{type:'pr'|'ticket'|'run';ref:string}>=[];
    if(memory.mission?.stopCondition==='pr_merged'&&memory.mission.pr)targets.push({type:'pr',ref:memory.mission.pr});
    if(memory.mission?.stopCondition==='work_completed')targets.push({type:uuid.test(memory.mission.ticket)?'run':'ticket',ref:memory.mission.ticket});
    for(const target of targets.slice(0,2)) {
      await guard();
      if(!await completedMemorySource(target.ref,target.type,companion,dependencies))continue;
      await guard();
      await queueMemoryObservation(database,companion.id,target,target.type==='pr'?'merged':'completed');
    }
  }
  await guard();
  await database`UPDATE companions SET memory_cursor=${page.nextCursor??null} WHERE id=${companion.id}`;
}

/** Scheduling starts after readiness, and never joins admission or run settlement. */
export class MemoryCoordinator {
  private job:Promise<unknown>|null=null;
  private next=Date.now()+5000;
  private controller=new AbortController();
  schedule(leaderPid:number) {
    if(this.job||this.controller.signal.aborted||Date.now()<this.next)return;
    this.next=Date.now()+1000;
    this.job=this.progress(leaderPid).catch(()=>{}).finally(()=>{this.job=null;});
  }
  private async progress(leaderPid:number) {
    const assertActive=async()=>{
      if(this.controller.signal.aborted)throw Error('MEMORY_CANCELLED');
      const [leader]=await db`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=${leaderPid} AND objid=721440139 AND granted) AS owned`;
      if(!leader?.owned)throw Error('MEMORY_AUTHORITY_LOST');
    };
    await assertActive();
    const [companion]=await db`UPDATE companions SET memory_checked_at=now() WHERE id=(SELECT id FROM companions
      WHERE status='ready' AND endpoint_secret IS NOT NULL AND retired_at IS NULL AND archive_requested_at IS NULL
      AND (memory_checked_at IS NULL OR memory_checked_at<now()-interval '30 seconds')
      ORDER BY memory_checked_at NULLS FIRST,id LIMIT 1) RETURNING id,owner_id,endpoint_secret,agent_secret,memory_cursor`;
    if(!companion)return;
    await reconcileCompanionMemory(companion,{assertActive:async()=>{
      await assertActive();
      const [current]=await db`SELECT id FROM companions WHERE id=${companion.id} AND retired_at IS NULL AND archive_requested_at IS NULL
        AND status='ready' AND endpoint_secret=${companion.endpoint_secret}`;
      if(!current)throw Error('MEMORY_GENERATION_CHANGED');
    },signal:this.controller.signal});
  }
  async close(){this.controller.abort();await this.job;}
}
