import {z} from 'zod';
import {db} from './store';
import {LifecycleConflict} from './templates';

type ConnectionRevision=number|undefined;

export async function specialistConnections(ownerId:string,parentId:string,templateId:string,sql:any=db,revision?:ConnectionRevision){
 const [permission]=await sql`SELECT 1 FROM template_permissions p JOIN companions c ON c.id=p.parent_id JOIN agent_templates t ON t.id=p.template_id
  WHERE p.parent_id=${parentId} AND p.template_id=${templateId} AND c.owner_id=${ownerId} AND t.owner_id=${ownerId} AND p.max_children>0`;
 if(!permission)throw new LifecycleConflict('Specialist is not in this team.');
 let versioned=false;
 if(revision!==undefined){
  const [state]=await sql`SELECT EXISTS(SELECT 1 FROM specialist_revision_connections WHERE template_id=${templateId}) AS versioned`;
  versioned=!!state?.versioned;
 }
 if(versioned)return sql`SELECT s.slot,s.required,s.account_id AS "defaultAccountId",o.parent_id IS NOT NULL AS overridden,
  CASE WHEN o.parent_id IS NOT NULL THEN o.account_id ELSE s.account_id END AS "accountId",COALESCE(a.label,s.label) AS label,
  s.provider,s.server_id AS "serverId",a.id IS NOT NULL AND a.provider=s.provider AND (s.server_id IS NULL OR a.server_id=s.server_id) AS connected
  FROM specialist_revision_connections s LEFT JOIN specialist_connection_overrides o ON o.template_id=s.template_id AND o.slot=s.slot AND o.parent_id=${parentId}
  LEFT JOIN plugin_accounts a ON a.id=CASE WHEN o.parent_id IS NOT NULL THEN o.account_id ELSE s.account_id END AND a.owner_id=${ownerId}
  WHERE s.template_id=${templateId} AND s.revision=${revision} ORDER BY s.slot`;
 // Templates created before revision connection snapshots use their current declarations. Once a
 // template has any connection snapshot, an empty selected revision means it intentionally had none.
 return sql`SELECT s.slot,s.required,s.account_id AS "defaultAccountId",o.parent_id IS NOT NULL AS overridden,
  CASE WHEN o.parent_id IS NOT NULL THEN o.account_id ELSE s.account_id END AS "accountId",COALESCE(a.label,s.label) AS label,
  s.provider,s.server_id AS "serverId",a.id IS NOT NULL AND a.provider=s.provider AND (s.server_id IS NULL OR a.server_id=s.server_id) AS connected
  FROM specialist_connections s LEFT JOIN specialist_connection_overrides o ON o.template_id=s.template_id AND o.slot=s.slot AND o.parent_id=${parentId}
  LEFT JOIN plugin_accounts a ON a.id=CASE WHEN o.parent_id IS NOT NULL THEN o.account_id ELSE s.account_id END AND a.owner_id=${ownerId}
  WHERE s.template_id=${templateId} ORDER BY s.slot`;
}

export async function overrideSpecialistConnection(ownerId:string,parentId:string,templateId:string,raw:unknown){
 const value=z.object({slot:z.string().min(1).max(200),accountId:z.string().uuid().nullable(),useDefault:z.boolean().default(false)}).parse(raw);
 return db.begin(async(tx:any)=>{
  const slots=await specialistConnections(ownerId,parentId,templateId,tx);
  const slot=slots.find((s:any)=>s.slot===value.slot);if(!slot)throw new LifecycleConflict('Connection slot not found.');
  if(value.useDefault)await tx`DELETE FROM specialist_connection_overrides WHERE parent_id=${parentId} AND template_id=${templateId} AND slot=${value.slot}`;
  else{
   if(value.accountId){
    const [account]=await tx`SELECT a.id FROM plugin_accounts a JOIN companion_plugins cp ON cp.account_id=a.id
     WHERE a.id=${value.accountId} AND a.owner_id=${ownerId} AND cp.companion_id=${parentId}
      AND a.provider=${slot.provider} AND (${slot.serverId??null}::text IS NULL OR a.server_id=${slot.serverId??null})`;
    if(!account)throw new LifecycleConflict('Select a compatible connection granted to this Companion.');
   }
   await tx`INSERT INTO specialist_connection_overrides(parent_id,template_id,slot,account_id) VALUES(${parentId},${templateId},${value.slot},${value.accountId}) ON CONFLICT(parent_id,template_id,slot) DO UPDATE SET account_id=EXCLUDED.account_id`;
  }
  return {connections:await specialistConnections(ownerId,parentId,templateId,tx)};
 });
}

/** Re-evaluate the pinned revision at dispatch; a later publication cannot change accepted work. */
export async function synchronizeSpecialistConnections(companionId:string,sql:any=db){
 const [child]=await sql`SELECT owner_id,parent_id,template_id,template_revision FROM companions WHERE id=${companionId} AND temporary AND template_id IS NOT NULL`;
 if(!child?.parent_id)return;
 const slots=await specialistConnections(child.owner_id,child.parent_id,child.template_id,sql,child.template_revision??undefined);
 if(slots.some((s:any)=>s.required&&(!s.accountId||!s.connected)))throw new LifecycleConflict('Specialist needs a required MCP connection.');
 await sql`DELETE FROM companion_plugins WHERE companion_id=${companionId}`;
 for(const slot of slots)if(slot.accountId)await sql`INSERT INTO companion_plugins(companion_id,account_id) VALUES(${companionId},${slot.accountId}) ON CONFLICT DO NOTHING`;
}
