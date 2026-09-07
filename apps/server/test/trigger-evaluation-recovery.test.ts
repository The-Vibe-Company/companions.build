import {beforeAll, expect, test} from 'bun:test';
import {db, migrate, createCompanion} from '../src/store';
import {enqueueBackgroundInTransaction} from '../src/automations';
import {handleTriggers, handleWebhook, processTriggerInbox, triggerBatchContext} from '../src/triggers';

const owner='00000000-0000-4000-8000-000000000001';
beforeAll(async()=>{await migrate();});

test.each(['ignore','accept','error'])('a reclaimed webhook evaluation rejects its predecessor outcome: %s', async outcome=>{
 const companion=await createCompanion(owner,{name:'Evaluation recovery',instructions:'',provider:'local'});
 const created=await handleTriggers(new Request(`http://local/api/companions/${companion.id}/triggers`,{
  method:'POST',body:JSON.stringify({name:'Review issue',prompt:'Review',source:'generic',mode:'filter',filterCode:'payload => true'}),
 }),owner);
 expect(created!.status).toBe(201);
 const {trigger,secret}=await created!.json() as any;
 expect((await handleWebhook(new Request(`http://local/api/webhooks/${trigger.id}`,{
  method:'POST',headers:{authorization:`Bearer ${secret}`},body:JSON.stringify({issue:17}),
 })))!.status).toBe(202);
 let release!:()=>void, entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 const enqueue=enqueueBackgroundInTransaction;
 const stale=processTriggerInbox({enqueueBackground:enqueue,runFilterImpl:async()=>{entered();await gate;if(outcome==='error')throw Error('Synthetic stale filter failure');return outcome==='accept';}});
 await ready;
 try{
  await db`UPDATE trigger_deliveries SET claimed_at=now()-interval '6 minutes' WHERE trigger_id=${trigger.id}`;
  await processTriggerInbox({enqueueBackground:enqueue,runFilterImpl:async()=>true});
  const [accepted]=await db`SELECT d.status,d.decision,b.run_id FROM trigger_deliveries d JOIN trigger_batches b ON b.id=d.batch_id WHERE d.trigger_id=${trigger.id}`;
  expect(accepted.status).toBe('enqueued');
  expect(accepted.run_id).toBeString();
  await db`UPDATE runs SET status='running',dispatched=true WHERE id=${accepted.run_id}`;
  release();await stale;
  const [settled]=await db`SELECT status,decision,attempts FROM trigger_deliveries WHERE trigger_id=${trigger.id}`;
  expect(settled).toMatchObject({status:'enqueued',decision:'accepted',attempts:2});
  expect(await triggerBatchContext(accepted.run_id)).toHaveLength(1);
  expect(await db`SELECT id FROM runs WHERE companion_id=${companion.id}`).toHaveLength(1);
 }finally{release();await stale;}
});
