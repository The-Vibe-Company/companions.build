import {beforeAll,afterEach,expect,test} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {acquireExecutor,tick} from '../src/executor';
import {ownerMayStartWork,progressLifecycle,handleLifecycle,SUBSCRIPTION_REQUIRED,type LifecycleMachines} from '../src/lifecycle';
import {productHooks} from '../src/runtime-product';
import {encrypt} from '../src/config';
import {enqueueBackground} from '../src/automations';
import {saveTemplate,allowTemplate} from '../src/templates';
const companions:string[]=[];
const envKeys=['NODE_ENV','BILLING_TEST_MODE','STRIPE_SECRET_KEY','STRIPE_BASE_PRICE_ID','STRIPE_MODEL_PRICE_ID','STRIPE_BOX_PRICE_ID','STRIPE_WEBHOOK_SECRET','STRIPE_METER_EVENT_NAME','STRIPE_BOX_METER_EVENT_NAME','APP_URL'];
const original=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
beforeAll(async()=>{await migrate();});
afterEach(async()=>{for(const key of envKeys){const value=original[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}for(const id of companions.splice(0)){await db`UPDATE companions SET retired_at=now(),prepare_requested=false WHERE id=${id}`;await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id} AND status IN ('queued','preparing','running','needs_input')`;}});
function hosted(){Object.assign(process.env,{NODE_ENV:'production',STRIPE_SECRET_KEY:'fixture-only',STRIPE_BASE_PRICE_ID:'fixture-base-price',STRIPE_MODEL_PRICE_ID:'fixture-model-price',STRIPE_BOX_PRICE_ID:'fixture-box-price',STRIPE_WEBHOOK_SECRET:'fixture-secret',STRIPE_METER_EVENT_NAME:'fixture-meter',STRIPE_BOX_METER_EVENT_NAME:'fixture-box-meter',APP_URL:'https://fixture.example'});delete process.env.BILLING_TEST_MODE;}
async function fixture(){const owner=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${owner},'Activation fixture',${owner+'@example.test'},true)`;const c=await createCompanion(owner,{name:'Activation fixture',instructions:'',provider:'box'});companions.push(c.id);await db`UPDATE companions SET prepare_requested=false WHERE id=${c.id}`;return {owner,id:c.id as string};}
async function activate(owner:string){const customer='cus_'+owner,subscription='sub_'+owner;await db`INSERT INTO billing_accounts(owner_id,stripe_customer_id,stripe_subscription_id) VALUES(${owner},${customer},${subscription}) ON CONFLICT(owner_id) DO UPDATE SET stripe_customer_id=EXCLUDED.stripe_customer_id,stripe_subscription_id=EXCLUDED.stripe_subscription_id`;await db`INSERT INTO billing_subscriptions(stripe_subscription_id,owner_id,stripe_customer_id,stripe_price_id,subscription_status,last_event_created) VALUES(${subscription},${owner},${customer},${JSON.stringify(['fixture-base-price','fixture-box-price','fixture-model-price'])},'active',1) ON CONFLICT(stripe_subscription_id) DO UPDATE SET subscription_status='active'`;}
async function leader(){const sql=await acquireExecutor();if(!sql)throw Error('Test executor unavailable');return {sql,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};}
function fake(endpoint:string,events:string[],id:string):LifecycleMachines{return {async prepare(c,checkpoint){if(c.id!==id)return null;events.push('prepare '+(c.box_id??'new'));await checkpoint(c.box_id??'known-box');return endpoint;},async health(){return {ready:true};},async pause(){events.push('pause');},async archive(){events.push('archive');return true;},async snapshot(){events.push('snapshot');},async snapshotStatus(){return 'pending';}};}

test('local unconfigured execution remains available; production requires real activation',async()=>{
 const f=await fixture();for(const key of envKeys)delete process.env[key];
 expect(await ownerMayStartWork(f.owner)).toBe(true);
 process.env.NODE_ENV='production';expect(await ownerMayStartWork(f.owner)).toBe(false);
 hosted();expect(await ownerMayStartWork(f.owner)).toBe(false);await activate(f.owner);expect(await ownerMayStartWork(f.owner)).toBe(true);
 await db`UPDATE billing_subscriptions SET subscription_status='canceled' WHERE owner_id=${f.owner}`;expect(await ownerMayStartWork(f.owner)).toBe(false);
});

test('revoked queued chat, routine, trigger and delegation work fail visibly before any machine contact',async()=>{
 const f=await fixture();hosted();const events:string[]=[],lock=await leader();
 try{
  await acceptMessage(f.owner,f.id,crypto.randomUUID(),'Chat');for(const source of ['routine','trigger','delegation'] as const)await enqueueBackground({companionId:f.id,clientMessageId:crypto.randomUUID(),content:'Background',source});
  await db`UPDATE companions SET prepare_requested=true WHERE id=${f.id}`;
  await tick(lock.sql,{...productHooks,lifecycleMachines:fake('http://unused',events,f.id)});
  const rows=await db`SELECT status,dispatched,error FROM runs WHERE companion_id=${f.id}`;
  expect(rows).toHaveLength(4);for(const row of rows)expect(row).toMatchObject({status:'failed',dispatched:false,error:SUBSCRIPTION_REQUIRED});
  expect(events).toEqual([]);expect((await db`SELECT prepare_requested FROM companions WHERE id=${f.id}`)[0].prepare_requested).toBe(false);
  await tick(lock.sql,{...productHooks,lifecycleMachines:fake('http://unused',events,f.id)});expect(events).toEqual([]);
 }finally{await lock.close();}
});

test('activation is rechecked after configuration immediately before a new prompt',async()=>{
 const f=await fixture();hosted();await activate(f.owner);const events:string[]=[],lock=await leader();let puts=0;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){if(req.method==='PUT')puts++;return Response.json({ready:true});}});
 try{
  const run=await acceptMessage(f.owner,f.id,crypto.randomUUID(),'Work');
  await tick(lock.sql,{...productHooks,lifecycleMachines:fake(`http://127.0.0.1:${daemon.port}`,events,f.id),async prepareRun(){await db`UPDATE billing_subscriptions SET subscription_status='canceled' WHERE owner_id=${f.owner}`;}});
  expect(events).toEqual(['prepare new']);expect(puts).toBe(0);expect((await db`SELECT status,error FROM runs WHERE id=${run}`)[0]).toMatchObject({status:'failed',error:SUBSCRIPTION_REQUIRED});
 }finally{daemon.stop(true);await lock.close();}
});

test('revocation still allows active task completion, output harvest and cancellation',async()=>{
 const f=await fixture();hosted();const methods:string[]=[],lock=await leader();let remote='succeeded',harvested=0;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const path=new URL(req.url).pathname;methods.push(req.method+' '+path);if(path.endsWith('/cancel'))remote='cancelled';return Response.json({status:remote,text:'Preserved result'});}});
 try{
  await db`UPDATE companions SET endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)},status='ready' WHERE id=${f.id}`;
  const run=await acceptMessage(f.owner,f.id,crypto.randomUUID(),'Previously started');await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${run}`;
  await tick(lock.sql,{canStartWork:ownerMayStartWork,async beforeSettle(){harvested++;}});
  expect((await db`SELECT status,result_text FROM runs WHERE id=${run}`)[0]).toMatchObject({status:'succeeded',result_text:'Preserved result'});expect(harvested).toBe(1);
  const cancelled=await acceptMessage(f.owner,f.id,crypto.randomUUID(),'Cancel active');await db`UPDATE runs SET status='running',dispatched=true,cancel_requested=true,started_at=now() WHERE id=${cancelled}`;remote='running';
  await tick(lock.sql,{canStartWork:ownerMayStartWork});expect(methods).toContain('POST /runs/'+cancelled+'/cancel');expect((await db`SELECT status FROM runs WHERE id=${cancelled}`)[0].status).toBe('cancelled');
  expect(methods.some(method=>method.startsWith('PUT'))).toBe(false);
 }finally{daemon.stop(true);await lock.close();}
});

test('MCP cannot launch additional children or permanent-agent work after activation is revoked',async()=>{
 const f=await fixture(),target=await fixture();const template=await saveTemplate(f.owner,{name:'Specialist'});await allowTemplate(f.owner,f.id,{templateId:template.id,maxChildren:1});
 const parentRun=await acceptMessage(f.owner,f.id,crypto.randomUUID(),'Parent');hosted();
 await expect(handleLifecycle({operation:'spawn',companionId:f.id,runId:parentRun!,commandId:crypto.randomUUID(),input:{templateId:template.id,prompt:'Work'}},f.owner)).rejects.toThrow('subscription_required');
 await expect(handleLifecycle({operation:'delegate',companionId:f.id,runId:parentRun!,commandId:crypto.randomUUID(),input:{companionId:target.id,prompt:'Work'}},f.owner)).rejects.toThrow('subscription_required');
 await expect(handleLifecycle({operation:'prepare',companionId:f.id},f.owner)).rejects.toThrow('subscription_required');
 expect(await handleLifecycle({operation:'templates'},f.owner)).toHaveLength(1);
 expect(await db`SELECT id FROM delegations WHERE parent_id=${f.id}`).toHaveLength(0);
});

test('a healthy ready machine is reused without preparation; a failed health probe repairs the same known Box',async()=>{
 const f=await fixture();hosted();await activate(f.owner);const events:string[]=[],lock=await leader();let healthy=true;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){return Response.json(new URL(req.url).pathname==='/health'?{ready:healthy}:{status:'succeeded',text:'Done'});}});
 const hooks={canStartWork:ownerMayStartWork,lifecycleMachines:fake(`http://127.0.0.1:${daemon.port}`,events,f.id)};
 try{
  await acceptMessage(f.owner,f.id,crypto.randomUUID(),'First');await tick(lock.sql,hooks);await tick(lock.sql,hooks);
  expect(events).toEqual(['prepare new']);
  await acceptMessage(f.owner,f.id,crypto.randomUUID(),'Warm second');await tick(lock.sql,hooks);await tick(lock.sql,hooks);expect(events).toEqual(['prepare new']);
  healthy=false;await acceptMessage(f.owner,f.id,crypto.randomUUID(),'Wake archived');await tick(lock.sql,hooks);
  expect((await db`SELECT prepare_requested FROM companions WHERE id=${f.id}`)[0].prepare_requested).toBe(true);expect(events).toEqual(['prepare new']);
  healthy=true;await tick(lock.sql,hooks);expect(events).toEqual(['prepare new','prepare known-box']);
 }finally{daemon.stop(true);await lock.close();}
});

test('revoked owners retain completed child results and cleanup without launching a paid parent review',async()=>{
 const f=await fixture(),template=await saveTemplate(f.owner,{name:'Specialist'});await allowTemplate(f.owner,f.id,{templateId:template.id,maxChildren:1});
 const child=await handleLifecycle({operation:'spawn',companionId:f.id,commandId:crypto.randomUUID(),input:{templateId:template.id,prompt:'Already completed'}},f.owner);
 companions.push(child.companionId);await db`UPDATE runs SET status='succeeded',result_text='Retained completion',finished_at=now() WHERE id=${child.runId}`;
 hosted();const events:string[]=[],lock=await leader();
 try{
  await progressLifecycle(lock.sql,{canStartWork:ownerMayStartWork,filesDurable:async()=>true},fake('http://unused',events,child.companionId));
  const [delegation]=await db`SELECT result,returned_run_id,finished_at FROM delegations WHERE run_id=${child.runId}`;
  expect(delegation.result.text).toBe('Retained completion');expect(delegation.returned_run_id).toBeNull();expect(delegation.finished_at).not.toBeNull();
  expect(events).toEqual(['archive']);expect((await db`SELECT retired_at FROM companions WHERE id=${child.companionId}`)[0].retired_at).not.toBeNull();
 }finally{await lock.close();}
});

test('independent machine readiness progresses while one prepare blocks, with at most eight preparations',async()=>{
 const fixtures=await Promise.all(Array.from({length:11},()=>fixture()));
 for(const f of fixtures)await db`UPDATE companions SET prepare_requested=true WHERE id=${f.id}`;
 const lock=await leader();let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});let active=0,peak=0,finished=false,blockedStarted=false;
 const machine=fake('http://ready',[],fixtures[0].id);
 machine.prepare=async(c,checkpoint)=>{active++;peak=Math.max(peak,active);try{if(c.id===fixtures[0].id){blockedStarted=true;await blocked;}else await Bun.sleep(60);await checkpoint('box-'+c.id);return 'http://ready';}finally{active--;}};
 const progression=progressLifecycle(lock.sql,{},machine).then(()=>{finished=true;});
 try{
  const deadline=Date.now()+2000;let ready=false;
  while(Date.now()<deadline){const [row]=await db`SELECT status FROM companions WHERE id=${fixtures[1].id}`;if(row.status==='ready'&&blockedStarted){ready=true;break;}await Bun.sleep(10);}
  expect(ready).toBe(true);expect(finished).toBe(false);expect(peak).toBeGreaterThan(1);expect(peak).toBeLessThanOrEqual(8);
 }finally{release();await progression;await lock.close();}
});

test('an expired cached endpoint is cleared and re-resolved on the same Box on the next pass',async()=>{
 const f=await fixture(),attempts:string[]=[],lock=await leader();
 await db`UPDATE companions SET box_id='existing-box',prepare_requested=true,endpoint_secret=${encrypt('http://expired')} WHERE id=${f.id}`;
 const machine=fake('http://renewed',[],f.id);
 machine.prepare=async c=>{attempts.push(c.box_id);return c.endpoint_secret?'http://expired':'http://renewed';};
 machine.health=async endpoint=>{if(endpoint==='http://expired')throw Error('agent_auth_expired');return {ready:true};};
 try{
  await progressLifecycle(lock.sql,{},machine);expect((await db`SELECT endpoint_secret FROM companions WHERE id=${f.id}`)[0].endpoint_secret).toBeNull();
  await progressLifecycle(lock.sql,{},machine);expect(attempts).toEqual(['existing-box','existing-box']);expect((await db`SELECT status,prepare_requested FROM companions WHERE id=${f.id}`)[0]).toMatchObject({status:'ready',prepare_requested:false});
 }finally{await lock.close();}
});
