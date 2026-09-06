import { createHash, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { z } from "zod";
import { config, encrypt } from "./config";
import { db } from "./store";
import { ProductActivationRequired, requireProductActivation } from "./billing";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const idSchema = z.string().uuid();
const createSchema = z.object({ clientDeliveryId: idSchema, companionId: idSchema,
  clientEmail: z.string().trim().email().max(320).transform(value => value.toLowerCase()),
  templateIds: z.array(idSchema).max(20).refine(ids => new Set(ids).size === ids.length, "Template IDs must be unique").default([]),
  maintenanceRequested: z.boolean().default(false) });

type Mail = { to: string; subject: string; text: string };
let mailOverride: ((mail: Mail) => Promise<void>) | null = null;
export function setDeliveryMailerForTests(deliver: ((mail: Mail) => Promise<void>) | null) { mailOverride = deliver; }
async function sendInvite(mail: Mail) {
  if (mailOverride) return mailOverride(mail);
  if (!config.smtpHost) return;
  const transport = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure, ...(config.smtpUser ? { auth: { user: config.smtpUser, pass: config.smtpPassword } } : {}) });
  await transport.sendMail({ from: config.smtpFrom, ...mail });
}

export async function migrateDelivery(sql = db) {
  const schema = await Bun.file(new URL("./delivery.sql", import.meta.url)).text();
  await sql.begin(async tx => { await tx`SELECT pg_advisory_xact_lock(721440141)`; await tx.unsafe(schema); });
}

async function portableTemplates(ownerId: string, companionId: string, ids: string[]) {
  const [{ exists }] = await db`SELECT to_regclass('public.agent_templates') IS NOT NULL AS exists`;
  if (!exists || ids.length === 0) return [];
  const templates: Array<{ name: string; instructions: string; avatar: unknown; maxChildren: number }> = [];
  for (const id of ids) {
    const [row] = await db`SELECT t.name,t.instructions,t.avatar,p.max_children FROM agent_templates t JOIN template_permissions p ON p.template_id=t.id AND p.parent_id=${companionId} WHERE t.id=${id} AND t.owner_id=${ownerId}`;
    if (!row) throw new DeliveryConflict("A selected template is unavailable.");
    templates.push({ name: row.name, instructions: row.instructions, avatar: row.avatar ?? null, maxChildren: row.max_children });
  }
  return templates;
}

export class DeliveryConflict extends Error {}
export async function createDelivery(ownerId: string, raw: unknown) {
  const input = createSchema.parse(raw);
  const fingerprint = createHash("sha256").update(JSON.stringify({ companionId: input.companionId,
    clientEmail: input.clientEmail, templateIds: input.templateIds, maintenanceRequested: input.maintenanceRequested })).digest("hex");
  const [prior] = await db`SELECT id,recipient_email,expires_at,maintenance_requested,request_fingerprint
    FROM companion_deliveries WHERE source_owner_id=${ownerId} AND client_delivery_id=${input.clientDeliveryId}`;
  if (prior) {
    if (prior.request_fingerprint !== fingerprint) throw new DeliveryConflict("This delivery identifier was already used with different details.");
    return { id: prior.id, clientEmail: prior.recipient_email, expiresAt: prior.expires_at, maintenanceRequested: prior.maintenance_requested };
  }
  const [companion] = await db`SELECT to_jsonb(companions) AS value FROM companions WHERE id=${input.companionId} AND owner_id=${ownerId}`;
  if (!companion) return null;
  const source = companion.value as Record<string, unknown>;
  const templates = await portableTemplates(ownerId, input.companionId, input.templateIds);
  const profile = { name: source.name, instructions: source.instructions, avatar: source.avatar ?? null };
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 14 * 86_400_000);
  const inserted = await db`INSERT INTO companion_deliveries (id,client_delivery_id,request_fingerprint,source_owner_id,source_companion_id,recipient_email,profile_snapshot,template_profiles,maintenance_requested,expires_at)
    VALUES (${id},${input.clientDeliveryId},${fingerprint},${ownerId},${input.companionId},${input.clientEmail},${profile},${templates},${input.maintenanceRequested},${expiresAt})
    ON CONFLICT(source_owner_id,client_delivery_id) DO NOTHING RETURNING id`;
  if (!inserted[0]) {
    const [winner] = await db`SELECT id,recipient_email,expires_at,maintenance_requested,request_fingerprint
      FROM companion_deliveries WHERE source_owner_id=${ownerId} AND client_delivery_id=${input.clientDeliveryId}`;
    if (!winner || winner.request_fingerprint !== fingerprint) throw new DeliveryConflict("This delivery identifier was already used with different details.");
    return { id: winner.id, clientEmail: winner.recipient_email, expiresAt: winner.expires_at, maintenanceRequested: winner.maintenance_requested };
  }
  const link = `${config.authUrl.replace(/\/$/, "")}/deliveries/${id}`;
  try {
    await sendInvite({ to: input.clientEmail, subject: `${String(source.name)} is ready for you`, text: `Sign in with ${input.clientEmail} to review and activate your independent Companion copy:\n\n${link}\n\nThe invitation expires in 14 days.` });
    await db`UPDATE companion_deliveries SET email_status=${config.smtpHost || mailOverride ? "sent" : "skipped"} WHERE id=${id}`;
  } catch {
    // The durable invitation remains pending for a later delivery retry.
  }
  return { id, clientEmail: input.clientEmail, expiresAt, maintenanceRequested: input.maintenanceRequested };
}

async function copyPortableTemplates(sql: any, ownerId: string, companionId: string, templates: unknown) {
  const [{ exists }] = await sql`SELECT to_regclass('public.agent_templates') IS NOT NULL AS exists`;
  if (!exists || !Array.isArray(templates)) return;
  for (const raw of templates) {
    const profile = z.object({ name: z.string().min(1).max(80), instructions: z.string().max(20_000), avatar: z.unknown().nullable(), maxChildren: z.number().int().min(1).max(20) }).parse(raw);
    const templateId = crypto.randomUUID();
    await sql`INSERT INTO agent_templates (id,owner_id,name,instructions,avatar,snapshot_name,source_companion_id) VALUES (${templateId},${ownerId},${profile.name},${profile.instructions},${profile.avatar},NULL,NULL)`;
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
    const profile = z.object({ name: z.string().min(1).max(80), instructions: z.string().max(20_000), avatar: z.unknown().nullable() }).parse(delivery.profile_snapshot);
    const companionId = crypto.randomUUID();
    const testMode = process.env.NODE_ENV !== "production" && process.env.BILLING_TEST_MODE === "1";
    if (!testMode && !config.boxTemplate) throw new DeliveryConflict("The fresh Box base template is not configured.");
    await sql`INSERT INTO companions (id,owner_id,name,instructions,provider,create_key,agent_secret) VALUES (${companionId},${ownerId},${profile.name},${profile.instructions},${testMode ? "local" : "box"},${crypto.randomUUID()},${encrypt(randomBytes(32).toString("hex"))})`;
    const [{ avatar_column }] = await sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='companions' AND column_name='avatar') AS avatar_column`;
    if (avatar_column && profile.avatar !== null) await sql.unsafe("UPDATE companions SET avatar=$1::jsonb WHERE id=$2", [JSON.stringify(profile.avatar), companionId]);
    await copyPortableTemplates(sql, ownerId, companionId, delivery.template_profiles);
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
      db`SELECT id,recipient_email AS "clientEmail",status,maintenance_requested AS "maintenanceRequested",expires_at AS "expiresAt",accepted_at AS "acceptedAt",delivered_companion_id AS "companionId" FROM companion_deliveries WHERE source_owner_id=${ownerId} ORDER BY created_at DESC`,
      db`SELECT id,profile_snapshot->>'name' AS name,status,maintenance_requested AS "maintenanceRequested",expires_at AS "expiresAt",accepted_at AS "acceptedAt",delivered_companion_id AS "companionId" FROM companion_deliveries WHERE recipient_email=${user.email} ORDER BY created_at DESC`,
    ]);
    return json({ sent, received });
  }
  if (url.pathname === "/api/deliveries" && request.method === "POST") {
    try {
      const delivery = await createDelivery(ownerId, await request.json());
      return delivery ? json({ delivery }, 201) : json({ error: "Companion not found." }, 404);
    } catch (error) {
      if (error instanceof DeliveryConflict) return json({ error: error.message }, 409);
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
      if (error instanceof DeliveryConflict || error instanceof ProductActivationRequired) return json({ error: error.message }, 409);
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
