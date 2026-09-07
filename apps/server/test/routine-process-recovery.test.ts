import { beforeAll, expect, test } from 'bun:test';
import { db, migrate, createCompanion } from '../src/store';
import { createRoutine, routineHistory } from '../src/automations';

beforeAll(migrate);

/** A real process dies while PostgreSQL is inside the occurrence checkpoint, then
 * after commit but before its caller can acknowledge completion. No Box is contacted. */
test('scheduler process death rolls back incomplete admission and preserves committed occurrence identity', async () => {
  const companion = await createCompanion('00000000-0000-4000-8000-000000000001', {
    name: 'Scheduler process recovery', instructions: '', provider: 'local',
  });
  const routine = await createRoutine(companion.id, {
    name: 'Hourly crash fixture', prompt: 'Retain one occurrence', cron: '0 * * * *', timezone: 'UTC', enabled: true,
  }, db, new Date('2026-01-01T06:00:00Z'));
  const gate = await db.reserve();
  const key = 721449601;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const child = async () => {
    const program = `
      import {db} from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};
      import {scheduleDueRoutines} from ${JSON.stringify(new URL('../src/automations.ts', import.meta.url).href)};
      const sql=await db.reserve();
      console.log(JSON.stringify({pid:(await sql\`SELECT pg_backend_pid() AS pid\`)[0].pid}));
      try {
        const count=await scheduleDueRoutines(sql,new Date('2026-01-01T10:30:00Z'));
        console.log(JSON.stringify({committed:true,count}));
        await new Promise(()=>setInterval(()=>{},1000));
      } catch { console.error('SCHEDULER_CHILD_FAILED'); process.exit(1); }
    `;
    const process = Bun.spawn([processExecPath, '--eval', program], { env: { ...globalThis.process.env }, stdout: 'pipe', stderr: 'pipe' });
    children.push(process);
    const reader = process.stdout.getReader();
    let buffer = '';
    async function line(): Promise<any> {
      const deadline = setTimeout(() => process.kill('SIGKILL'), 10_000);
      try {
        while (!buffer.includes('\n')) {
          const next = await reader.read();
          if (next.done) throw Error('Scheduler child exited before checkpoint');
          buffer += new TextDecoder().decode(next.value);
        }
        const split = buffer.indexOf('\n'), value = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        return JSON.parse(value);
      } finally { clearTimeout(deadline); }
    }
    return { process, line, pid: (await line()).pid as number };
  };
  const processExecPath = process.execPath;
  try {
    await gate`SELECT pg_advisory_lock(${key})`;
    // The checkpoint trigger blocks only this test's immutable routine identity.
    await db.unsafe(`CREATE FUNCTION test_block_routine_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.routine_id='${routine.id}'::uuid THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_block_routine_checkpoint BEFORE INSERT ON routine_occurrences
      FOR EACH ROW EXECUTE FUNCTION test_block_routine_checkpoint()`);
    const interrupted = await child();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [blocked] = await db`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${interrupted.pid} AND locktype='advisory' AND objid=${key} AND NOT granted) AS waiting`;
      if (blocked.waiting) break;
      if (Date.now() > deadline) throw Error('Scheduler never reached the durable checkpoint');
      await Bun.sleep(20);
    }
    interrupted.process.kill('SIGKILL'); await interrupted.process.exited;
    await gate`SELECT pg_advisory_unlock(${key})`;
    // Wait for the killed backend's transaction to finish rolling back, without a timing guess.
    await db`SELECT id FROM routines WHERE id=${routine.id} FOR UPDATE`;
    expect(await db`SELECT id FROM runs WHERE companion_id=${companion.id}`).toHaveLength(0);
    expect((await routineHistory(companion.id, routine.id))!.missed).toHaveLength(0);
    const [checkpoint] = await db`SELECT next_fire_at FROM routines WHERE id=${routine.id}`;
    expect(new Date(checkpoint.next_fire_at).toISOString()).toBe('2026-01-01T07:00:00.000Z');

    const committed = await child();
    expect(await committed.line()).toEqual({ committed: true, count: 1 });
    committed.process.kill('SIGKILL'); await committed.process.exited;
    const [accepted] = await db`SELECT id,client_message_id,dispatched,status FROM runs WHERE companion_id=${companion.id}`;
    expect(accepted).toMatchObject({ id: accepted.client_message_id, dispatched: false, status: 'queued' });

    const restarted = await child();
    expect(await restarted.line()).toEqual({ committed: true, count: 0 });
    restarted.process.kill('SIGKILL'); await restarted.process.exited;
    const history = await routineHistory(companion.id, routine.id);
    expect(history!.runs).toHaveLength(1);
    expect(history!.runs[0].id).toBe(accepted.id);
    expect(new Date(history!.runs[0].scheduledFor).toISOString()).toBe('2026-01-01T10:00:00.000Z');
    expect(history!.missed).toHaveLength(1);
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
    await gate`SELECT pg_advisory_unlock(${key})`; gate.release();
    await db.unsafe('DROP TRIGGER IF EXISTS test_block_routine_checkpoint ON routine_occurrences; DROP FUNCTION IF EXISTS test_block_routine_checkpoint()');
    await db`UPDATE routines SET enabled=false,next_fire_at=null WHERE companion_id=${companion.id}`;
    await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${companion.id} AND status='queued'`;
  }
}, 30_000);
