import {z} from 'zod';
import {db} from './store';
import {configureCompanion} from './control';
import {requireHostedActivation} from './activation';
import {enqueueBackgroundInTransaction} from './automations';
const uuid=z.string().uuid();
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export async function handleMaintenance(request:Request,actorId:string):Promise<Response|null>{
 const path=new URL(request.url).pathname;
 if(path==='/api/maintenance'&&request.method==='GET')return json({companions:await db`SELECT c.id,c.name,c.avatar,c.status,c.error,g.delivery_id AS "grantId" FROM companion_maintenance_grants g JOIN companions c ON c.id=g.companion_id WHERE g.maintainer_id=${actorId} AND g.revoked_at IS NULL AND c.retired_at IS NULL ORDER BY g.granted_at DESC`});
 const match=path.match(/^\/api\/maintenance\/companions\/([^/]+)(?:\/(prepare|tasks|actions))?$/);
 if(!match)return null;const id=uuid.parse(match[1]);
 return db.begin(async tx=>{
  const [grant]=await tx`SELECT g.* FROM companion_maintenance_grants g JOIN companions c ON c.id=g.companion_id WHERE g.companion_id=${id} AND g.maintainer_id=${actorId} AND g.revoked_at IS NULL AND c.retired_at IS NULL FOR UPDATE OF g`;
  if(!grant)return json({error:'Maintenance access not found.'},404);
  if(request.method==='GET'){
   if(match[2]==='actions')return json({actions:await tx`SELECT a.id,a.operation,a.created_at AS "createdAt",r.status,r.error FROM maintenance_actions a LEFT JOIN runs r ON r.id=a.run_id WHERE a.grant_id=${grant.delivery_id} ORDER BY a.created_at DESC LIMIT 50`});
   const [companion]=await tx`SELECT id,name,instructions,avatar,model_id AS "modelId",status,error,ready_at AS "readyAt" FROM companions WHERE id=${id}`;
   return json({companion});
  }
  if(!match[2]&&request.method==='PATCH'){
   const result=await configureCompanion(grant.client_owner_id,id,await request.json(),tx);
   await tx`INSERT INTO maintenance_actions(id,grant_id,actor_id,companion_id,operation) VALUES(${crypto.randomUUID()},${grant.delivery_id},${actorId},${id},'configure')`;
   return json({companion:result});
  }
  if(request.method==='POST'&&['prepare','tasks'].includes(match[2])){
   await requireHostedActivation(grant.client_owner_id);
   if(match[2]==='prepare'){
    await tx`UPDATE companions SET prepare_requested=true WHERE id=${id}`;
    await tx`INSERT INTO maintenance_actions(id,grant_id,actor_id,companion_id,operation) VALUES(${crypto.randomUUID()},${grant.delivery_id},${actorId},${id},'prepare')`;
    return json({preparing:true},202);
   }
   const {clientMessageId,prompt}=z.object({clientMessageId:uuid,prompt:z.string().trim().min(1).max(50_000)}).parse(await request.json());
   const runId=await enqueueBackgroundInTransaction({companionId:id,clientMessageId,content:prompt,source:'delegation'},tx);
   await tx`INSERT INTO maintenance_actions(id,grant_id,actor_id,companion_id,operation,run_id) VALUES(${clientMessageId},${grant.delivery_id},${actorId},${id},'task',${runId}) ON CONFLICT DO NOTHING`;
   return json({runId},202);
  }
  return json({error:'Method not allowed.'},405);
 });
}
