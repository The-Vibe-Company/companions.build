import { afterEach, beforeAll, expect, test } from "bun:test";
import { db, migrate, createCompanion, acceptMessage } from "../src/store";
import { acquireExecutor, claimQueuedRuns, tick } from "../src/executor";
import { createRoutine, updateRoutine, deleteRoutine, listRoutines, routineHistory, scheduleDueRoutines,
  migrateAutomations, enqueueBackground, nextRoutineFire, AutomationConflict } from "../src/automations";
import { encrypt } from "../src/config";

const owner="00000000-0000-4000-8000-000000000001";
const companions: string[] = [];
beforeAll(async () => { await migrate(); await migrateAutomations(); });
afterEach(async () => {
  for (const id of companions.splice(0)) {
    await db`UPDATE routines SET enabled=false,next_fire_at=null WHERE companion_id=${id}`;
    await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id} AND status IN ('queued','preparing','running')`;
  }
});
async function companion() {
  const row = await createCompanion(owner,{ name: "Automation fixture", instructions: "", provider: "local" });
  companions.push(row.id); return row.id as string;
}
async function leader() {
  const sql = await acquireExecutor();
  if (!sql) throw new Error("Test executor lock unavailable");
  return { sql, async close() { await sql`SELECT pg_advisory_unlock(721440139)`; sql.release(); } };
}

test("timezone calendars retain local wall time across DST and reject malformed schedules", () => {
  expect(nextRoutineFire("0 9 * * *", "Europe/Paris", new Date("2026-03-28T08:00:00Z")).toISOString()).toBe("2026-03-29T07:00:00.000Z");
  expect(nextRoutineFire("0 9 * * *", "Europe/Paris", new Date("2026-10-24T07:00:00Z")).toISOString()).toBe("2026-10-25T08:00:00.000Z");
  expect(() => nextRoutineFire("* * * * * *", "UTC")).toThrow("five-field");
  expect(() => nextRoutineFire("0 9 * * *", "Not/AZone")).toThrow("timezone");
});

test("concurrent scheduler ticks catch up only the latest missed occurrence and never wake a machine", async () => {
  const id = await companion();
  const routine = await createRoutine(id, { name: "Hourly", prompt: "Check status", cron: "0 * * * *", timezone: "UTC", enabled: true }, db, new Date("2026-01-01T06:00:00Z"));
  const now = new Date("2026-01-01T10:30:00Z");
  await Promise.all(Array.from({ length: 12 }, () => scheduleDueRoutines(db, now)));
  const rows = await db`SELECT * FROM runs WHERE companion_id=${id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ lane: "background", source: "routine", status: "queued", dispatched: false, content: "Check status" });
  expect(new Date(rows[0].scheduled_for).toISOString()).toBe("2026-01-01T10:00:00.000Z");
  const history = await routineHistory(id, routine.id);
  expect(history!.missed).toHaveLength(1);
  expect(new Date(history!.missed[0].firstScheduledFor).toISOString()).toBe("2026-01-01T07:00:00.000Z");
  expect(new Date(history!.missed[0].lastScheduledFor).toISOString()).toBe("2026-01-01T09:00:00.000Z");
  expect(new Date((await listRoutines(id))[0].nextFireAt).toISOString()).toBe("2026-01-01T11:00:00.000Z");
  const [machine] = await db`SELECT status,create_started_at FROM companions WHERE id=${id}`;
  expect(machine).toMatchObject({ status: "new", create_started_at: null });
});

test("routine updates preserve accepted identity and snapshots; foreign Companion edits fail closed", async () => {
  const id = await companion(), foreign = await companion();
  const routine = await createRoutine(id, { name: "Hourly", prompt: "Original", cron: "0 * * * *", timezone: "UTC", enabled: true }, db, new Date("2026-01-01T06:00:00Z"));
  await scheduleDueRoutines(db, new Date("2026-01-01T07:00:00Z"));
  const [accepted] = await db`SELECT * FROM runs WHERE companion_id=${id}`;
  expect(await updateRoutine(foreign, routine.id, { prompt: "Other user" })).toBeNull();
  expect(await deleteRoutine(foreign, routine.id)).toBe(false);
  expect(await routineHistory(foreign, routine.id)).toBeNull();
  await updateRoutine(id, routine.id, { prompt: "Changed" }, db, new Date("2026-01-01T07:10:00Z"));
  await scheduleDueRoutines(db, new Date("2026-01-01T07:30:00Z"));
  expect(Array.from(await db`SELECT id,content FROM runs WHERE companion_id=${id}`)).toEqual([{ id: accepted.id, content: "Original" }]);
  await updateRoutine(id, routine.id, { enabled: false });
  await scheduleDueRoutines(db, new Date("2026-01-01T12:00:00Z"));
  expect((await db`SELECT id FROM runs WHERE companion_id=${id}`)).toHaveLength(1);
  await updateRoutine(id, routine.id, { enabled: true }, db, new Date("2026-01-01T12:10:00Z"));
  expect(new Date((await listRoutines(id))[0].nextFireAt).toISOString()).toBe("2026-01-01T13:00:00.000Z");
  expect(await deleteRoutine(id, routine.id)).toBe(true);
  expect(await listRoutines(id)).toHaveLength(0);
  expect((await routineHistory(id, routine.id))!.runs).toHaveLength(1);
});

test("a rollback before a scheduler checkpoint creates neither task nor missed window", async () => {
  const id = await companion();
  const routine = await createRoutine(id, { name: "Hourly", prompt: "Original", cron: "0 * * * *", timezone: "UTC", enabled: true }, db, new Date("2026-01-01T06:00:00Z"));
  // Failure at the durable occurrence checkpoint also rolls back its preceding run insert.
  await db.unsafe(`CREATE OR REPLACE FUNCTION test_reject_occurrence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected checkpoint failure'; END $$;
    CREATE TRIGGER test_reject_occurrence BEFORE INSERT ON routine_occurrences FOR EACH ROW EXECUTE FUNCTION test_reject_occurrence()`);
  try { await expect(scheduleDueRoutines(db, new Date("2026-01-01T10:30:00Z"))).rejects.toThrow(); }
  finally { await db.unsafe("DROP TRIGGER test_reject_occurrence ON routine_occurrences; DROP FUNCTION test_reject_occurrence()"); }
  expect(await db`SELECT id FROM runs WHERE companion_id=${id}`).toHaveLength(0);
  expect((await routineHistory(id, routine.id))!.missed).toHaveLength(0);
  await scheduleDueRoutines(db, new Date("2026-01-01T10:30:00Z"));
  expect(await db`SELECT id FROM runs WHERE companion_id=${id}`).toHaveLength(1);
});

test("background sources dedupe durably and remain FIFO while main can steer", async () => {
  const id = await companion();
  const first = await enqueueBackground({ companionId: id, clientMessageId: crypto.randomUUID(), content: "First", source: "trigger" });
  await Bun.sleep(2);
  const key = crypto.randomUUID();
  const second = await enqueueBackground({ companionId: id, clientMessageId: key, content: "Second", source: "delegation" });
  expect(await enqueueBackground({ companionId: id, clientMessageId: key, content: "Second", source: "delegation" })).toBe(second);
  await expect(enqueueBackground({ companionId: id, clientMessageId: key, content: "Changed", source: "delegation" })).rejects.toBeInstanceOf(AutomationConflict);
  const main = await acceptMessage(owner,id, crypto.randomUUID(), "Chat");
  const lock = await leader();
  try {
    await claimQueuedRuns(lock.sql);
    const rows = await db`SELECT id,status FROM runs WHERE companion_id=${id}`;
    expect(rows.find((r: any) => r.id === first).status).toBe("preparing");
    expect(rows.find((r: any) => r.id === second).status).toBe("queued");
    expect(rows.find((r: any) => r.id === main).status).toBe("preparing");
    await db`UPDATE runs SET status='running',dispatched=true WHERE companion_id=${id} AND status='preparing'`;
    const steer = await acceptMessage(owner,id, crypto.randomUUID(), "While active");
    await claimQueuedRuns(lock.sql);
    expect((await db`SELECT status FROM runs WHERE id=${steer}`)[0].status).toBe("preparing");
    expect((await db`SELECT status FROM runs WHERE id=${second}`)[0].status).toBe("queued");
    await db`UPDATE runs SET status='interrupted',finished_at=now() WHERE id=${first}`;
    await claimQueuedRuns(lock.sql);
    expect((await db`SELECT status FROM runs WHERE id=${second}`)[0].status).toBe("preparing");
  } finally { await lock.close(); }
});

test("background results remain in activity unless publication was explicitly selected; recovery never redispatches", async () => {
  const id = await companion();
  const privateRun = await enqueueBackground({ companionId: id, clientMessageId: crypto.randomUUID(), content: "Private", source: "routine" });
  let publish = false, puts = 0;
  const daemon = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (req.method === "PUT") puts++;
    return Response.json({ status: "succeeded", text: publish ? "Publish result" : "Private result", publishToChat: publish });
  } });
  const lock = await leader();
  try {
    await db`UPDATE companions SET endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${id}`;
    await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${privateRun}`;
    await tick(lock.sql);
    expect((await db`SELECT result_text FROM runs WHERE id=${privateRun}`)[0].result_text).toBe("Private result");
    expect(await db`SELECT id FROM messages WHERE companion_id=${id}`).toHaveLength(0);
    publish = true;
    const publicRun = await enqueueBackground({ companionId: id, clientMessageId: crypto.randomUUID(), content: "Publish", source: "routine" });
    await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${publicRun}`;
    await tick(lock.sql); await tick(lock.sql);
    expect(Array.from(await db`SELECT content FROM messages WHERE companion_id=${id}`)).toEqual([{ content: "Publish result" }]);
    expect(puts).toBe(0);
  } finally { await lock.close(); daemon.stop(true); }
});
