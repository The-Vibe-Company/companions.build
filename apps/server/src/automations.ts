import { CronExpressionParser } from "cron-parser";
import { createHash } from "node:crypto";
import { db } from "./store";
import { z } from "zod";
import type { SQL, ReservedSQL } from "bun";

type Database = SQL | ReservedSQL;
export class AutomationConflict extends Error {}
const routineBase = z.object({
  name: z.string().trim().min(1).max(100), prompt: z.string().trim().min(1).max(50_000),
  enabled: z.boolean().default(true),
});
export const routineInput = z.union([
  routineBase.extend({
    cron: z.string().trim().min(1).max(100), timezone: z.string().trim().min(1).max(100),
    runAt: z.never().optional(),
  }).strict(),
  routineBase.extend({
    runAt: z.iso.datetime({ offset: true }), cron: z.never().optional(), timezone: z.never().optional(),
  }).strict(),
]);
// Patch omission must preserve the stored enabled state; creation defaults are not patch values.
export const routinePatchInput = z.object({
  name: z.string().trim().min(1).max(100).optional(), prompt: z.string().trim().min(1).max(50_000).optional(),
  cron: z.string().trim().min(1).max(100).optional(), timezone: z.string().trim().min(1).max(100).optional(),
  runAt: z.iso.datetime({ offset: true }).optional(), enabled: z.boolean().optional(),
}).strict().superRefine((value,context)=>{
  if (value.runAt !== undefined && (value.cron !== undefined || value.timezone !== undefined)) {
    context.addIssue({code:'custom',message:'Choose runAt or cron and timezone, not both.'});
  }
});
export type RoutineInput = z.infer<typeof routineInput>;
export type RoutinePatchInput = z.infer<typeof routinePatchInput>;

export async function migrateAutomations(sql: Database = db) {
  const migration = await Bun.file(new URL("./automations.sql", import.meta.url)).text();
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(721440138)`;
    await tx.unsafe(migration);
  });
}

export function nextRoutineFire(cron: string, timezone: string, after = new Date()): Date {
  if (cron.split(/\s+/).length !== 5 || /[\r\n]/.test(cron)) throw new Error("Use a five-field cron schedule.");
  try { Intl.DateTimeFormat("en", { timeZone: timezone }).format(after); }
  catch { throw new Error("Choose a valid IANA timezone."); }
  try { return CronExpressionParser.parse(cron, { tz: timezone, currentDate: after }).next().toDate(); }
  catch { throw new Error("Choose a valid cron schedule."); }
}

const routineColumns = `id,companion_id AS "companionId",name,prompt,cron,timezone,run_at AS "runAt",enabled,
  next_fire_at AS "nextFireAt",last_run_status AS "lastRunStatus",last_error AS "lastError",
  created_at AS "createdAt",updated_at AS "updatedAt"`;

function parsedRunAt(value: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error('Choose a valid run time.');
  return result;
}

function routineNext(input: RoutineInput, now: Date): Date {
  return input.runAt !== undefined ? parsedRunAt(input.runAt) : nextRoutineFire(input.cron,input.timezone,now);
}

/** Callers authorize the Companion first; every query still carries its exact identity. */
export async function listRoutines(companionId: string, sql: Database = db) {
  return sql.unsafe(`SELECT ${routineColumns} FROM routines WHERE companion_id=$1 AND deleted_at IS NULL ORDER BY created_at,id`, [companionId]);
}
export async function createRoutine(companionId: string, value: RoutineInput, sql: Database = db, now = new Date()) {
  const input = routineInput.parse(value);
  const next = routineNext(input,now);
  const recurring = 'cron' in input;
  const id = crypto.randomUUID();
  return sql.begin(async tx => {
    const [companion] = await tx`SELECT id FROM companions WHERE id=${companionId} AND retired_at IS NULL AND archive_requested_at IS NULL FOR UPDATE`;
    if (!companion) return null;
    await tx`INSERT INTO routines(id,companion_id,name,prompt,cron,timezone,run_at,enabled,next_fire_at)
      VALUES(${id},${companionId},${input.name},${input.prompt},${recurring ? input.cron : null},${recurring ? input.timezone : null},${recurring ? null : parsedRunAt(input.runAt)},${input.enabled},${input.enabled ? next : null})`;
    return (await tx.unsafe(`SELECT ${routineColumns} FROM routines WHERE companion_id=$1 AND id=$2`, [companionId,id]))[0];
  });
}
export async function updateRoutine(companionId: string, id: string, value: RoutinePatchInput, sql: Database = db, now = new Date()) {
  const patch = routinePatchInput.parse(value);
  return sql.begin(async tx => {
    const [current] = await tx`SELECT * FROM routines WHERE companion_id=${companionId} AND id=${id} AND deleted_at IS NULL FOR UPDATE`;
    if (!current) return null;
    const common = {name:patch.name??current.name,prompt:patch.prompt??current.prompt,enabled:patch.enabled??current.enabled};
    let candidate: unknown;
    if (patch.runAt !== undefined) candidate={...common,runAt:patch.runAt};
    else if (patch.cron !== undefined || patch.timezone !== undefined) candidate={...common,cron:patch.cron??current.cron,timezone:patch.timezone??current.timezone};
    else candidate=current.run_at?{...common,runAt:new Date(current.run_at).toISOString()}:{...common,cron:current.cron,timezone:current.timezone};
    const input = routineInput.parse(candidate);
    const recurring = 'cron' in input;
    const runAt = recurring ? null : parsedRunAt(input.runAt);
    const next = routineNext(input,now);
    const scheduleChanged = (recurring ? input.cron : null) !== current.cron ||
      (recurring ? input.timezone : null) !== current.timezone ||
      (runAt?.getTime()??null) !== (current.run_at ? new Date(current.run_at).getTime() : null);
    const rescheduled = scheduleChanged || input.enabled !== current.enabled;
    await tx`UPDATE routines SET name=${input.name},prompt=${input.prompt},cron=${recurring ? input.cron : null},timezone=${recurring ? input.timezone : null},run_at=${runAt},
      enabled=${input.enabled},next_fire_at=${input.enabled ? (rescheduled ? next : current.next_fire_at) : null},last_run_status=${scheduleChanged ? null : current.last_run_status},last_error=${scheduleChanged ? null : current.last_error},updated_at=${now}
      WHERE companion_id=${companionId} AND id=${id}`;
    return (await tx.unsafe(`SELECT ${routineColumns} FROM routines WHERE companion_id=$1 AND id=$2`, [companionId,id]))[0];
  });
}
export async function deleteRoutine(companionId: string, id: string, sql: Database = db) {
  const rows = await sql`UPDATE routines SET enabled=false,next_fire_at=null,deleted_at=now(),updated_at=now()
    WHERE companion_id=${companionId} AND id=${id} AND deleted_at IS NULL RETURNING id`;
  return rows.length > 0;
}
/** Serialize manual admission with deletion so a removed routine cannot create new work.
 * Disabled routines remain testable without changing their schedule. */
export async function testRoutine(companionId: string, routineId: string, clientMessageId: string, sql: Database = db) {
  return sql.begin(async tx => {
    // Companion first, matching retirement and ordinary background admission.
    const [companion] = await tx`SELECT id FROM companions WHERE id=${companionId} AND retired_at IS NULL AND archive_requested_at IS NULL FOR UPDATE`;
    if (!companion) return null;
    const [routine] = await tx`SELECT prompt FROM routines WHERE companion_id=${companionId}
      AND id=${routineId} AND deleted_at IS NULL FOR UPDATE`;
    if (!routine) return null;
    return enqueueBackgroundInTransaction({companionId, clientMessageId, content: routine.prompt, source: 'routine'}, tx);
  });
}

export async function routineHistory(companionId: string, id: string, sql: Database = db) {
  const [routine] = await sql`SELECT id FROM routines WHERE companion_id=${companionId} AND id=${id}`;
  if (!routine) return null;
  const [runs, missed] = await Promise.all([
    sql`SELECT r.id,r.status,r.result_text AS "resultText",r.error,o.scheduled_for AS "scheduledFor",o.accepted_at AS "acceptedAt"
      FROM routine_occurrences o JOIN runs r ON r.id=o.run_id WHERE o.routine_id=${id} AND r.companion_id=${companionId}
      ORDER BY o.scheduled_for DESC LIMIT 100`,
    sql`SELECT first_scheduled_for AS "firstScheduledFor",last_scheduled_for AS "lastScheduledFor",cron,timezone
      FROM routine_missed_windows WHERE routine_id=${id} ORDER BY first_scheduled_for DESC LIMIT 100`,
  ]);
  return { runs, missed };
}

export type BackgroundInput={companionId:string;clientMessageId:string;content:string;source:'routine'|'trigger'|'delegation'};
export async function enqueueBackground(input:BackgroundInput,sql:Database=db):Promise<string|null>{
 return sql.begin(tx=>enqueueBackgroundInTransaction(input,tx));
}
/** Caller owns the transaction, allowing admission and its audit record to commit together. */
export async function enqueueBackgroundInTransaction(input:BackgroundInput,tx:Database):Promise<string|null>{
 if(!input.content.trim()||input.content.length>50_000)throw Error('Task content is invalid.');
    const [companion] = await tx`SELECT id FROM companions WHERE id=${input.companionId} AND retired_at IS NULL AND archive_requested_at IS NULL FOR UPDATE`;
    if (!companion) return null;
    const [existing] = await tx`SELECT id,content,lane,source FROM runs
      WHERE companion_id=${input.companionId} AND client_message_id=${input.clientMessageId}`;
    if (existing) {
      if (existing.content !== input.content || existing.lane !== "background" || existing.source !== input.source) throw new AutomationConflict("Task identifier is already used.");
      return existing.id;
    }
    const id = crypto.randomUUID();
    await tx`INSERT INTO runs(id,companion_id,client_message_id,content,lane,source)
      VALUES(${id},${input.companionId},${input.clientMessageId},${input.content},'background',${input.source})`;
    return id;
}

/** The answer is already durable in the control bridge. It joins the ordinary FIFO at this
 * instant; the executor reserves the slot and resumes Pi before releasing the tool result. */
export async function requestRunResume(companionId: string, runId: string, sql: Database = db) {
  const rows = await sql`UPDATE runs SET resume_requested_at=COALESCE(resume_requested_at,now())
    WHERE companion_id=${companionId} AND id=${runId} AND status IN ('running','needs_input') RETURNING id`;
  return rows.length > 0;
}

/** A scheduler transaction records both missed instants and the one accepted occurrence.
 * Competing schedulers skip locked definitions; restart cannot duplicate an accepted run. */
export async function scheduleDueRoutines(sql: Database = db, now = new Date()): Promise<number> {
  return sql.begin(async tx => {
    const due = await tx`SELECT r.* FROM routines r JOIN companions c ON c.id=r.companion_id
      WHERE r.enabled AND r.deleted_at IS NULL AND r.next_fire_at<=${now}
        AND c.retired_at IS NULL AND c.archive_requested_at IS NULL
      ORDER BY r.next_fire_at,r.id LIMIT 50 FOR UPDATE OF r,c SKIP LOCKED`;
    for (const routine of due) {
      const first = new Date(routine.next_fire_at);
      let latest = first;
      if (routine.run_at === null) {
        // prev is exclusive: +1ms includes an occurrence exactly at the scheduler's instant.
        latest = CronExpressionParser.parse(routine.cron, { tz: routine.timezone, currentDate: new Date(now.getTime()+1) }).prev().toDate();
        if (latest < first) throw new Error("Routine schedule checkpoint is inconsistent.");
        if (latest > first) {
          const lastMissed = CronExpressionParser.parse(routine.cron, { tz: routine.timezone, currentDate: latest }).prev().toDate();
          await tx`INSERT INTO routine_missed_windows(routine_id,first_scheduled_for,last_scheduled_for,cron,timezone,recorded_at)
            VALUES(${routine.id},${first},${lastMissed},${routine.cron},${routine.timezone},${now}) ON CONFLICT DO NOTHING`;
        }
      }
      const runId = routineRunId(routine.id, latest);
      await tx`INSERT INTO runs(id,companion_id,client_message_id,content,lane,source,routine_id,scheduled_for)
        VALUES(${runId},${routine.companion_id},${runId},${routine.prompt},'background','routine',${routine.id},${latest})
        ON CONFLICT(companion_id,client_message_id) DO NOTHING`;
      await tx`INSERT INTO routine_occurrences(routine_id,scheduled_for,run_id,prompt,cron,timezone,run_at,accepted_at)
        VALUES(${routine.id},${latest},${runId},${routine.prompt},${routine.cron},${routine.timezone},${routine.run_at},${now}) ON CONFLICT DO NOTHING`;
      await tx`UPDATE routines SET enabled=${routine.run_at === null},next_fire_at=${routine.run_at === null ? nextRoutineFire(routine.cron,routine.timezone,now) : null},updated_at=${now} WHERE id=${routine.id}`;
    }
    return due.length;
  });
}

export function routineRunId(routineId: string, scheduledFor: Date): string {
  const bytes = createHash("sha256").update(`companions.build:routine:v1:${routineId}:${scheduledFor.toISOString()}`).digest().subarray(0,16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
