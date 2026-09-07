import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { db, migrate, createCompanion } from "../src/store";
import { handleTriggers, handleWebhook, migrateTriggers, processTriggerInbox, triggerProviderAdapters, reconcileTriggerRegistration, triggerBatchContext, syncTriggerBatches } from "../src/triggers";
import {enqueueBackgroundInTransaction} from "../src/automations";
import { encrypt } from "../src/config";

const OWNER = `trigger-owner-${crypto.randomUUID()}`;
const OTHER = `trigger-other-${crypto.randomUUID()}`;
const COMPANION = crypto.randomUUID();

beforeAll(async () => {
  await migrate();
  for(const id of [OWNER,OTHER]) await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${id},'Trigger fixture',${id+'@example.com'},true) ON CONFLICT DO NOTHING`;
  await db.unsafe(`ALTER TABLE companions ADD COLUMN IF NOT EXISTS owner_id text`);
  await db.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS companions_id_owner_uq ON companions(id,owner_id)`);
  await db.unsafe(`CREATE TABLE IF NOT EXISTS plugin_accounts(id uuid PRIMARY KEY,owner_id text NOT NULL,provider text NOT NULL,
    label text NOT NULL,credential_secret text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`);
  await migrateTriggers();
  await migrateTriggers();
  await db.unsafe(`INSERT INTO companions(id,name,instructions,provider,create_key,agent_secret,owner_id)
    VALUES($1,'Trigger test','','local',$2,$4,$3)`, [COMPANION, crypto.randomUUID(), OWNER,encrypt("synthetic-agent-token")]);
});

afterAll(async()=>{await db`UPDATE runs SET status='cancelled' WHERE companion_id=${COMPANION} AND status IN ('queued','preparing','running')`;});
async function createTrigger(input: Record<string, unknown>) {
  const response = await handleTriggers(new Request(`http://localhost/api/companions/${COMPANION}/triggers`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }), OWNER, { fetchImpl: fetch });
  expect(response?.status).toBe(201);
  return response!.json() as Promise<any>;
}

function webhook(id: string, secret: string, payload: unknown, delivery = crypto.randomUUID()) {
  const body = JSON.stringify(payload);
  return new Request(`http://localhost/api/webhooks/${id}`, { method: "POST", body, headers: {
    "content-type": "application/json", "x-webhook-id": delivery,
    "x-companions-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  } });
}

describe("durable trigger intake", () => {
  test("rejects invalid signatures, deduplicates delivery, and a false filter never enqueues", async () => {
    const created = await createTrigger({ name: "Ignore closed", prompt: "Inspect issue", source: "generic", mode: "filter",
      filterCode: `function shouldTrigger(payload) { return payload.issue.state === "open" }`, problemPath: "issue.id" });
    const wrong = await handleWebhook(webhook(created.trigger.id, "wrong-secret", { issue: { id: 7, state: "closed" } }));
    expect(wrong?.status).toBe(401);
    const delivery = crypto.randomUUID();
    expect((await handleWebhook(webhook(created.trigger.id, created.secret, { issue: { id: 7, state: "closed" } }, delivery)))?.status).toBe(202);
    const duplicate = await handleWebhook(webhook(created.trigger.id, created.secret, { issue: { id: 7, state: "closed" } }, delivery));
    expect(await duplicate?.json()).toEqual({ ok: true, duplicate: true });
    let enqueued = 0;
    await processTriggerInbox({ enqueueBackground: async () => { enqueued++; return crypto.randomUUID(); }, runFilterImpl: async input => {
      expect(input.payload).toEqual({ issue: { id: 7, state: "closed" } }); return false;
    } });
    expect(enqueued).toBe(0);
    const rows = await db`SELECT status,decision FROM trigger_deliveries WHERE trigger_id=${created.trigger.id}`;
    expect(rows).toEqual([{ status: "ignored", decision: "ignored" }]);
  });

  test("owner-scoped CRUD does not reveal or mutate another account's triggers", async () => {
    const list = await handleTriggers(new Request(`http://localhost/api/companions/${COMPANION}/triggers`), OTHER);
    expect(await list?.json()).toEqual({ triggers: [] });
    const [{ id }] = await db`SELECT id FROM triggers WHERE companion_id=${COMPANION} LIMIT 1`;
    const patch = await handleTriggers(new Request(`http://localhost/api/companions/${COMPANION}/triggers/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "stolen" }),
    }), OTHER);
    expect(patch?.status).toBe(404);
  });

  test("distinct deliveries for one problem join one queued background batch", async () => {
    const created = await createTrigger({ name: "Issue opened", prompt: "Investigate", source: "generic", mode: "direct", problemPath: "issue.id" });
    await handleWebhook(webhook(created.trigger.id, created.secret, { issue: { id: "same" }, occurrence: 1 }));
    await handleWebhook(webhook(created.trigger.id, created.secret, { issue: { id: "same" }, occurrence: 2 }));
    const calls: any[] = [];
    const enqueueBackground = async (input: any,tx:any) => { calls.push(input); return enqueueBackgroundInTransaction(input,tx); };
    await processTriggerInbox({ enqueueBackground });
    await processTriggerInbox({ enqueueBackground });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ companionId: COMPANION, source: "trigger" });
    const rows = await db`SELECT batch_id FROM trigger_deliveries WHERE trigger_id=${created.trigger.id} ORDER BY received_at,id`;
    expect(rows).toHaveLength(2);
    expect(rows[0].batch_id).toBe(rows[1].batch_id);

    const [{ run_id: activeRun }] = await db`SELECT run_id FROM trigger_batches WHERE id=${rows[0].batch_id}`;
    await db`UPDATE runs SET status='running',dispatched=true WHERE id=${activeRun}`;
    await handleWebhook(webhook(created.trigger.id, created.secret, { issue: { id: "same" }, occurrence: 3 }));
    await handleWebhook(webhook(created.trigger.id, created.secret, { issue: { id: "same" }, occurrence: 4 }));
    await processTriggerInbox({ enqueueBackground });
    await processTriggerInbox({ enqueueBackground });
    expect(calls).toHaveLength(2);
    expect((await db`SELECT id FROM trigger_batches WHERE trigger_id=${created.trigger.id}`)).toHaveLength(2);
  });

  test("registers failed-main GitHub delivery with an owned compatible connection", async () => {
    const accountId = crypto.randomUUID();
    await db.unsafe(`INSERT INTO plugin_accounts(id,owner_id,provider,label,credential_secret) VALUES($1,$2,'github','GitHub',$3)`,
      [accountId, OWNER, encrypt(JSON.stringify({ kind: "oauth", accessToken: "provider-test-token", accessExpiresAt: null }))]);
    let registeredSecret = "";
    const providerFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json([]);
      const body = JSON.parse(String(init?.body)); registeredSecret = body.config.secret;
      return Response.json({ id: 42 }, { status: 201 });
    };
    const createdResponse = await handleTriggers(new Request(`http://localhost/api/companions/${COMPANION}/triggers`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        name: "Failed main CI", prompt: "Analyze the failure", source: "github", mode: "direct",
        providerAccountId: accountId, target: { repo: "acme/project", branch: "main", events: ["workflow_run"] },
      }),
    }), OWNER, { fetchImpl: providerFetch as typeof fetch });
    const created = await createdResponse!.json() as any;
    expect(created.trigger.registrationStatus).toBe("registered");
    expect(registeredSecret).toHaveLength(64);
    const body = JSON.stringify({ action: "completed", workflow_run: { id: 8, head_branch: "main", conclusion: "success" } });
    const signature = createHmac("sha256", registeredSecret).update(body).digest("hex");
    await handleWebhook(new Request(`http://localhost/api/webhooks/${created.trigger.id}`, { method: "POST", body, headers: {
      "x-github-delivery": crypto.randomUUID(), "x-github-event": "workflow_run", "x-hub-signature-256": `sha256=${signature}`,
    } }));
    let enqueued = 0;
    await processTriggerInbox({ enqueueBackground: async () => { enqueued++; return crypto.randomUUID(); } });
    expect(enqueued).toBe(0);
  });

  test("registers Sentry service hooks and reports a missing connection honestly", async () => {
    const accountId = crypto.randomUUID();
    await db.unsafe(`INSERT INTO plugin_accounts(id,owner_id,provider,label,credential_secret) VALUES($1,$2,'sentry','Sentry',$3)`,
      [accountId, OWNER, encrypt(JSON.stringify({ kind: "oauth", accessToken: "provider-test-token", accessExpiresAt: null }))]);
    const providerFetch = async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "GET" ? Response.json([])
      : Response.json({ id: "hook-1", url: "http://localhost", secret: "s".repeat(64) }, { status: 201 });
    const registered = await handleTriggers(new Request(`http://localhost/api/companions/${COMPANION}/triggers`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "New Sentry issue",
        prompt: "Inspect the issue", source: "sentry", mode: "direct", providerAccountId: accountId,
        target: { organization: "acme", project: "web", events: ["event.created"] } }),
    }), OWNER, { fetchImpl: providerFetch as typeof fetch });
    expect((await registered!.json() as any).trigger.registrationStatus).toBe("registered");
    const missing = await createTrigger({ name: "Another Sentry project", prompt: "Inspect", source: "sentry", mode: "direct",
      providerAccountId: crypto.randomUUID(), target: { organization: "acme", project: "api" } });
    expect(missing.trigger.registrationStatus).toBe("needs_connection");
  });
});

test('provider hook recovery follows bounded pagination without repeating a creation',async()=>{
 let posts=0;const webhookUrl='https://companions.test/api/webhooks/example';
 const fetchImpl=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(String(input));if(init?.method==='POST')posts++;
  if(init?.method==='PATCH')return Response.json({id:9});
  return url.search?Response.json([{id:9,config:{url:webhookUrl}}]):Response.json([],{headers:{link:`<${url.href}?page=2>; rel="next"`}});
 };
 expect(await triggerProviderAdapters.github.register({target:{repo:'acme/web'},webhookUrl,secret:'test-secret',token:'test-only',fetchImpl:fetchImpl as typeof fetch})).toMatchObject({remoteHookId:'9'});
 expect(posts).toBe(0);
 let requests=0;
 await expect(triggerProviderAdapters.github.register({target:{repo:'acme/web'},webhookUrl,secret:'test-secret',token:'test-only',fetchImpl:(async()=>{requests++;return Response.json([],{headers:{link:'<https://attacker.test/steal>; rel="next"'}});}) as unknown as typeof fetch})).rejects.toThrow('pagination');
 expect(requests).toBe(1);
});

test('Sentry native service-hook signature admits only the first event of a new issue',async()=>{
 const accountId=crypto.randomUUID();await db`INSERT INTO plugin_accounts(id,owner_id,provider,label,credential_secret) VALUES(${accountId},${OWNER},'sentry','Native',${encrypt(JSON.stringify({kind:'oauth',accessToken:'test-only'}))})`;
 const secret='n'.repeat(64);
 const fetchImpl=async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input).includes('/events/oldest/'))return Response.json({eventID:'first-event'});
  return init?.method==='GET'?Response.json([]):Response.json({id:'native-hook',url:'https://companions.test/hook',secret});
 };
 const response=await handleTriggers(new Request(`http://control/api/companions/${COMPANION}/triggers`,{method:'POST',body:JSON.stringify({name:'Only new issues',prompt:'Investigate',source:'sentry',mode:'direct',providerAccountId:accountId,target:{organization:'acme',project:'web'}})}),OWNER,{fetchImpl:fetchImpl as typeof fetch});
 const {trigger}=await response!.json() as any;const firstSeen=new Date(Date.now()+100).toISOString();let enqueued=0;
 const enqueueBackground=async(input:any,tx:any)=>{enqueued++;return enqueueBackgroundInTransaction(input,tx);};
 for(const eventID of ['first-event','repeat-event']){
  const body=JSON.stringify({group:{id:'123',firstSeen},event:{eventID}});
  const result=await handleWebhook(new Request(`http://control/api/webhooks/${trigger.id}`,{method:'POST',body,headers:{'X-ServiceHook-Signature':createHmac('sha256',secret).update(body).digest('hex')}}));
  expect(result!.status).toBe(202);
  await processTriggerInbox({enqueueBackground,fetchImpl:fetchImpl as typeof fetch});
 }
 expect(enqueued).toBe(1);
 const decisions=await db`SELECT decision FROM trigger_deliveries WHERE trigger_id=${trigger.id} ORDER BY received_at`;
 expect(decisions.map((row:any)=>row.decision)).toEqual(['accepted','ignored']);
});


test('concurrent registration retries create one remote hook and reconcile the same identity',async()=>{
 const accountId=crypto.randomUUID();
 const created=await createTrigger({name:'Concurrent registration',prompt:'Investigate',source:'github',mode:'direct',providerAccountId:accountId,target:{repo:'acme/concurrent'}});
 await db.unsafe(`INSERT INTO plugin_accounts(id,owner_id,provider,label,credential_secret) VALUES($1,$2,'github','GitHub',$3)`,[accountId,OWNER,encrypt(JSON.stringify({kind:'oauth',accessToken:'test-token',accessExpiresAt:null}))]);
 const hooks:any[]=[];let posts=0;
 const fetchImpl=(async(_url:any,init?:RequestInit)=>{
  if(init?.method==='GET'){await Bun.sleep(20);return Response.json(hooks);}
  if(init?.method==='POST'){posts++;const body=JSON.parse(String(init.body));hooks.push({id:77,config:body.config});return Response.json({id:77});}
  return Response.json({id:77});
 }) as typeof fetch;
 const results=await Promise.all([0,1].map(()=>reconcileTriggerRegistration(OWNER,COMPANION,created.trigger.id,{fetchImpl})));
 expect(posts).toBe(1);expect(results.every((result:any)=>result.registrationStatus==='registered')).toBe(true);
 expect((await db`SELECT remote_hook_id FROM triggers WHERE id=${created.trigger.id}`)[0].remote_hook_id).toBe('77');
});

async function atomicFixture(){
 const c=await createCompanion(OWNER,{name:'Atomic trigger',provider:'local'});
 const response=await handleTriggers(new Request(`http://control/api/companions/${c.id}/triggers`,{method:'POST',body:JSON.stringify({name:'Atomic delivery',prompt:'Investigate',source:'generic',mode:'filter',filterCode:'return true',problemPath:'issue.id'})}),OWNER);
 expect(response?.status).toBe(201);const created=await response!.json() as any;return {companionId:c.id,...created};
}
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

test('a queued run is invisible until its payload batch link commits in the same transaction',async()=>{
 const f=await atomicFixture(),entered=barrier(),hold=barrier();let runId:string|null=null;
 await handleWebhook(webhook(f.trigger.id,f.secret,{issue:{id:'atomic'},nonce:'payload-present'}));
 const work=processTriggerInbox({runFilterImpl:async()=>true,enqueueBackground:async(input,tx)=>{
  runId=await enqueueBackgroundInTransaction(input,tx);entered.release();await hold.promise;return runId;
 }});
 try{
  await entered.promise;
  expect(await db`SELECT id FROM runs WHERE companion_id=${f.companionId}`).toHaveLength(0);
  expect(await db`SELECT run_id FROM trigger_batches WHERE trigger_id=${f.trigger.id} AND enqueue_status='sent'`).toHaveLength(0);
 }finally{hold.release();await work;}
 expect(await db`SELECT id FROM runs WHERE companion_id=${f.companionId}`).toHaveLength(1);
 expect((await triggerBatchContext(runId!)).map((row:any)=>row.payload)).toEqual([{issue:{id:'atomic'},nonce:'payload-present'}]);
});

test('failure at the batch link checkpoint rolls back run admission and retry retains one batch identity',async()=>{
 const f=await atomicFixture();await handleWebhook(webhook(f.trigger.id,f.secret,{issue:{id:'checkpoint'}}));
 await db.unsafe(`CREATE FUNCTION reject_trigger_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.trigger_id='${f.trigger.id}'::uuid AND NEW.enqueue_status='sent' THEN RAISE EXCEPTION 'injected batch checkpoint failure'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER reject_trigger_link BEFORE UPDATE ON trigger_batches FOR EACH ROW EXECUTE FUNCTION reject_trigger_link()`);
 try{await processTriggerInbox({enqueueBackground:enqueueBackgroundInTransaction,runFilterImpl:async()=>true});}
 finally{await db.unsafe('DROP TRIGGER reject_trigger_link ON trigger_batches; DROP FUNCTION reject_trigger_link()');}
 expect(await db`SELECT id FROM runs WHERE companion_id=${f.companionId}`).toHaveLength(0);
 const [batch]=await db`SELECT id,run_id,enqueue_status FROM trigger_batches WHERE trigger_id=${f.trigger.id}`;
 expect(batch).toMatchObject({run_id:null,enqueue_status:'error'});
 await db`UPDATE trigger_batches SET next_enqueue_at=now() WHERE id=${batch.id}`;
 await processTriggerInbox({enqueueBackground:enqueueBackgroundInTransaction});
 const [accepted]=await db`SELECT id,client_message_id FROM runs WHERE companion_id=${f.companionId}`;
 expect(accepted.client_message_id).toBe(batch.id);expect(await db`SELECT id FROM runs WHERE companion_id=${f.companionId}`).toHaveLength(1);
 expect(await triggerBatchContext(accepted.id)).toHaveLength(1);
 await processTriggerInbox({enqueueBackground:enqueueBackgroundInTransaction});
 expect(await db`SELECT id FROM runs WHERE companion_id=${f.companionId}`).toHaveLength(1);
});

test('an event evaluated across run admission creates a follow-up instead of changing the staged batch',async()=>{
 const f=await atomicFixture();
 await handleWebhook(webhook(f.trigger.id,f.secret,{issue:{id:'same'},occurrence:1}));
 await processTriggerInbox({enqueueBackground:enqueueBackgroundInTransaction,runFilterImpl:async()=>true});
 let [current]=await db`SELECT id FROM runs WHERE companion_id=${f.companionId}`;let previous:string|undefined;
 for(const occurrence of [2,3]){
  await handleWebhook(webhook(f.trigger.id,f.secret,{issue:{id:'same'},occurrence}));
  const entered=barrier(),hold=barrier();
  const work=processTriggerInbox({enqueueBackground:enqueueBackgroundInTransaction,runFilterImpl:async()=>{entered.release();await hold.promise;return true;}});
  try{
   await entered.promise;
   if(previous)await db`UPDATE runs SET status='succeeded',finished_at=now() WHERE id=${previous}`;
   await db`UPDATE runs SET status='preparing' WHERE id=${current.id}`;
   expect((await triggerBatchContext(current.id)).map((d:any)=>d.payload.occurrence)).toEqual([occurrence-1]);
  }finally{hold.release();await work;}
  expect((await triggerBatchContext(current.id)).map((d:any)=>d.payload.occurrence)).toEqual([occurrence-1]);
  const [followup]=await db`SELECT r.id FROM runs r JOIN trigger_batches b ON b.run_id=r.id WHERE b.trigger_id=${f.trigger.id} AND r.status='queued'`;
  expect(followup.id).not.toBe(current.id);expect((await triggerBatchContext(followup.id)).map((d:any)=>d.payload.occurrence)).toEqual([occurrence]);
  previous=current.id;current=followup;
 }
 expect(await db`SELECT id FROM runs WHERE companion_id=${f.companionId}`).toHaveLength(3);
});


test('parked tasks and their active successor do not prevent the trigger inbox from progressing',async()=>{
 const f=await atomicFixture();
 for(const occurrence of [1,2,3]){
  await handleWebhook(webhook(f.trigger.id,f.secret,{issue:{id:'parked'},occurrence}));
  await processTriggerInbox({enqueueBackground:enqueueBackgroundInTransaction,runFilterImpl:async()=>true});
  const [run]=await db`SELECT id FROM runs WHERE companion_id=${f.companionId} AND status='queued'`;
  await db`UPDATE runs SET status=${occurrence===1?'needs_input':'running'} WHERE id=${run.id}`;
  await syncTriggerBatches();
  if(occurrence===2)await db`UPDATE runs SET status='succeeded' WHERE id=${run.id}`;
 }
 const batches=await db`SELECT status FROM trigger_batches WHERE trigger_id=${f.trigger.id}`;
 expect(batches.filter((b:any)=>b.status==='running')).toHaveLength(2);
 expect(batches.filter((b:any)=>b.status==='finished')).toHaveLength(1);
 expect(await processTriggerInbox({enqueueBackground:enqueueBackgroundInTransaction})).toBe(0);
});

async function stopFixture(f:any,reason:'disabled'|'retired'|'archiving'){
 if(reason==='disabled')await db`UPDATE triggers SET enabled=false WHERE id=${f.trigger.id}`;
 else if(reason==='retired')await db`UPDATE companions SET retired_at=now() WHERE id=${f.companionId}`;
 else await db`UPDATE companions SET archive_requested_at=now() WHERE id=${f.companionId}`;
}

for(const reason of ['disabled','retired','archiving'] as const){
 test(`${reason} trigger rejects intake and skips pending delivery before provider reads or filtering`,async()=>{
  const f=await atomicFixture();
  await db`UPDATE triggers SET filter_requests=${JSON.stringify([{key:'issue',provider:'github',path:'/repos/acme/web/issues/1'}])}::jsonb WHERE id=${f.trigger.id}`;
  expect((await handleWebhook(webhook(f.trigger.id,f.secret,{issue:{id:'pending'}})))?.status).toBe(202);
  await stopFixture(f,reason);
  expect((await handleWebhook(webhook(f.trigger.id,f.secret,{issue:{id:'later'}})))?.status).toBe(404);
  let calls=0;const forbidden=async()=>{calls++;throw new Error('unexpected external work');};
  await processTriggerInbox({enqueueBackground:forbidden,runFilterImpl:forbidden,fetchImpl:forbidden as unknown as typeof fetch});
  expect(calls).toBe(0);
  const decisions=await db`SELECT decision FROM trigger_deliveries WHERE trigger_id=${f.trigger.id}`;
  expect(decisions.map((row:any)=>row.decision)).toEqual(['ignored']);
  expect(await db`SELECT id FROM trigger_batches WHERE trigger_id=${f.trigger.id}`).toHaveLength(0);
 });
 test(`${reason} during filtering prevents batch creation and run admission`,async()=>{
  const f=await atomicFixture(),entered=barrier(),hold=barrier();
  await handleWebhook(webhook(f.trigger.id,f.secret,{issue:{id:'racing'}}));
  let enqueues=0;
  const work=processTriggerInbox({enqueueBackground:async(input,tx)=>{enqueues++;return enqueueBackgroundInTransaction(input,tx);},runFilterImpl:async()=>{entered.release();await hold.promise;return true;}});
  try{await entered.promise;await stopFixture(f,reason);}finally{hold.release();await work;}
  expect(enqueues).toBe(0);
  expect(await db`SELECT id FROM trigger_batches WHERE trigger_id=${f.trigger.id}`).toHaveLength(0);
  expect(await db`SELECT id FROM runs WHERE companion_id=${f.companionId}`).toHaveLength(0);
  expect((await db`SELECT decision,error_code FROM trigger_deliveries WHERE trigger_id=${f.trigger.id}`)[0]).toMatchObject({decision:'ignored',error_code:'trigger_inactive'});
 });
 test(`${reason} before an admission retry terminates its batch without a run`,async()=>{
  const f=await atomicFixture();await handleWebhook(webhook(f.trigger.id,f.secret,{issue:{id:'retry'}}));
  await processTriggerInbox({enqueueBackground:async()=>{throw new Error('injected admission failure');},runFilterImpl:async()=>true});
  await stopFixture(f,reason);await db`UPDATE trigger_batches SET next_enqueue_at=now() WHERE trigger_id=${f.trigger.id}`;
  let calls=0;await processTriggerInbox({enqueueBackground:async()=>{calls++;return null;}});
  expect(calls).toBe(0);
  expect((await db`SELECT status,enqueue_status,run_id FROM trigger_batches WHERE trigger_id=${f.trigger.id}`)[0]).toMatchObject({status:'finished',enqueue_status:'error',run_id:null});
  expect(await db`SELECT id FROM runs WHERE companion_id=${f.companionId}`).toHaveLength(0);
  expect(await processTriggerInbox({enqueueBackground:async()=>{calls++;return null;}})).toBe(0);expect(calls).toBe(0);
 });
}

test('disabling while the authenticated webhook body is arriving prevents durable receipt',async()=>{
 const f=await atomicFixture(),entered=barrier(),hold=barrier();
 const body=new ReadableStream<Uint8Array>({async pull(controller){entered.release();await hold.promise;controller.enqueue(new TextEncoder().encode('{}'));controller.close();}},{highWaterMark:0});
 const work=handleWebhook(new Request(`http://control/api/webhooks/${f.trigger.id}`,{method:'POST',headers:{authorization:`Bearer ${f.secret}`},body}));
 try{await entered.promise;await stopFixture(f,'disabled');}finally{hold.release();}
 expect((await work)?.status).toBe(404);
 expect(await db`SELECT id FROM trigger_deliveries WHERE trigger_id=${f.trigger.id}`).toHaveLength(0);
});

test('patching a trigger prompt preserves disabled state, filter mode and requests',async()=>{
 const f=await atomicFixture();const requests=[{key:'issue',provider:'github',path:'/repos/acme/web/issues/1'}];
 await db`UPDATE triggers SET enabled=false,filter_requests=${JSON.stringify(requests)}::jsonb WHERE id=${f.trigger.id}`;
 const result=await handleTriggers(new Request(`http://control/api/companions/${f.companionId}/triggers/${f.trigger.id}`,{method:'PATCH',body:JSON.stringify({prompt:'Revised instructions'})}),OWNER);
 expect(result?.status).toBe(200);
 expect((await result!.json() as any).trigger).toMatchObject({prompt:'Revised instructions',enabled:false,mode:'filter',filterRequests:requests});
});
