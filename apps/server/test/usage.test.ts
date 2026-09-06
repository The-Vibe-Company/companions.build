import {beforeAll,test,expect} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {recordCompletedUsage} from '../src/usage';
beforeAll(async()=>{await migrate();});
test('usage worker counts a shared response once and retains the last partial Box minute',async()=>{
 const owner=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${owner},'Usage',${owner+'@example.com'},true)`;
 const c=await createCompanion(owner,{name:'Usage',instructions:'',provider:'box'});
 const root=await acceptMessage(owner,c.id,crypto.randomUUID(),'First');const steer=await acceptMessage(owner,c.id,crypto.randomUUID(),'Steer');
 const usage={input:20,output:5,cacheRead:0,cacheWrite:0,totalTokens:25,costUsd:0.001};
 await db`UPDATE runs SET status='succeeded',finished_at=now(),response_root_id=${root},usage=${usage} WHERE id IN (${root},${steer})`;
 const start=new Date(Date.now()-120000);await db`INSERT INTO machine_usage_events(id,companion_id,owner_id,event,occurred_at) VALUES(${crypto.randomUUID()},${c.id},${owner},'ready',${start}),(${crypto.randomUUID()},${c.id},${owner},'archived',${new Date(start.getTime()+75000)})`;
 await recordCompletedUsage();await recordCompletedUsage();
 const rows=await db`SELECT category,sum(quantity)::int AS quantity,count(*)::int AS rows FROM usage_ledger WHERE owner_id=${owner} GROUP BY category ORDER BY category`;
 expect(rows).toEqual([{category:'box_seconds',quantity:75,rows:2},{category:'model_tokens',quantity:25,rows:1}]);
});
