import { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { config, encrypt } from "./config";
export const db = new SQL(config.databaseUrl, { max: 8, connectionTimeout: 10 });
const migrationNames = ["schema.sql", "auth-schema.sql", "product.sql", "plugins.sql", "storage-schema.sql", "automations.sql", "triggers.sql", "lifecycle.sql", "software.sql", "desktop.sql", "box-observation.sql", "billing.sql", "delivery.sql", "maintenance.sql", "delivery-skills.sql", "events.sql"] as const;

async function migrationFiles() {
  return Promise.all(migrationNames.map(async name => ({ name, sql: await Bun.file(new URL(`./${name}`, import.meta.url)).text() })));
}

export async function migrationFingerprint() {
  const files = await migrationFiles();
  return createHash("sha256").update(files.map(file => `${file.name}\0${file.sql}\0`).join("")).digest("hex");
}

export async function migrate(sql = db) {
  const files = await migrationFiles();
  const fingerprint = createHash("sha256").update(files.map(file => `${file.name}\0${file.sql}\0`).join("")).digest("hex");
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(721440138)`;
    const [stateTable] = await tx`SELECT to_regclass('public.companions_schema_state') AS name`;
    if (stateTable.name) {
      const [state] = await tx`SELECT fingerprint FROM companions_schema_state WHERE singleton=true`;
      if (state?.fingerprint === fingerprint) return { applied: false, fingerprint };
    }
    for (const file of files) await tx.unsafe(file.sql);
    const localId = "00000000-0000-4000-8000-000000000001";
    if (process.env.NODE_ENV !== "production") {
      await tx`INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
        VALUES (${localId},${"Local developer"},${config.localDevEmail},true,now(),now())
        ON CONFLICT ("id") DO NOTHING`;
    }
    const [{ count }] = await tx`SELECT count(*)::int AS count FROM companions WHERE owner_id IS NULL`;
    if (count > 0) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("Existing Companions have no owner; assign owner_id before starting hosted mode");
      }
      await tx`UPDATE companions SET owner_id=${localId} WHERE owner_id IS NULL`;
    }
    await tx`ALTER TABLE companions ALTER COLUMN owner_id SET NOT NULL`;
    await tx`CREATE TABLE IF NOT EXISTS companions_schema_state (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      fingerprint text NOT NULL,
      migrated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await tx`INSERT INTO companions_schema_state (singleton,fingerprint,migrated_at) VALUES (true,${fingerprint},now())
      ON CONFLICT (singleton) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,migrated_at=EXCLUDED.migrated_at`;
    return { applied: true, fingerprint };
  });
}

export async function assertMigrated(sql = db) {
  const fingerprint = await migrationFingerprint();
  const [stateTable] = await sql`SELECT to_regclass('public.companions_schema_state') AS name`;
  if (!stateTable.name) throw new Error("Database schema has not been prepared; run bun run migrate before starting services");
  const [state] = await sql`SELECT fingerprint FROM companions_schema_state WHERE singleton=true`;
  if (state?.fingerprint !== fingerprint) throw new Error("Database schema is stale; run bun run migrate before starting services");
  return fingerprint;
}

export async function migrateForService(sql = db) {
  if (process.env.COMPANIONS_SCHEMA_PREPARED === "1") {
    await assertMigrated(sql);
    return;
  }
  await migrate(sql);
}
export const companionColumns = `id,name,instructions,avatar,model_id AS "modelId",provider,status,error,desktop_taken AS "desktopTaken",desktop_paused_at AS "desktopPausedAt",prepare_requested AS "prepareRequested",ready_at AS "readyAt",parent_id AS "parentId",template_id AS "templateId",template_revision AS "templateRevision",retired_at AS "retiredAt",temporary,box_id AS "boxId",created_at AS "createdAt"`;
export async function listCompanions(ownerId: string) { return db.unsafe(`SELECT ${companionColumns} FROM companions WHERE owner_id=$1 AND retired_at IS NULL AND NOT temporary ORDER BY created_at,id`, [ownerId]); }
export async function createCompanion(ownerId: string, input: { name: string; instructions?: string; provider: "local" | "box"; prepare?:boolean; avatar?: {shape:number;color:number;face:number}; templateId?:string; templateRevision?:number; clientCreationId?:string }) {
  const fingerprint=input.clientCreationId?createHash("sha256").update(JSON.stringify({name:input.name,instructions:input.instructions??null,provider:input.provider,prepare:input.prepare??false,avatar:input.avatar??null,templateId:input.templateId??null,templateRevision:input.templateRevision??null})).digest("hex"):null;
  return db.begin(async sql => {
    if(input.clientCreationId){
      const [prior]=await sql`SELECT creation_fingerprint FROM companions WHERE owner_id=${ownerId} AND client_creation_id=${input.clientCreationId}`;
      if(prior){
        if(prior.creation_fingerprint!==fingerprint)throw new Conflict("This creation identifier was already used with different details.");
        return (await sql.unsafe(`SELECT ${companionColumns} FROM companions WHERE owner_id=$1 AND client_creation_id=$2`,[ownerId,input.clientCreationId]))[0];
      }
    }
    let template:any;
    if(input.templateId){
      [template]=await sql`SELECT r.* FROM template_revisions r JOIN agent_templates t ON t.id=r.template_id AND t.owner_id=r.owner_id
        WHERE t.id=${input.templateId} AND t.owner_id=${ownerId} AND r.revision=COALESCE(${input.templateRevision??null},t.revision)`;
      if(!template)throw new Conflict("Template or revision unavailable.");
      if(template.snapshot_name&&input.provider!=="box")throw new Conflict("This prepared template requires Box.");
    } else if(input.templateRevision)throw new Conflict("A template is required for a revision.");
    const id = crypto.randomUUID();
    const inserted=await sql`INSERT INTO companions (id,owner_id,name,instructions,provider,create_key,agent_secret,avatar,prepare_requested,template_id,template_revision,snapshot_name,model_id,client_creation_id,creation_fingerprint)
      VALUES (${id},${ownerId},${input.name},${input.instructions??template?.instructions??""},${input.provider},${crypto.randomUUID()},${encrypt(randomBytes(32).toString("hex"))},${input.avatar??template?.avatar??{shape:0,color:0,face:0}},${input.prepare??false},${input.templateId??null},${template?.revision??null},${template?.snapshot_name??null},${template?.model_id??null},${input.clientCreationId??null},${fingerprint})
      ON CONFLICT(owner_id,client_creation_id) WHERE client_creation_id IS NOT NULL DO NOTHING RETURNING id`;
    if(!inserted.length){
      const [winner]=await sql`SELECT creation_fingerprint FROM companions WHERE owner_id=${ownerId} AND client_creation_id=${input.clientCreationId}`;
      if(!winner||winner.creation_fingerprint!==fingerprint)throw new Conflict("This creation identifier was already used with different details.");
      return (await sql.unsafe(`SELECT ${companionColumns} FROM companions WHERE owner_id=$1 AND client_creation_id=$2`,[ownerId,input.clientCreationId!]))[0];
    }
    return (await sql.unsafe(`SELECT ${companionColumns} FROM companions WHERE id=$1 AND owner_id=$2`, [id, ownerId]))[0];
  });
}
export async function detail(ownerId: string, id: string) {
  const [companion] = await db.unsafe(`SELECT ${companionColumns} FROM companions WHERE id=$1 AND owner_id=$2`, [id, ownerId]);
  if (!companion) return null;
  const [messages, runs, specialists] = await Promise.all([
    db`SELECT id,role,content,created_at AS "createdAt",run_id AS "runId" FROM messages WHERE companion_id=${id} ORDER BY created_at,id`,
    db`SELECT id,status,error,lane,source,result_text AS "resultText",preview_text AS "previewText",publish_to_chat AS "publishToChat",response_root_id AS "responseRootId",created_at AS "createdAt",prepared_at AS "preparedAt",finished_at AS "finishedAt" FROM runs WHERE companion_id=${id} ORDER BY created_at,id`,
    db`SELECT d.id AS "delegationId",d.parent_run_id AS "parentRunId",d.run_id AS "childRunId",
      jsonb_build_object('id',child.id,'name',child.name,'avatar',child.avatar,'status',child.status,'retiredAt',child.retired_at) AS companion
      FROM delegations d
      JOIN companions parent ON parent.id=d.parent_id AND parent.owner_id=${ownerId}
      JOIN runs parent_run ON parent_run.id=d.parent_run_id AND parent_run.companion_id=parent.id
      JOIN companions child ON child.id=d.target_id AND child.owner_id=parent.owner_id AND child.parent_id=parent.id AND child.temporary
      WHERE d.parent_id=${id} AND d.parent_run_id IS NOT NULL
      ORDER BY d.created_at,d.id`,
  ]);
  return { companion, messages, runs, specialists, activity: runs.filter((run:any)=>run.lane === "background") };
}
export class Conflict extends Error {}
export async function acceptMessage(ownerId: string, companionId: string, clientMessageId: string, content: string, attachmentCount = 0) {
  return db.begin(async sql => {
    // Lock companion to serialize duplicate admission with cancellation and FIFO claims.
    const [companion] = await sql`SELECT id FROM companions WHERE id=${companionId} AND owner_id=${ownerId} FOR UPDATE`;
    if (!companion) return null;
    const [existing] = await sql`SELECT id,content,attachment_count FROM runs WHERE companion_id=${companionId} AND client_message_id=${clientMessageId}`;
    if (existing) {
      if (existing.content !== content || existing.attachment_count !== attachmentCount) throw new Conflict("This message identifier was already used with different content or attachments.");
      return existing.id as string;
    }
    const id = crypto.randomUUID();
    await sql`INSERT INTO runs (id,companion_id,client_message_id,content,attachment_count) VALUES (${id},${companionId},${clientMessageId},${content},${attachmentCount})`;
    await sql`INSERT INTO messages (id,companion_id,run_id,role,content) VALUES (${crypto.randomUUID()},${companionId},${id},'user',${content})`;
    return id;
  });
}
export async function cancel(ownerId: string, companionId: string) {
  return db.begin(async sql => {
    const [companion] = await sql`SELECT id FROM companions WHERE id=${companionId} AND owner_id=${ownerId} FOR UPDATE`;
    if (!companion) return false;
    await sql`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${companionId} AND lane='main' AND status='queued'`;
    await sql`UPDATE runs SET cancel_requested=true WHERE companion_id=${companionId} AND lane='main' AND status IN ('preparing','running','needs_input')`;
    return true;
  });
}
