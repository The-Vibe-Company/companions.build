import {afterEach, beforeAll, beforeEach, expect, test} from 'bun:test';
import {acceptMessage, createCompanion, db, detail, migrate} from '../src/store';
import {acquireExecutor, LifecycleCoordinator, tick} from '../src/executor';
import {requestPreparation, type LifecycleMachines} from '../src/lifecycle';

let owner: string;
beforeAll(() => migrate());
beforeEach(async () => {
  owner = crypto.randomUUID();
  await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${owner},'Creation fixture',${owner+'@example.com'},true)`;
});
afterEach(async () => {
  await db`UPDATE companions SET retired_at=now(),prepare_requested=false WHERE owner_id=${owner}`;
  await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id IN (SELECT id FROM companions WHERE owner_id=${owner}) AND status IN ('queued','preparing','running','needs_input')`;
});
async function leader() {
  const sql = await acquireExecutor();
  if (!sql) throw Error('Test executor unavailable');
  return {sql, async close() { await sql`SELECT pg_advisory_unlock(721440139)`; sql.release(); }};
}
function fixture(block?: Promise<void>) {
  let preparations = 0, dispatches = 0;
  const daemon = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req) {
    if (req.method === 'PUT') { dispatches++; return Response.json({status:'running'}); }
    return Response.json({ready:true,activeRuns:{main:null,background:null},status:'running'});
  }});
  const machines: LifecycleMachines = {
    async prepare(c, checkpoint) {
      preparations++;
      // The API must have committed the intent before the executor reaches a provider.
      expect((await db`SELECT prepare_requested FROM companions WHERE id=${c.id}`)[0].prepare_requested).toBe(true);
      await checkpoint('fixture-'+c.id);
      await block;
      return `http://127.0.0.1:${daemon.port}`;
    },
    async health() { return {ready:true}; }, async pause() {}, async archive() { return true; },
    async snapshot() {}, async snapshotStatus() { return 'ready'; },
  };
  return {machines, daemon, counts: () => ({preparations, dispatches})};
}
async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now()+3000;
  while (Date.now()<deadline) { if (await check()) return; await Bun.sleep(5); }
  throw Error('Expected preparation checkpoint did not arrive');
}

for (const provider of ['box','local'] as const) {
  test(`${provider} companion prepares before chat and creation retries never restart it`, async () => {
    const input = {clientCreationId:crypto.randomUUID(),name:'Prepared companion',provider,prepare:true};
    const copies = await Promise.all(Array.from({length:8}, () => createCompanion(owner,input)));
    const c = copies[0];
    expect(new Set(copies.map(copy => copy.id)).size).toBe(1);
    expect(c.prepareRequested).toBe(true);
    const f=fixture(), lock=await leader();
    try {
      expect(f.counts()).toEqual({preparations:0,dispatches:0});
      await tick(lock.sql,{lifecycleMachines:f.machines});
      expect((await detail(owner,c.id))?.companion).toMatchObject({status:'ready',prepareRequested:false});
      expect((await detail(owner,c.id))?.runs).toHaveLength(0);
      expect(f.counts()).toEqual({preparations:1,dispatches:0});
      // A response lost before ready can be retried after ready without reasserting intent.
      expect(await createCompanion(owner,input)).toMatchObject({id:c.id,status:'ready',prepareRequested:false});
      const clientMessageId=crypto.randomUUID();
      const runs=await Promise.all(Array.from({length:8},()=>acceptMessage(owner,c.id,clientMessageId,'First real message')));
      expect(new Set(runs).size).toBe(1);
      await tick(lock.sql,{lifecycleMachines:f.machines});
      await tick(lock.sql,{lifecycleMachines:f.machines});
      expect(f.counts()).toEqual({preparations:1,dispatches:1});
      expect((await detail(owner,c.id))?.runs[0].id).toBe(runs[0]);
    } finally { await lock.close(); f.daemon.stop(true); }
  });
}

test('a message and duplicate creation arriving during prewarming share the in-flight preparation', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release=resolve; });
  const input={name:'Concurrent start',provider:'box' as const,prepare:true,clientCreationId:crypto.randomUUID()};
  const c=await createCompanion(owner,input), f=fixture(blocked), lock=await leader(), lifecycle=new LifecycleCoordinator();
  try {
    await tick(lock.sql,{lifecycleMachines:f.machines},lifecycle);
    await until(()=>f.counts().preparations===1);
    expect((await createCompanion(owner,input)).id).toBe(c.id);
    await acceptMessage(owner,c.id,crypto.randomUUID(),'Arrived while starting');
    await tick(lock.sql,{lifecycleMachines:f.machines},lifecycle);
    expect(f.counts()).toEqual({preparations:1,dispatches:0});
    release();
    await until(async () => (await detail(owner,c.id))?.companion.status==='ready');
    await tick(lock.sql,{lifecycleMachines:f.machines},lifecycle);
    expect(f.counts()).toEqual({preparations:1,dispatches:1});
  } finally { release(); await lifecycle.close(); await lock.close(); f.daemon.stop(true); }
});

test('legacy lazy creation retries and repeated preparation admissions keep one machine and no hidden run', async () => {
  const input={name:'Legacy pending setup',provider:'box' as const,prepare:false,clientCreationId:crypto.randomUUID()};
  const c=await createCompanion(owner,input), f=fixture(), lock=await leader();
  try {
    await tick(lock.sql,{lifecycleMachines:f.machines});
    expect(f.counts()).toEqual({preparations:0,dispatches:0});
    const first=await requestPreparation(owner,c.id);
    // Retrying after an acknowledgement is lost returns the existing admission.
    const admissions=await Promise.all(Array.from({length:8},()=>requestPreparation(owner,c.id)));
    expect(new Set(admissions.map(result=>result!.admission.id))).toEqual(new Set([first!.admission.id]));
    expect(await db`SELECT id FROM machine_admission_requests WHERE companion_id=${c.id}`).toHaveLength(1);
    await tick(lock.sql,{lifecycleMachines:f.machines});
    expect(await createCompanion(owner,input)).toMatchObject({id:c.id,status:'ready',prepareRequested:false});
    await requestPreparation(owner,c.id);
    await tick(lock.sql,{lifecycleMachines:f.machines});
    expect(f.counts()).toEqual({preparations:1,dispatches:0});
    expect((await detail(owner,c.id))?.runs).toHaveLength(0);
  } finally { await lock.close(); f.daemon.stop(true); }
});
