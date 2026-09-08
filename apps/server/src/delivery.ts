import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { config, encrypt } from "./config";
import { createMailAdapter, type MailMessage } from "./mail";
import { db } from "./store";
import { ProductActivationRequired, requireProductActivation } from "./billing";
import { queueDeliverySkillExports } from "./delivery-skills";
import { pinDeliverySoftware, refreshDeliverySoftware, grantDeliverySoftware } from "./software-results";
import { SoftwareConflict } from "./software";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const idSchema = z.string().uuid();
const createSchema = z.object({ clientDeliveryId: idSchema, companionId: idSchema,
  clientEmail: z.string().trim().email().max(320).transform(value => value.toLowerCase()),
  templateIds: z.array(idSchema).max(20).refine(ids => new Set(ids).size === ids.length, "Template IDs must be unique").default([]),
  maintenanceRequested: z.boolean().default(false), includeSkills: z.boolean().default(true), includeSpecialistDisks:z.boolean().default(false) });

const mailer = createMailAdapter({
  provider: config.emailProvider, from: config.emailFrom, resendApiKey: config.resendApiKey,
  smtpHost: config.smtpHost, smtpPort: config.smtpPort, smtpSecure: config.smtpSecure,
  smtpUser: config.smtpUser, smtpPassword: config.smtpPassword,
});
let mailOverride: ((mail: MailMessage) => Promise<void>) | null = null;
export function setDeliveryMailerForTests(deliver: ((mail: MailMessage) => Promise<void>) | null) { mailOverride = deliver; }
async function sendInvite(mail: MailMessage) {
  if (mailOverride) return mailOverride(mail);
  await mailer.send(mail);
}

export async function migrateDelivery(sql = db) {
  const schema = await Bun.file(new URL("./delivery.sql", import.meta.url)).text();
  await sql.begin(async tx => { await tx`SELECT pg_advisory_xact_lock(721440141)`; await tx.unsafe(schema); });
}

async function portableTemplates(ownerId: string, companionId: string, ids: string[], sql:any=db,includeDisks=false) {
  const [{ exists }] = await sql`SELECT to_regclass('public.agent_templates') IS NOT NULL AS exists`;
  if (!exists || ids.length === 0) return [];
  const templates: Array<{ sourceTemplateId:string;sourceCompanionId:string|null;skillBundleId:string|null;softwareBuildId:string|null;softwareResultId:string|null;templateRevision:number;name: string; instructions: string; avatar: unknown; modelId:string|null; maxChildren: number;preparedDisk?:string|null;initScript?:string;connections?:Array<{slot:string;required:boolean;provider:string;label:string;server_id:string|null}> }> = [];
  for (const id of ids) {
    const [row] = await sql`SELECT t.id,t.name,t.instructions,t.avatar,t.model_id,t.source_companion_id,t.skill_bundle_id,t.software_build_id,t.software_result_id,t.revision,t.has_published,t.prepared_disk_snapshot,t.init_script,p.max_children FROM agent_templates t JOIN template_permissions p ON p.template_id=t.id AND p.parent_id=${companionId} WHERE t.id=${id} AND t.owner_id=${ownerId} AND t.deleted_at IS NULL FOR SHARE OF t,p`;
    if (!row||!row.has_published) throw new DeliveryConflict("A selected template is unavailable.");
    if(row.prepared_disk_snapshot&&!includeDisks)throw new DeliveryConflict('Confirm sharing the prepared specialist disk, including its files and browser sessions.');
    const connections=await sql`SELECT slot,required,provider,label,server_id FROM specialist_connections WHERE template_id=${id}`;
    templates.push({preparedDisk:row.prepared_disk_snapshot??null,initScript:row.init_script,connections, sourceTemplateId:row.id,sourceCompanionId:row.source_companion_id,skillBundleId:row.skill_bundle_id,softwareBuildId:row.software_build_id??null,softwareResultId:row.software_result_id??null,templateRevision:row.revision,name: row.name, instructions: row.instructions, avatar: row.avatar ?? null, modelId:row.model_id??null, maxChildren: row.max_children });
  }
  return templates;
}

export class DeliveryConflict extends Error {}
export async function createDelivery(ownerId: string, raw: unknown) {
  const input = createSchema.parse(raw);
  const fingerprint = createHash("sha256").update(JSON.stringify({ companionId: input.companionId,
    clientEmail: input.clientEmail, templateIds: input.templateIds, maintenanceRequested: input.maintenanceRequested,includeSkills:input.includeSkills,...(input.includeSpecialistDisks?{includeSpecialistDisks:true}:{}) })).digest("hex");
  const [prior] = await db`SELECT id,recipient_email,expires_at,maintenance_requested,request_fingerprint,skills_status,skills_error,software_status,software_error
    FROM companion_deliveries WHERE source_owner_id=${ownerId} AND client_delivery_id=${input.clientDeliveryId}`;
  if (prior) {
    if (prior.request_fingerprint !== fingerprint) throw new DeliveryConflict("This delivery identifier was already used with different details.");
    return deliveryResult(prior);
  }
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 14 * 86_400_000);
  const inserted = await db.begin(async tx=>{
   const [source] = await tx`SELECT * FROM companions WHERE id=${input.companionId} AND owner_id=${ownerId} FOR SHARE`;
   if(!source)return null;
   const templates=await portableTemplates(ownerId,input.companionId,input.templateIds,tx,input.includeSpecialistDisks);
   const profile={name:source.name,instructions:source.instructions,avatar:source.avatar??null,modelId:source.model_id??null};
   const rows=await tx`INSERT INTO companion_deliveries (id,client_delivery_id,request_fingerprint,source_owner_id,source_companion_id,recipient_email,profile_snapshot,template_profiles,maintenance_requested,expires_at,include_skills,skills_status)
    VALUES (${id},${input.clientDeliveryId},${fingerprint},${ownerId},${input.companionId},${input.clientEmail},${profile},${templates},${input.maintenanceRequested},${expiresAt},${input.includeSkills},${input.includeSkills?'pending':'ready'})
    ON CONFLICT(source_owner_id,client_delivery_id) DO NOTHING RETURNING id`;
   if(rows[0]&&input.includeSkills)await queueDeliverySkillExports(tx,{deliveryId:id,ownerId,companionId:input.companionId,templates:templates.filter(t=>!t.preparedDisk)});
   if(rows[0])await pinDeliverySoftware(tx,id,ownerId,[{key:'main',softwareBuildId:source.software_build_id,softwareResultId:source.software_result_id},...templates.map(t=>({key:t.sourceTemplateId,softwareBuildId:t.softwareBuildId,softwareResultId:t.softwareResultId,templateRevision:t.templateRevision}))]);
   return rows;
  });
  if(!inserted)return null;
  if (!inserted[0]) {
    const [winner] = await db`SELECT id,recipient_email,expires_at,maintenance_requested,request_fingerprint,skills_status,skills_error,software_status,software_error
      FROM companion_deliveries WHERE source_owner_id=${ownerId} AND client_delivery_id=${input.clientDeliveryId}`;
    if (!winner || winner.request_fingerprint !== fingerprint) throw new DeliveryConflict("This delivery identifier was already used with different details.");
    return deliveryResult(winner);
  }
  if(!input.includeSkills)await sendDeliveryReadyInvite(id);
  const [result]=await db`SELECT * FROM companion_deliveries WHERE id=${id}`;
  return deliveryResult(result);
}

function deliveryResult(row:any){return{id:row.id,clientEmail:row.recipient_email,expiresAt:row.expires_at,maintenanceRequested:row.maintenance_requested,skillsStatus:row.skills_status,skillsError:row.skills_error,softwareStatus:row.software_status,softwareError:row.software_error};}
export type DeliveryInviteResult="sent"|"skipped"|"unknown"|"not_pending";
export async function sendDeliveryReadyInvite(deliveryId:string):Promise<DeliveryInviteResult>{
 await refreshDeliverySoftware(db,deliveryId);
 const [delivery]=await db`UPDATE companion_deliveries SET email_status='sending' WHERE id=${deliveryId} AND status='pending' AND skills_status='ready' AND software_status='ready' AND email_status='pending' RETURNING id,recipient_email,profile_snapshot,expires_at`;
 if(!delivery)return "not_pending";
 if(!mailer.isConfigured&&!mailOverride){await db`UPDATE companion_deliveries SET email_status='skipped' WHERE id=${delivery.id} AND email_status='sending'`;return "skipped";}
 const link=`${config.authUrl.replace(/\/$/,"")}/deliveries/${delivery.id}`;
 try{
  await sendInvite({to:delivery.recipient_email,subject:`${String(delivery.profile_snapshot.name)} is ready for you`,text:`Sign in with ${delivery.recipient_email} to review and activate your independent Companion copy:\n\n${link}\n\nThe invitation expires in 14 days.`});
 }catch{
  await db`UPDATE companion_deliveries SET email_status='unknown' WHERE id=${delivery.id} AND email_status='sending'`;
  return "unknown";
 }
 await db`UPDATE companion_deliveries SET email_status='sent' WHERE id=${delivery.id} AND email_status='sending'`;
 return "sent";
}

/** Software completion wakes invitation delivery without contacting a Companion or its Box. */
export async function progressSoftwareDeliveryInvites(limit=20) {
 const pending=await db`SELECT d.id FROM companion_deliveries d WHERE d.status='pending' AND d.expires_at>now()
   AND (d.software_status='pending' OR (d.software_status='ready' AND d.skills_status='ready' AND d.email_status='pending'))
   AND EXISTS(SELECT 1 FROM delivery_software_targets t WHERE t.delivery_id=d.id)
   AND (EXISTS(SELECT 1 FROM delivery_software_targets t JOIN portable_software_builds b ON b.id=t.source_build_id WHERE t.delivery_id=d.id AND b.status='failed')
     OR NOT EXISTS(SELECT 1 FROM delivery_software_targets t JOIN portable_software_builds b ON b.id=t.source_build_id WHERE t.delivery_id=d.id AND (b.status<>'ready' OR b.result_id IS NULL)))
   ORDER BY d.created_at,d.id LIMIT ${Math.min(100,Math.max(1,limit))}`;
 for(const delivery of pending)await sendDeliveryReadyInvite(delivery.id);
 return pending.length;
}

async function copyPortableTemplates(sql: any, ownerId: string, companionId: string, deliveryId:string,templates: unknown,software:Map<string,{id:string;snapshot:string}>) {
  const [{ exists }] = await sql`SELECT to_regclass('public.agent_templates') IS NOT NULL AS exists`;
  if (!exists || !Array.isArray(templates)) return;
  for (const raw of templates) {
    const profile = z.object({ sourceTemplateId:z.string().uuid(),name: z.string().min(1).max(80), instructions: z.string().max(20_000), avatar: z.unknown().nullable(), modelId:z.string().min(1).max(200).nullable().optional(), maxChildren: z.number().int().min(1).max(20),preparedDisk:z.string().nullable().optional(),initScript:z.string().default(''),connections:z.array(z.object({slot:z.string(),required:z.boolean(),provider:z.string().default('custom'),label:z.string().default('Integration'),server_id:z.string().nullable().optional()})).default([]) }).parse(raw);
    const [exported]=await sql`SELECT bundle_id FROM portable_skill_exports WHERE delivery_id=${deliveryId} AND target_kind='delivery_template' AND source_template_id=${profile.sourceTemplateId} AND status='ready'`;
    const templateId = crypto.randomUUID();
    const prepared=software.get(profile.sourceTemplateId);
    await sql`INSERT INTO agent_templates (id,owner_id,name,instructions,avatar,model_id,snapshot_name,source_companion_id,skill_bundle_id,software_result_id) VALUES (${templateId},${ownerId},${profile.name},${profile.instructions},${profile.avatar},${profile.modelId??null},${profile.preparedDisk??prepared?.snapshot??null},NULL,${exported?.bundle_id??null},${prepared?.id??null})`;
    await sql`INSERT INTO template_revisions(template_id,revision,owner_id,name,instructions,avatar,model_id,snapshot_name,source_companion_id,skill_bundle_id,software_result_id) VALUES(${templateId},1,${ownerId},${profile.name},${profile.instructions},${profile.avatar},${profile.modelId??null},${profile.preparedDisk??prepared?.snapshot??null},NULL,${exported?.bundle_id??null},${prepared?.id??null}) ON CONFLICT DO NOTHING`;
    await sql`UPDATE agent_templates SET init_script=${profile.initScript},prepared_disk_snapshot=${profile.preparedDisk??null} WHERE id=${templateId}`;
    await sql`UPDATE template_revisions SET init_script=${profile.initScript} WHERE template_id=${templateId} AND revision=1`;
    for(const slot of profile.connections)await sql`INSERT INTO specialist_connections(template_id,slot,required,provider,label,server_id) VALUES(${templateId},${slot.slot},${slot.required},${slot.provider},${slot.label},${slot.server_id??null})`;
    await sql`INSERT INTO specialist_revision_connections SELECT template_id,1,slot,account_id,required,provider,label,server_id FROM specialist_connections WHERE template_id=${templateId}`;
    await sql`INSERT INTO template_permissions (parent_id,template_id,max_children) VALUES (${companionId},${templateId},${profile.maxChildren})`;
  }
}

export async function acceptDelivery(ownerId: string, deliveryId: string, grantMaintenance: boolean) {
  await requireProductActivation(ownerId);
  return db.begin(async sql => {
    const [user] = await sql`SELECT lower(email) AS email,"emailVerified" AS verified FROM "user" WHERE id=${ownerId}`;
    if (!user?.verified) throw new DeliveryConflict("Verify your email before accepting this delivery.");
    const [delivery] = await sql`SELECT * FROM companion_deliveries WHERE id=${deliveryId} FOR UPDATE`;
    if (!delivery || delivery.recipient_email !== user.email) return null;
    if (delivery.status === "accepted") return { companionId: delivery.delivered_companion_id, accepted: false };
    if (delivery.status !== "pending" || new Date(delivery.expires_at) <= new Date()) throw new DeliveryConflict("This invitation is no longer available.");
    if(delivery.skills_status==='pending')throw new DeliveryConflict('Portable skills are still being prepared.');
    if(delivery.skills_status==='error')throw new DeliveryConflict(delivery.skills_error??'Portable skills could not be prepared.');
    const software=await grantDeliverySoftware(sql,deliveryId,ownerId);
    const mainSoftware=software.get('main');
    const profile = z.object({ name: z.string().min(1).max(80), instructions: z.string().max(20_000), avatar: z.unknown().nullable(), modelId:z.string().max(200).nullable().optional() }).parse(delivery.profile_snapshot);
    const companionId = crypto.randomUUID();
    const provider = software.size ? "box" : config.defaultProvider;
    if (provider === "box" && !config.boxTemplate && !mainSoftware) throw new DeliveryConflict("The fresh Box base template is not configured.");
    const [mainBundle]=await sql`SELECT bundle_id FROM portable_skill_exports WHERE delivery_id=${deliveryId} AND target_kind='delivery_main' AND status='ready'`;
    await sql`INSERT INTO companions (id,owner_id,name,instructions,provider,create_key,agent_secret,prepare_requested,skill_bundle_id,model_id,snapshot_name,software_result_id) VALUES (${companionId},${ownerId},${profile.name},${profile.instructions},${provider},${crypto.randomUUID()},${encrypt(randomBytes(32).toString("hex"))},true,${mainBundle?.bundle_id??null},${profile.modelId??null},${mainSoftware?.snapshot??null},${mainSoftware?.id??null})`;
    const [{ avatar_column }] = await sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='companions' AND column_name='avatar') AS avatar_column`;
    if (avatar_column && profile.avatar !== null) await sql.unsafe("UPDATE companions SET avatar=$1::jsonb WHERE id=$2", [JSON.stringify(profile.avatar), companionId]);
    await copyPortableTemplates(sql, ownerId, companionId,deliveryId,delivery.template_profiles,software);
    if (grantMaintenance && delivery.maintenance_requested) {
      await sql`INSERT INTO companion_maintenance_grants (delivery_id,companion_id,client_owner_id,maintainer_id) VALUES (${deliveryId},${companionId},${ownerId},${delivery.source_owner_id})`;
    }
    await sql`UPDATE companion_deliveries SET status='accepted',accepted_by=${ownerId},delivered_companion_id=${companionId},accepted_at=now() WHERE id=${deliveryId}`;
    return { companionId, accepted: true };
  });
}

export async function canMaintainCompanion(maintainerId: string, companionId: string) {
  const [grant] = await db`SELECT 1 FROM companion_maintenance_grants WHERE maintainer_id=${maintainerId} AND companion_id=${companionId} AND revoked_at IS NULL`;
  return !!grant;
}

export async function handleDelivery(request: Request, ownerId: string) {
  const url = new URL(request.url);
  if (url.pathname === "/api/deliveries" && request.method === "GET") {
    const [user] = await db`SELECT lower(email) AS email FROM "user" WHERE id=${ownerId}`;
    const [sent, received] = await Promise.all([
      db`SELECT id,recipient_email AS "clientEmail",status,skills_status AS "skillsStatus",skills_error AS "skillsError",software_status AS "softwareStatus",software_error AS "softwareError",maintenance_requested AS "maintenanceRequested",expires_at AS "expiresAt",accepted_at AS "acceptedAt",delivered_companion_id AS "companionId" FROM companion_deliveries WHERE source_owner_id=${ownerId} ORDER BY created_at DESC`,
      db`SELECT id,profile_snapshot->>'name' AS name,status,skills_status AS "skillsStatus",skills_error AS "skillsError",software_status AS "softwareStatus",software_error AS "softwareError",maintenance_requested AS "maintenanceRequested",expires_at AS "expiresAt",accepted_at AS "acceptedAt",delivered_companion_id AS "companionId" FROM companion_deliveries WHERE recipient_email=${user.email} ORDER BY created_at DESC`,
    ]);
    return json({ sent, received });
  }
  if (url.pathname === "/api/deliveries" && request.method === "POST") {
    try {
      const delivery = await createDelivery(ownerId, await request.json());
      return delivery ? json({ delivery }, 201) : json({ error: "Companion not found." }, 404);
    } catch (error) {
      if (error instanceof DeliveryConflict || error instanceof SoftwareConflict) return json({ error: error.message }, 409);
      throw error;
    }
  }
  const match = url.pathname.match(/^\/api\/deliveries\/([^/]+)(?:\/(accept|maintenance))?$/);
  if (!match) return null;
  const id = idSchema.parse(match[1]);
  if (match[2] === "accept" && request.method === "POST") {
    const body = z.object({ grantMaintenance: z.boolean().default(false) }).parse(await request.json().catch(() => ({})));
    try {
      const result = await acceptDelivery(ownerId, id, body.grantMaintenance);
      return result ? json(result) : json({ error: "Delivery not found." }, 404);
    } catch (error) {
      if (error instanceof DeliveryConflict || error instanceof ProductActivationRequired || error instanceof SoftwareConflict) return json({ error: error.message }, 409);
      throw error;
    }
  }
  if (match[2] === "maintenance" && request.method === "DELETE") {
    return db.begin(async tx=>{
      const rows=await tx`UPDATE companion_maintenance_grants SET revoked_at=now() WHERE delivery_id=${id} AND client_owner_id=${ownerId} AND revoked_at IS NULL RETURNING delivery_id`;
      if(!rows.length)return json({error:"Maintenance access not found."},404);
      await tx`UPDATE runs r SET cancel_requested=true,status=CASE WHEN r.status='queued' THEN 'cancelled' ELSE r.status END,finished_at=CASE WHEN r.status='queued' THEN now() ELSE r.finished_at END WHERE r.id IN (SELECT run_id FROM maintenance_actions WHERE grant_id=${id}) AND r.status IN ('queued','preparing','running','needs_input')`;
      return json({revoked:true});
    });
  }
  if (!match[2] && request.method === "DELETE") {
    const rows = await db`UPDATE companion_deliveries SET status='revoked' WHERE id=${id} AND source_owner_id=${ownerId} AND status='pending' RETURNING id`;
    return rows.length ? json({ revoked: true }) : json({ error: "Pending delivery not found." }, 404);
  }
  return null;
}
