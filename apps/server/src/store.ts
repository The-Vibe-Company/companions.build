import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { config, encrypt } from "./config";
export const db = new SQL(config.databaseUrl, { max: 8, connectionTimeout: 10 });
export async function migrate(sql = db) {
  const schema = await Bun.file(new URL("./schema.sql", import.meta.url)).text();
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(721440138)`;
    await tx.unsafe(schema);
  });
}
export const companionColumns = `id,name,instructions,provider,status,error,box_id AS "boxId",created_at AS "createdAt"`;
export async function listCompanions() { return db.unsafe(`SELECT ${companionColumns} FROM companions ORDER BY created_at,id`); }
export async function createCompanion(input: { name: string; instructions: string; provider: "local" | "box" }) {
  const id = crypto.randomUUID();
  await db`INSERT INTO companions (id,name,instructions,provider,create_key,agent_secret)
    VALUES (${id},${input.name},${input.instructions},${input.provider},${crypto.randomUUID()},${encrypt(randomBytes(32).toString("hex"))})`;
  return (await db.unsafe(`SELECT ${companionColumns} FROM companions WHERE id=$1`, [id]))[0];
}
export async function detail(id: string) {
  const [companion] = await db.unsafe(`SELECT ${companionColumns} FROM companions WHERE id=$1`, [id]);
  if (!companion) return null;
  const [messages, runs] = await Promise.all([
    db`SELECT id,role,content,created_at AS "createdAt",run_id AS "runId" FROM messages WHERE companion_id=${id} ORDER BY created_at,id`,
    db`SELECT id,status,error,created_at AS "createdAt",prepared_at AS "preparedAt",finished_at AS "finishedAt" FROM runs WHERE companion_id=${id} ORDER BY created_at,id`,
  ]);
  return { companion, messages, runs, activity: [] };
}
export class Conflict extends Error {}
export async function acceptMessage(companionId: string, clientMessageId: string, content: string) {
  return db.begin(async sql => {
    // Lock companion to serialize duplicate admission with cancellation and FIFO claims.
    const [companion] = await sql`SELECT id FROM companions WHERE id=${companionId} FOR UPDATE`;
    if (!companion) return null;
    const [existing] = await sql`SELECT id,content FROM runs WHERE companion_id=${companionId} AND client_message_id=${clientMessageId}`;
    if (existing) {
      if (existing.content !== content) throw new Conflict("This message identifier was already used with different content.");
      return existing.id as string;
    }
    const id = crypto.randomUUID();
    await sql`INSERT INTO runs (id,companion_id,client_message_id,content) VALUES (${id},${companionId},${clientMessageId},${content})`;
    await sql`INSERT INTO messages (id,companion_id,run_id,role,content) VALUES (${crypto.randomUUID()},${companionId},${id},'user',${content})`;
    return id;
  });
}
export async function cancel(companionId: string) {
  return db.begin(async sql => {
    const [companion] = await sql`SELECT id FROM companions WHERE id=${companionId} FOR UPDATE`;
    if (!companion) return false;
    await sql`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${companionId} AND status='queued'`;
    await sql`UPDATE runs SET cancel_requested=true WHERE companion_id=${companionId} AND status IN ('preparing','running')`;
    return true;
  });
}
