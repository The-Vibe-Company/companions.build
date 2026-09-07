import {afterAll,expect,test} from 'bun:test';
import {db} from '../src/store';
import {acquireExecutor,waitForExecutor} from '../src/executor';

afterAll(async()=>{await db.close();});

async function until(check:()=>boolean,timeout=2_000){
 const deadline=Date.now()+timeout;while(!check()){if(Date.now()>deadline)throw Error('standby_timeout');await Bun.sleep(10);}
}

test('a standby remains inert and acquires the PostgreSQL lock after leader handoff',async()=>{
 const leader=await acquireExecutor();if(!leader)throw Error('test_leader_unavailable');
 let attempts=0,waiting=0,settled=false;
 const standby=waitForExecutor({retryMs:20,onWaiting:()=>{waiting++;},acquire:async()=>{attempts++;return acquireExecutor();}}).then(value=>{settled=true;return value;});
 let next:null|Awaited<ReturnType<typeof acquireExecutor>>=null,leaderReleased=false;
 try{
  await until(()=>attempts>=2);
  expect(settled).toBe(false);expect(waiting).toBe(1);
  const locks=await db`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=721440139 AND granted`;
  expect(locks).toHaveLength(1);
  await leader`SELECT pg_advisory_unlock(721440139)`;leader.release();leaderReleased=true;
  next=await standby;expect(next).not.toBeNull();
  const [{owned}]=await next!`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted) AS owned`;
  expect(owned).toBe(true);
  expect(await db`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=721440139 AND granted`).toHaveLength(1);
 }finally{
  if(!settled){if(!leaderReleased){await leader`SELECT pg_advisory_unlock(721440139)`;leader.release();leaderReleased=true;}next=await standby;}
  if(next){await next`SELECT pg_advisory_unlock(721440139)`;next.release();}
 }
});

test('a waiting executor stops cleanly without another acquisition attempt',async()=>{
 const controller=new AbortController();let attempts=0;
 const waiting=waitForExecutor({signal:controller.signal,retryMs:10,acquire:async()=>{attempts++;return null;}});
 await until(()=>attempts===1);controller.abort();
 expect(await waiting).toBeNull();await Bun.sleep(25);expect(attempts).toBe(1);
});
