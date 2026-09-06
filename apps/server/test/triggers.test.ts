import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { db, migrate } from "../src/store";
import { handleTriggers, handleWebhook, migrateTriggers, processTriggerInbox, triggerProviderAdapters } from "../src/triggers";
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
    const enqueueBackground = async (input: any) => { calls.push(input); return crypto.randomUUID(); };
    await processTriggerInbox({ enqueueBackground });
    await processTriggerInbox({ enqueueBackground });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ companionId: COMPANION, source: "trigger" });
    const rows = await db`SELECT batch_id FROM trigger_deliveries WHERE trigger_id=${created.trigger.id} ORDER BY received_at,id`;
    expect(rows).toHaveLength(2);
    expect(rows[0].batch_id).toBe(rows[1].batch_id);

    const [{ run_id: activeRun }] = await db`SELECT run_id FROM trigger_batches WHERE id=${rows[0].batch_id}`;
    await db`INSERT INTO runs(id,companion_id,client_message_id,content,status,dispatched)
      VALUES(${activeRun},${COMPANION},${crypto.randomUUID()},'active trigger','running',true)`;
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
 const enqueueBackground=async()=>{enqueued++;const id=crypto.randomUUID();await db`INSERT INTO runs(id,companion_id,client_message_id,content) VALUES(${id},${COMPANION},${crypto.randomUUID()},'Native Sentry')`;return id;};
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
