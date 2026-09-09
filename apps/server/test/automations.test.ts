import { afterEach, beforeAll, expect, test } from "bun:test";
import { db, migrate, createCompanion, acceptMessage, detail } from "../src/store";
import { acquireExecutor, claimQueuedRuns, tick } from "../src/executor";
import { createRoutine, updateRoutine, deleteRoutine, listRoutines, routineHistory, scheduleDueRoutines,
  migrateAutomations, testRoutine, enqueueBackground, nextRoutineFire, requestRunResume, AutomationConflict } from "../src/automations";
import { encrypt } from "../src/config";
import { handleTasks } from "../src/tasks";
import { handleAutomations } from "../src/automation-routes";

const owner="00000000-0000-4000-8000-000000000001";
const companions: string[] = [];
beforeAll(async () => { await migrate(); await migrateAutomations(); });
afterEach(async () => {
  for (const id of companions.splice(0)) {
    await db`UPDATE routines SET enabled=false,next_fire_at=null WHERE companion_id=${id}`;
    await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id} AND status IN ('queued','preparing','running','needs_input')`;
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

test("human answers rejoin FIFO after already queued work and never replay their original prompt", async () => {
  const id = await companion();
  const waiting = await enqueueBackground({ companionId: id, clientMessageId: crypto.randomUUID(), content: "Need input", source: "routine" });
  await db`UPDATE runs SET status='needs_input',dispatched=true,started_at=now() WHERE id=${waiting}`;
  const queued = await enqueueBackground({ companionId: id, clientMessageId: crypto.randomUUID(), content: "Ahead of answer", source: "trigger" });
  await Bun.sleep(2);
  expect(await requestRunResume(id, waiting!)).toBe(true);
  const lock = await leader();
  const events: string[] = [];
  let remoteStatus = "needs_input";
  const daemon = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    events.push(`${req.method} ${path}`);
    if (path === "/health") return Response.json({ ready: true, activeRuns: { main: null, background: null } });
    if (path.endsWith("/resume")) remoteStatus = "running";
    return Response.json({ id: waiting, status: remoteStatus });
  } });
  try {
    await claimQueuedRuns(lock.sql);
    expect((await db`SELECT status FROM runs WHERE id=${queued}`)[0].status).toBe("preparing");
    expect((await db`SELECT status FROM runs WHERE id=${waiting}`)[0].status).toBe("needs_input");
    await db`UPDATE runs SET status='succeeded',finished_at=now() WHERE id=${queued}`;
    await db`UPDATE companions SET endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${id}`;
    await tick(lock.sql, { async observeRun(run) { events.push(`answer ${run.status}`); } });
    expect(events).toEqual([`GET /runs/${waiting}`, "GET /health", `POST /runs/${waiting}/resume`, "answer running"]);
    expect((await db`SELECT status,resume_requested_at FROM runs WHERE id=${waiting}`)[0]).toMatchObject({ status: "running", resume_requested_at: null });
  } finally { await lock.close(); daemon.stop(true); }
});

test("a parked run interrupted by daemon restart becomes terminal without a resume or prompt", async () => {
  const id = await companion();
  const waiting = await enqueueBackground({ companionId: id, clientMessageId: crypto.randomUUID(), content: "Need input", source: "routine" });
  await db`UPDATE runs SET status='needs_input',dispatched=true,started_at=now() WHERE id=${waiting}`;
  await requestRunResume(id, waiting!);
  const methods: string[] = [];
  const daemon = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { methods.push(req.method); return Response.json({ id: waiting, status: "interrupted" }); } });
  const lock = await leader();
  try {
    await db`UPDATE companions SET endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${id}`;
    await tick(lock.sql);
    expect((await db`SELECT status FROM runs WHERE id=${waiting}`)[0].status).toBe("interrupted");
    expect(methods).toEqual(["GET"]);
  } finally { await lock.close(); daemon.stop(true); }
});


test("manual routine tests preserve disabled schedules, deduplicate and reject deleted or foreign definitions", async () => {
  const id = await companion(), foreign = await companion();
  const routine = await createRoutine(id, {name: "Manual", prompt: "Check", cron: "0 * * * *", timezone: "UTC", enabled: false});
  const key = crypto.randomUUID();
  const run = await testRoutine(id, routine.id, key);
  expect(run).toBeString();
  expect(await testRoutine(id, routine.id, key)).toBe(run);
  expect(await testRoutine(foreign, routine.id, crypto.randomUUID())).toBeNull();
  expect((await listRoutines(id))[0]).toMatchObject({enabled: false, nextFireAt: null});
  await deleteRoutine(id, routine.id);
  expect(await testRoutine(id, routine.id, crypto.randomUUID())).toBeNull();
  const response = await handleAutomations(new Request(`http://local/api/companions/${id}/routines/${routine.id}/test`, {
    method: 'POST', body: JSON.stringify({clientMessageId: crypto.randomUUID()}),
  }), owner);
  expect(response!.status).toBe(404);
  expect(await db`SELECT id FROM runs WHERE companion_id=${id}`).toHaveLength(1);
});


test("manual admission waits for a concurrent deletion and observes its committed result", async () => {
  const id = await companion();
  const routine = await createRoutine(id, {name: "Delete race", prompt: "Check", cron: "0 * * * *", timezone: "UTC", enabled: false});
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const ready = new Promise<void>(resolve => {locked = resolve;});
  const deletion = db.begin(async tx => {
    await deleteRoutine(id, routine.id, tx);
    locked();
    await gate;
  });
  await ready;
  const admission = testRoutine(id, routine.id, crypto.randomUUID());
  release();
  await deletion;
  expect(await admission).toBeNull();
  expect(await db`SELECT id FROM runs WHERE companion_id=${id}`).toHaveLength(0);
});


test("retiring and retired companions cannot accumulate routine or other background work", async () => {
  for (const retired of [false, true]) {
    const id = await companion();
    const input = {name: "Hourly", prompt: "Check", cron: "0 * * * *", timezone: "UTC", enabled: true};
    const routine = await createRoutine(id, input, db, new Date("2026-01-01T06:00:00Z"));
    await db`UPDATE companions SET archive_requested_at=now(),retired_at=${retired ? new Date() : null} WHERE id=${id}`;
    expect(await scheduleDueRoutines(db, new Date("2026-01-01T10:30:00Z"))).toBe(0);
    expect(await testRoutine(id, routine.id, crypto.randomUUID())).toBeNull();
    expect(await createRoutine(id, input)).toBeNull();
    for (const source of ['routine', 'trigger', 'delegation'] as const) {
      expect(await enqueueBackground({companionId: id, clientMessageId: crypto.randomUUID(), content: "Check", source})).toBeNull();
    }
    expect(await db`SELECT id FROM runs WHERE companion_id=${id}`).toHaveLength(0);
    expect((await routineHistory(id, routine.id))!.missed).toHaveLength(0);
  }
});

test('answering a question preserves its displayed context across resume and duplicate answers', async () => {
  const id = await companion();
  const runId = await acceptMessage(owner,id,crypto.randomUUID(),'Prepare a specialist');
  await db`UPDATE runs SET status='needs_input',preview_text='I have prepared the role. Choose a language.' WHERE id=${runId}`;
  const questionId = crypto.randomUUID();
  await db`INSERT INTO task_questions(id,companion_id,run_id,question,options) VALUES(${questionId},${id},${runId},'Which language?',${['French','English']}::jsonb)`;
  const answer = () => handleAutomations(new Request(`http://localhost/api/companions/${id}/questions/${questionId}/answer`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answer:'French'})}),owner);
  expect((await answer())!.status).toBe(200);
  await db`UPDATE runs SET preview_text='Now testing in French' WHERE id=${runId}`;
  expect((await answer())!.status).toBe(200);
  const [saved] = await db`SELECT answer,context_text FROM task_questions WHERE id=${questionId}`;
  expect(saved).toMatchObject({answer:'French',context_text:'I have prepared the role. Choose a language.'});
});

test('routine publication settings preserve omitted patches and admission snapshots including manual history', async () => {
  const id = await companion();
  const routine = await createRoutine(id, {name:'Original',prompt:'Check',cron:'0 * * * *',timezone:'UTC',enabled:true,publicationMode:'always'}, db, new Date('2026-01-01T06:00:00Z'));
  const key = crypto.randomUUID();
  const manual = await testRoutine(id,routine.id,key);
  const other = await createRoutine(id,{name:'Other',prompt:'Check',cron:'0 * * * *',timezone:'UTC',enabled:false});
  await expect(testRoutine(id,other.id,key)).rejects.toBeInstanceOf(AutomationConflict);
  await scheduleDueRoutines(db,new Date('2026-01-01T07:00:00Z'));
  expect((await updateRoutine(id,routine.id,{name:'Renamed'})).publicationMode).toBe('always');
  await updateRoutine(id,routine.id,{publicationMode:'silent'});
  await deleteRoutine(id,routine.id);
  const history = await routineHistory(id,routine.id);
  expect(history!.runs).toHaveLength(2);
  for(const run of history!.runs) expect(run).toMatchObject({routineId:routine.id,routineName:'Original',publicationMode:'always'});
  expect(history!.runs.find((run:any)=>run.id===manual).scheduledFor).toBeNull();
  const snapshot={routineId:routine.id,routineName:'Original',publicationMode:'always',scheduledFor:null};
  expect((await detail(owner,id))!.runs.find((run:any)=>run.id===manual)).toMatchObject(snapshot);
  const response=await handleTasks(new Request(`http://local/api/companions/${id}/tasks/${manual}`),owner);
  expect((await response!.json()).task).toMatchObject(snapshot);
  await expect(createRoutine(id,{name:'Invalid',prompt:'Check',cron:'0 * * * *',timezone:'UTC',publicationMode:'invalid' as any})).rejects.toThrow();
});

test('routine publication modes settle once on recovered success and preserve private results', async () => {
  const id = await companion();
  let publish = false, puts = 0;
  const daemon = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
    if(req.method==='PUT')puts++;
    return Response.json({status:'succeeded',text:'Useful result',publishToChat:publish});
  }});
  const lock = await leader();
  try {
    await db`UPDATE companions SET endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${id}`;
    for(const mode of ['auto','always','silent'] as const){
      for(const requested of [false,true]){
        publish=requested;
        const routine=await createRoutine(id,{name:mode,prompt:'Check',cron:'0 * * * *',timezone:'UTC',enabled:false,publicationMode:mode});
        const run=await testRoutine(id,routine.id,crypto.randomUUID());
        // A later edit must not change the policy of already accepted work.
        await updateRoutine(id,routine.id,{publicationMode:mode==='silent'?'always':'silent'});
        await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${run}`;
        await tick(lock.sql);await tick(lock.sql);
        const expected=mode==='always'||mode==='auto'&&requested;
        expect((await db`SELECT result_text,publish_to_chat,status FROM runs WHERE id=${run}`)[0]).toMatchObject({status:'succeeded',result_text:'Useful result',publish_to_chat:expected});
        expect(await db`SELECT id FROM messages WHERE run_id=${run}`).toHaveLength(expected?1:0);
      }
    }
    expect(puts).toBe(0);
  } finally {await lock.close();daemon.stop(true);}
});
