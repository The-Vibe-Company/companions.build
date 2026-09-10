import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { SharedMemory, replaceLegacyMemory } from './memory';
import type { MemoryRequest, MemoryResponse } from './memory-protocol';

/** File CAS is outside SQLite: an intent precedes it, and recovery observes rather than replays. */
export function replaceLegacyWithReceipt(db:Database,workspace:string,request:Extract<MemoryRequest,{op:'legacy_replace'}>):MemoryResponse {
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(request.operationId)||!/^[a-f0-9]{64}$/.test(request.expectedVersion)||
    typeof request.content!=='string'||Buffer.byteLength(request.content)>30_000)return{status:'invalid',error:'MEMORY_REQUEST_INVALID'};
  const hash=createHash('sha256').update(JSON.stringify({op:request.op,operationId:request.operationId,expectedVersion:request.expectedVersion,content:request.content,authority:'human'})).digest('hex');
  const targetVersion=createHash('sha256').update(request.content).digest('hex');
  const key=`legacy-intent:${request.operationId}`;
  const receipt=db.query('SELECT request_hash,response_json FROM memory_mutations WHERE operation_id=?').get(request.operationId) as {request_hash:string;response_json:string}|null;
  if(receipt)return receipt.request_hash===hash?JSON.parse(receipt.response_json):{status:'conflict',error:'MEMORY_OPERATION_CONFLICT'};
  const prior=db.query('SELECT value FROM memory_meta WHERE key=?').get(key) as {value:string}|null;
  const finish=(response:MemoryResponse)=>{
    db.transaction(()=>{
      db.query('INSERT INTO memory_mutations(operation_id,request_hash,response_json,created_at) VALUES(?,?,?,?)').run(request.operationId,hash,JSON.stringify(response),new Date().toISOString());
      if(response.status==='ok'&&'legacy' in response&&db.query("SELECT 1 FROM memory_lifecycle WHERE id='legacy-shared-memory'").get()) {
        const lifecycle=db.query("SELECT source_json FROM memory_lifecycle WHERE id='legacy-shared-memory'").get() as {source_json:string};
        let source:Record<string,unknown>;
        try {source=JSON.parse(lifecycle.source_json) as Record<string,unknown>;} catch {source={type:'repository',ref:'MEMORY.md'};}
        if(source.type==='repository')source.revision=targetVersion;
        db.query("UPDATE memory_lifecycle SET version=version+1,source_json=? WHERE id='legacy-shared-memory'").run(JSON.stringify(source));
        db.query("INSERT INTO memory_meta(key,value) VALUES('legacy-lifecycle-digest',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(targetVersion);
      }
      db.query('DELETE FROM memory_meta WHERE key=?').run(key);
    }).immediate();
    return response;
  };
  const current=new SharedMemory(workspace).read();
  if(prior) {
    if(prior.value!==hash)return{status:'conflict',error:'MEMORY_OPERATION_CONFLICT'};
    return current.version===targetVersion?finish({status:'ok',legacy:current}):finish({status:'conflict',error:'MEMORY_LEGACY_OUTCOME_UNKNOWN'});
  }
  if(current.version!==request.expectedVersion)return finish({status:'conflict',error:'MEMORY_VERSION_CONFLICT'});
  db.query('INSERT INTO memory_meta(key,value) VALUES(?,?)').run(key,hash);
  const result=replaceLegacyMemory(workspace,request.expectedVersion,request.content);
  return finish(result.updated?{status:'ok',legacy:result.memory}:{status:'conflict',error:result.error});
}
