import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from './store';
import { decrypt } from './config';
import { fetchAgent } from '../../../packages/box/transport';
import { readMemoryJson } from '../../../packages/agent/src/memory-protocol';
import type { MemoryRequest } from '../../../packages/agent/src/memory-protocol';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const transition = z.object({ operationId: identifier, id: identifier, expectedVersion: z.number().int().positive() }).strict();
const source = z.object({type:z.enum(['run','ticket','pr','repository']),ref:z.string().min(1).max(1000),revision:z.string().max(200).optional()}).strict();
const checkpoint = z.object({operationId:identifier,threadId:identifier,projectKey:z.string().min(1).max(200).optional(),
  decided:z.array(z.string().min(1).max(1000)).max(10),open:z.array(z.string().min(1).max(1000)).max(10),
  next:z.array(z.string().min(1).max(1000)).max(10),pointers:z.array(source).max(10)}).strict();
const json = (body:unknown,status=200) => Response.json(body,{status,headers:{'cache-control':'no-store'}});

export async function memoryAgentRequest(endpoint:string,token:string,request:MemoryRequest,authority:'human'|'system'='human',transport:typeof fetch=fetch) {
  const response = await fetchAgent(endpoint,token,'/memory','POST',{request,authority},2500,transport);
  if (!response.ok) { await response.body?.cancel(); throw Error('MEMORY_UNAVAILABLE'); }
  const result = await readMemoryJson(response);
  if(!result || typeof result.status!=='string') throw Error('MEMORY_UNAVAILABLE');
  return result;
}

/** Durable retry identity precedes daemon contact; payload changes never replace an intent. */
export async function queueMemoryCommand(database:any,companionId:string,request:MemoryRequest & {operationId:string},authority:'human'|'system') {
  // PostgreSQL JSONB cannot represent U+0000; encode the canonical intent without losing legacy bytes.
  const payload=JSON.stringify(request,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
  const stored={op:request.op,operationId:request.operationId,encoding:'base64-json-v1',payload:Buffer.from(payload).toString('base64')};
  const [row] = await database`INSERT INTO memory_commands(companion_id,operation_id,authority,request)
    VALUES(${companionId},${request.operationId},${authority},${stored}::jsonb)
    ON CONFLICT(companion_id,operation_id) DO UPDATE SET operation_id=EXCLUDED.operation_id
    WHERE memory_commands.request=EXCLUDED.request AND memory_commands.authority=EXCLUDED.authority
    RETURNING operation_id AS "operationId",response,settled_at AS "settledAt"`;
  return row ?? null;
}

export async function handleMemory(request:Request,ownerId:string):Promise<Response|null> {
  const url=new URL(request.url),match=url.pathname.match(/^\/api\/companions\/([^/]+)\/memory(?:\/(approve|retire|adopt-legacy|legacy|checkpoint|brief|commands)(?:\/([^/]+))?)?$/);
  if(!match)return null;
  const companionId=z.string().uuid().parse(match[1]);
  const [companion]=await db`SELECT id,status,endpoint_secret,agent_secret FROM companions WHERE id=${companionId}
    AND owner_id=${ownerId} AND retired_at IS NULL AND archive_requested_at IS NULL`;
  if(!companion)return json({error:'Companion not found.'},404);
  const action=match[2];
  if(request.method==='GET'&&action==='commands'&&match[3]) {
    const operationId=identifier.parse(match[3]);
    const [command]=await db`SELECT operation_id AS "operationId",response,settled_at AS "settledAt" FROM memory_commands
      WHERE companion_id=${companionId} AND operation_id=${operationId} AND authority='human'`;
    return command?json({command}):json({error:'Memory request not found.'},404);
  }
  if(request.method==='GET'&&(!action||action==='brief')) {
    if(companion.status!=='ready'||!companion.endpoint_secret)return json({error:'Memory is unavailable while this Companion is asleep or preparing.'},503);
    const input:MemoryRequest=action==='brief'?{op:'brief',threadId:identifier.parse(url.searchParams.get('threadId')),
      ...(url.searchParams.has('projectKey')?{projectKey:z.string().min(1).max(200).parse(url.searchParams.get('projectKey'))}:{})}
      :{op:'inspect',...(url.searchParams.has('cursor')?{cursor:identifier.parse(url.searchParams.get('cursor'))}:{})};
    try {
      const result=await memoryAgentRequest(decrypt(companion.endpoint_secret),decrypt(companion.agent_secret),input);
      if(result.status!=='ok')return json({error:'Memory is temporarily unavailable.'},503);
      return json(result);
    } catch{return json({error:'Memory is temporarily unavailable.'},503);}
  }
  if(request.method==='POST'&&['approve','retire','adopt-legacy','legacy','checkpoint'].includes(action??'')&&!match[3]) {
    let input:MemoryRequest & {operationId:string};
    let body:unknown;
    try {body=await readMemoryJson(request);} catch(error) {return json({error:'Invalid memory request.'},error instanceof Error&&error.message==='MEMORY_TOO_LARGE'?413:400);}
    if(action==='legacy')input={op:'legacy_replace',...z.object({operationId:identifier,expectedVersion:z.string().regex(/^[a-f0-9]{64}$/),content:z.string().max(30_000).refine(value=>Buffer.byteLength(value)<=30_000)}).strict().parse(body)};
    else if(action==='checkpoint')input={op:'checkpoint',...checkpoint.parse(body)};
    else if(action==='adopt-legacy')input={op:'adopt_legacy',...z.object({operationId:identifier}).strict().parse(body)};
    else input={op:action as 'approve'|'retire',...transition.parse(body)};
    const command=await db.begin(async tx=>{
      const [owned]=await tx`SELECT id FROM companions WHERE id=${companionId} AND owner_id=${ownerId}
        AND retired_at IS NULL AND archive_requested_at IS NULL FOR UPDATE`;
      return owned?queueMemoryCommand(tx,companionId,input,'human'):null;
    });
    return command?json({command},202):json({error:'The memory request conflicts with an existing operation or the Companion is unavailable.'},409);
  }
  return json({error:'Method not allowed.'},405);
}

/** Called inside the existing signature-verified webhook receipt transaction. */
export async function acceptMemoryWebhook(database:any,companionId:string,event:string|null,payload:unknown) {
  if(event!=='pull_request')return;
  const parsed=z.object({action:z.literal('closed'),number:z.number().int().positive(),
    repository:z.object({full_name:z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)}),
    pull_request:z.object({merged:z.literal(true)})}).safeParse(payload);
  if(!parsed.success)return;
  const ref=`https://github.com/${parsed.data.repository.full_name}/pull/${parsed.data.number}`;
  await queueMemoryObservation(database,companionId,{type:'pr',ref},'merged');
}

export function queueMemoryObservation(database:any,companionId:string,source:{type:'run'|'ticket'|'pr';ref:string},state:'merged'|'completed') {
  const operationId='source-'+createHash('sha256').update(JSON.stringify({source,state})).digest('hex');
  return queueMemoryCommand(database,companionId,{op:'observe',operationId,source,state},'system');
}

/** Web command receipts identify outcomes; record bodies remain in the agent store. */
export function memoryCommandReceipt(result:any) {
  const receipt:Record<string,unknown>={status:result.status};
  if(typeof result.error==='string'&&/^MEMORY_[A-Z_]{1,80}$/.test(result.error))receipt.error=result.error;
  if(result.memory&&typeof result.memory.id==='string')receipt.record={id:result.memory.id,version:result.memory.version,
    status:result.memory.status,approval:result.memory.approval};
  if(result.legacy&&typeof result.legacy.version==='string')receipt.legacyVersion=result.legacy.version;
  if(typeof result.deleted==='boolean')receipt.deleted=result.deleted;
  if(Number.isSafeInteger(result.retired))receipt.retired=result.retired;
  return receipt;
}

export function restoreMemoryRequest(stored:any):MemoryRequest {
  return stored.encoding==='base64-json-v1'?JSON.parse(Buffer.from(stored.payload,'base64').toString('utf8')):stored;
}
