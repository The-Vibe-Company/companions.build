import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { config, encrypt } from "./config";
export const db = new SQL(config.databaseUrl, { max: 8, connectionTimeout: 10 });
export async function migrate(sql = db) {
  const schema = await Bun.file(new URL("./schema.sql", import.meta.url)).text();
  const authSchema = await Bun.file(new URL("./auth-schema.sql", import.meta.url)).text();
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(721440138)`;
    await tx.unsafe(schema);
    await tx.unsafe(authSchema);
    for (const name of ["product.sql", "plugins.sql", "storage-schema.sql", "automations.sql"]) await tx.unsafe(await Bun.file(new URL(`./${name}`,import.meta.url)).text());
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
  });
}
export const companionColumns = `id,name,instructions,avatar,provider,status,error,box_id AS "boxId",created_at AS "createdAt"`;
export async function listCompanions(ownerId: string) { return db.unsafe(`SELECT ${companionColumns} FROM companions WHERE owner_id=$1 AND retired_at IS NULL AND NOT temporary ORDER BY created_at,id`, [ownerId]); }
export async function createCompanion(ownerId: string, input: { name: string; instructions: string; provider: "local" | "box"; avatar?: {shape:number;color:number;face:number} }) {
  const id = crypto.randomUUID();
  await db`INSERT INTO companions (id,owner_id,name,instructions,provider,create_key,agent_secret,avatar)
    VALUES (${id},${ownerId},${input.name},${input.instructions},${input.provider},${crypto.randomUUID()},${encrypt(randomBytes(32).toString("hex"))},${input.avatar??{shape:0,color:0,face:0}})`;
  return (await db.unsafe(`SELECT ${companionColumns} FROM companions WHERE id=$1 AND owner_id=$2`, [id, ownerId]))[0];
}
export async function detail(ownerId: string, id: string) {
  const [companion] = await db.unsafe(`SELECT ${companionColumns} FROM companions WHERE id=$1 AND owner_id=$2`, [id, ownerId]);
  if (!companion) return null;
  const [messages, runs] = await Promise.all([
    db`SELECT id,role,content,created_at AS "createdAt",run_id AS "runId" FROM messages WHERE companion_id=${id} ORDER BY created_at,id`,
    db`SELECT id,status,error,lane,source,result_text AS "resultText",publish_to_chat AS "publishToChat",response_root_id AS "responseRootId",created_at AS "createdAt",prepared_at AS "preparedAt",finished_at AS "finishedAt" FROM runs WHERE companion_id=${id} ORDER BY created_at,id`,
  ]);
  return { companion, messages, runs, activity: runs.filter((run:any)=>run.lane === "background") };
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
    await sql`UPDATE runs SET cancel_requested=true WHERE companion_id=${companionId} AND lane='main' AND status IN ('preparing','running')`;
    return true;
  });
}
