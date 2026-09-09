import {afterEach,beforeAll,expect,test} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {acquireExecutor,tick} from '../src/executor';
import {handleLifecycle,progressLifecycle,type LifecycleMachines} from '../src/lifecycle';
import {pauseMachine,ExecutionStopped} from '../src/machines';
import {BoxError} from '../../../packages/box/client';
import {AgentDaemon} from '../../../packages/agent/src/daemon';
import {decrypt} from '../src/config';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const owner='00000000-0000-4000-8000-000000000001';
const ids:string[]=[];
beforeAll(migrate);
afterEach(async()=>{for(const id of ids.splice(0)){await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id} AND status IN ('queued','preparing','running','needs_input')`;await db`UPDATE companions SET retired_at=now(),prepare_requested=false WHERE id=${id}`;}});
async function fixture(){
 const c=await createCompanion(owner,{name:'Desktop test',instructions:'',provider:'box'});ids.push(c.id);
 const [row]=await db`SELECT * FROM companions WHERE id=${c.id}`;
 const daemon=new AgentDaemon(mkdtempSync(join(tmpdir(),'desktop-runtime-')),decrypt(row.agent_secret),{async execute(_id,input){return {text:`Headless: ${input.content}`};},async cancel(){}},undefined,1);
 const server=Bun.serve({port:0,fetch:r=>daemon.fetch(r)});
 const machine:LifecycleMachines={async prepare(c,checkpoint){await checkpoint(c.box_id??'owned-box');return `http://127.0.0.1:${server.port}`;},async health(){return {ready:true,desktopBoundaryVersion:1};},async pause(c,taken,guard){await guard?.();return {generation:Number(c.desktop_generation),taken,confirmed:true,bootId:'boot-one'};},async archive(){return true;},async snapshot(){},async snapshotStatus(){return 'ready';}};
 const sql=await acquireExecutor();if(!sql)throw Error('lock unavailable');
 return {id:c.id as string,sql,machine,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();server.stop(true);daemon.close();}};
}

test('confirmed desktop takeover admits and settles chat while retaining human ownership',async()=>{
 const f=await fixture();
 try{
  await handleLifecycle({operation:'desktop_takeover',companionId:f.id,source:'human'},owner);
  const run=await acceptMessage(owner,f.id,crypto.randomUUID(),'Keep working');
  for(let i=0;i<4;i++){await tick(f.sql,{lifecycleMachines:f.machine});await Bun.sleep(10);}
  const [result]=await db`SELECT status,result_text FROM runs WHERE id=${run}`;
  expect(result).toMatchObject({status:'succeeded',result_text:'Headless: Keep working'});
  const [c]=await db`SELECT desktop_taken,desktop_paused_at,desktop_generation,desktop_observed_generation FROM companions WHERE id=${f.id}`;
  expect(c.desktop_taken).toBe(true);expect(c.desktop_paused_at).not.toBeNull();expect(Number(c.desktop_observed_generation)).toBe(Number(c.desktop_generation));
 }finally{await f.close();}
});

test('only a human release changes an active takeover; repeated requests retain generation',async()=>{
 const f=await fixture();
 try{
  const first=await handleLifecycle({operation:'desktop_takeover',companionId:f.id,source:'human'},owner);
  const repeat=await handleLifecycle({operation:'desktop_takeover',companionId:f.id,source:'human'},owner);
  expect(Number(repeat.generation)).toBe(Number(first.generation));
  await expect(handleLifecycle({operation:'desktop_release',companionId:f.id,source:'agent',input:{source:'human'}},owner)).rejects.toThrow('HUMAN_DESKTOP_RELEASE_REQUIRED');
  expect((await db`SELECT desktop_taken FROM companions WHERE id=${f.id}`)[0].desktop_taken).toBe(true);
  const released=await handleLifecycle({operation:'desktop_release',companionId:f.id,source:'human'},owner);
  expect(Number(released.generation)).toBe(Number(first.generation)+1);
 }finally{await f.close();}
});

test('a late takeover observation cannot confirm over a newer release generation',async()=>{
 const f=await fixture();let observed!:()=>void,finish!:()=>void;
 const started=new Promise<void>(r=>observed=r),barrier=new Promise<void>(r=>finish=r);
 try{
  await handleLifecycle({operation:'desktop_takeover',companionId:f.id},owner);
  f.machine.pause=async(c,taken)=>{observed();await barrier;return {generation:Number(c.desktop_generation),taken,confirmed:true,bootId:'old-boot'};};
  const progressing=progressLifecycle(f.sql,{},f.machine);
  await started;
  await handleLifecycle({operation:'desktop_release',companionId:f.id,source:'human'},owner);
  finish();await progressing;
  const [c]=await db`SELECT desktop_taken,desktop_paused_at,desktop_observed_generation FROM companions WHERE id=${f.id}`;
  expect(c).toMatchObject({desktop_taken:false,desktop_paused_at:null,desktop_observed_generation:null});
 }finally{finish?.();await f.close();}
});

test('machine adapter performs no desktop mutation if authority is lost during observation',async()=>{
 let active=true;const commands:string[]=[];
 const client={async command(_id:string,command:string){commands.push(command);active=false;return JSON.stringify({generation:0,taken:false,confirmed:true,bootId:'boot'});}} as any;
 await expect(pauseMachine({provider:'box',box_id:'owned',desktop_boundary_version:1,desktop_generation:1},true,async()=>{if(!active)throw new ExecutionStopped('lost');},client)).rejects.toBeInstanceOf(ExecutionStopped);
 expect(commands).toEqual(['sudo -n /usr/local/bin/companions-desktop-state']);
});

test('machine adapter provisions a lazy Box desktop before its first broker reconciliation',async()=>{
 const effects:string[]=[];let provisioning=true;
 const client={
  async desktop(id:string){effects.push(`desktop:${id}`);if(provisioning)throw new BoxError('desktop_preparing');return 'https://fixture.on.ascii.dev/vnc.html?_token=synthetic';},
  async command(_id:string,command:string){
   effects.push(command);
   if(!command.includes(' 0 false'))return JSON.stringify({generation:0,taken:true,confirmed:false,bootId:'boot'});
   return JSON.stringify({generation:0,taken:false,confirmed:true,bootId:'boot'});
  },
 } as any;
 const companion={provider:'box',box_id:'owned',desktop_boundary_version:1,desktop_generation:0,desktop_observed_generation:null};
 await expect(pauseMachine(companion,false,undefined,client)).rejects.toThrow('desktop_preparing');
 expect(effects).toEqual(['sudo -n /usr/local/bin/companions-desktop-state','desktop:owned']);

 provisioning=false;effects.length=0;
 await expect(pauseMachine(companion,false,undefined,client)).resolves.toMatchObject({generation:0,taken:false,confirmed:true});
 expect(effects).toEqual([
  'sudo -n /usr/local/bin/companions-desktop-state',
  'desktop:owned',
  'sudo -n /usr/local/bin/companions-desktop-state 0 false',
 ]);
});

test('machine adapter rechecks executor authority after lazy desktop provisioning',async()=>{
 let active=true;const commands:string[]=[];
 const client={
  async desktop(){active=false;return 'https://fixture.on.ascii.dev/vnc.html?_token=synthetic';},
  async command(_id:string,command:string){commands.push(command);return JSON.stringify({generation:0,taken:true,confirmed:false,bootId:'boot'});},
 } as any;
 const companion={provider:'box',box_id:'owned',desktop_boundary_version:1,desktop_generation:0,desktop_observed_generation:null};
 await expect(pauseMachine(companion,false,async()=>{if(!active)throw new ExecutionStopped('lost');},client)).rejects.toBeInstanceOf(ExecutionStopped);
 expect(commands).toEqual(['sudo -n /usr/local/bin/companions-desktop-state']);
});
