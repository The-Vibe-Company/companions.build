import {db} from './store';
import {config} from './config';
import {BoxClient,type Box} from '../../../packages/box/client';
import type {ReservedSQL} from 'bun';
export const BOX_OBSERVATION_INTERVAL_MS=60_000;
export const BOX_OBSERVATION_MAX_GAP_MS=120_000;
export async function migrateBoxObservation(sql:any=db){await sql.unsafe(await Bun.file(new URL('./box-observation.sql',import.meta.url)).text());}
export type ObservedBox={id:string;owner_id:string;box_id:string;ready_event_id:string;ready_at:Date|string};
async function assertLeader(sql:any,leaderPid:number){
 const [lock]=await sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=${leaderPid} AND objid=721440139 AND granted) AS owned`;
 if(!lock.owned)throw Error('Executor ownership lost');
}
/** A late provider reply cannot overwrite a new ready generation, another owner or another Box. */
async function current(sql:any,candidate:ObservedBox){
 const [row]=await sql`SELECT c.id FROM companions c WHERE c.id=${candidate.id} AND c.owner_id=${candidate.owner_id} AND c.provider='box' AND c.box_id=${candidate.box_id} AND c.retired_at IS NULL
  AND NOT c.prepare_requested AND c.status='ready'
  AND (SELECT id FROM machine_usage_events WHERE companion_id=c.id AND owner_id=c.owner_id AND event='ready' ORDER BY occurred_at DESC,id DESC LIMIT 1)=${candidate.ready_event_id} FOR UPDATE`;
 return !!row;
}
/** Read-only provider boundary. No resume, commands, stop or create method is available here. */
export async function observeBox(candidate:ObservedBox,leaderPid:number,getBox:(id:string)=>Promise<Box>,sql:any=db,clock:()=>Date=()=>new Date()){
 const started=clock();
 const admitted=await sql.begin(async(tx:any)=>{
  await assertLeader(tx,leaderPid);if(!await current(tx,candidate))return false;
  await tx`INSERT INTO box_observations(ready_event_id,companion_id,owner_id,box_id,attempted_at)
   VALUES(${candidate.ready_event_id},${candidate.id},${candidate.owner_id},${candidate.box_id},${started})
   ON CONFLICT(ready_event_id) DO UPDATE SET attempted_at=EXCLUDED.attempted_at`;
  return true;
 });
 if(!admitted)return;
 await assertLeader(sql,leaderPid);
 const box=await getBox(candidate.box_id);
 if(box.id!==candidate.box_id)throw Error('Box observation identity mismatch');
 const observed=clock();
 await sql.begin(async(tx:any)=>{
  await assertLeader(tx,leaderPid);if(!await current(tx,candidate))return;
  const [previous]=await tx`SELECT * FROM box_observations WHERE ready_event_id=${candidate.ready_event_id} AND owner_id=${candidate.owner_id} AND box_id=${candidate.box_id} FOR UPDATE`;
  if(!previous||previous.observed_at&&new Date(previous.observed_at)>started)return;
  const ready=new Date(candidate.ready_at);
  const lastAlive=previous.last_alive_at?new Date(previous.last_alive_at):ready;
  const archiveAfter=box.archiveAfter?new Date(box.archiveAfter):previous.archive_after;
  const state=box.state==='ready'?'alive':box.state==='archived'?'archived':'unknown';
  if(state==='alive'&&started.getTime()-lastAlive.getTime()>BOX_OBSERVATION_MAX_GAP_MS){
   await tx`INSERT INTO box_observation_gaps(ready_event_id,starts_at,ends_at) VALUES(${candidate.ready_event_id},${lastAlive},${started}) ON CONFLICT DO NOTHING`;
  }
  await tx`UPDATE box_observations SET observed_at=${observed},last_alive_at=${state==='alive'?started:previous.last_alive_at},archive_after=${archiveAfter},provider_updated_at=${box.updatedAt?new Date(box.updatedAt):null},state=${state} WHERE ready_event_id=${candidate.ready_event_id}`;
  if(state==='archived'){
   // updatedAt is metadata, not evidence of the exact archive instant. Never close at a late poll.
   const ended=new Date(Math.max(ready.getTime(),Math.min(lastAlive.getTime(),archiveAfter?new Date(archiveAfter).getTime():Infinity)));
   await tx`INSERT INTO machine_usage_events(id,companion_id,owner_id,event,occurred_at,closes_ready_event_id)
    VALUES(${crypto.randomUUID()},${candidate.id},${candidate.owner_id},'archived',${ended},${candidate.ready_event_id})
    ON CONFLICT(closes_ready_event_id) WHERE event='archived' AND closes_ready_event_id IS NOT NULL DO NOTHING`;
   await tx`UPDATE companions SET status='archived',archived_at=${ended},endpoint_secret=null,error=null WHERE id=${candidate.id} AND owner_id=${candidate.owner_id} AND box_id=${candidate.box_id}`;
  }
  await assertLeader(tx,leaderPid);
 });
}
/** One background sweep per minute, with sequential GETs and no reserved connection while waiting. */
export class BoxObserver {
 private inflight:Promise<void>|null=null;
 private nextSweep=0;
 private closing=false;
 private getBox:((id:string)=>Promise<Box>)|null;
 constructor(private sql:any=db,getBox?:((id:string)=>Promise<Box>),private clock:()=>Date=()=>new Date()){
  const client=config.boxKey?new BoxClient(config.boxKey):null;this.getBox=getBox??(client?(id=>client.get(id)):null);
 }
 async schedule(leader:ReservedSQL){
  if(this.closing||this.inflight||!this.getBox||this.clock().getTime()<this.nextSweep)return;
  const [identity]=await leader`SELECT pg_backend_pid() AS pid`;
  await assertLeader(leader,identity.pid);
  this.nextSweep=this.clock().getTime()+BOX_OBSERVATION_INTERVAL_MS;
  this.inflight=this.sweep(identity.pid).catch(()=>{console.error('box_observation_failed');}).finally(()=>{this.inflight=null;});
 }
 private async sweep(leaderPid:number){
  const before=new Date(this.clock().getTime()-BOX_OBSERVATION_INTERVAL_MS);
  const candidates=await this.sql`SELECT c.id,c.owner_id,c.box_id,e.id AS ready_event_id,e.occurred_at AS ready_at FROM companions c
   JOIN LATERAL(SELECT id,occurred_at FROM machine_usage_events WHERE companion_id=c.id AND owner_id=c.owner_id AND event='ready' ORDER BY occurred_at DESC,id DESC LIMIT 1)e ON true
   LEFT JOIN box_observations o ON o.ready_event_id=e.id
   WHERE c.provider='box' AND c.box_id IS NOT NULL AND c.retired_at IS NULL AND c.status='ready' AND NOT c.prepare_requested
    AND (o.attempted_at IS NULL OR o.attempted_at<=${before}) ORDER BY o.attempted_at NULLS FIRST,c.id LIMIT 50`;
  for(const candidate of candidates){
   if(this.closing)return;
   await assertLeader(this.sql,leaderPid);
   try{await observeBox(candidate,leaderPid,this.getBox!,this.sql,this.clock);}catch{await assertLeader(this.sql,leaderPid);}
  }
 }
 async close(){this.closing=true;await this.inflight;}
}
