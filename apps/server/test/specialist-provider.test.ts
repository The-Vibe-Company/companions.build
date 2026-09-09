import {beforeAll,afterEach,expect,test} from 'bun:test';
import {db,migrate,createCompanion} from '../src/store';
import {requestMachineAdmission,progressMachineAdmissions} from '../src/admission';
import {deferRejectedBoxStart,renewSpecialistProviderLifetime} from '../src/specialist-provider';
import {BoxClient,BoxError} from '../../../packages/box/client';
beforeAll(()=>migrate());
afterEach(async()=>{await db`UPDATE machine_provider_limits SET cooldown_until=null`;});
test('an explicit rejected start returns to its original queue position and respects provider cooldown',async()=>{
 const owner='00000000-0000-4000-8000-000000000001';
 const c=await createCompanion(owner,{name:'Limited Box',provider:'box'});
 const command=crypto.randomUUID();
 await requestMachineAdmission(owner,{requestId:command,companionId:c.id,kind:'configuration'});
 const client=new BoxClient('synthetic', (async()=>new Response('private provider body',{status:429})) as any);
 let rejection:unknown;try{await client.create('stable-key');}catch(error){rejection=error;}
 const started=new Date(Date.now()-4*60_000);await db`UPDATE companions SET preparation_started_at=${started},create_started_at=now() WHERE id=${c.id}`;
 expect(await deferRejectedBoxStart(db,c.id,rejection)).toBe(true);
 const [deferred]=await db`SELECT preparation_started_at,create_started_at FROM companions WHERE id=${c.id}`;
 expect(new Date(deferred.preparation_started_at).getTime()).toBe(started.getTime());expect(deferred.create_started_at).toBeNull();
 await progressMachineAdmissions(db);
 expect((await db`SELECT state,waiting_reason FROM machine_admission_requests WHERE id=${command}`)[0]).toMatchObject({state:'queued',waiting_reason:'provider_cooldown'});
 await db`UPDATE machine_provider_limits SET cooldown_until=now()-interval '1 second'`;
 await progressMachineAdmissions(db);
 expect((await db`SELECT state FROM machine_admission_requests WHERE id=${command}`)[0].state).toBe('admitted');
});
test('an ambiguous transport or a rejected command is not classified as a rejected machine start',async()=>{
 expect(await deferRejectedBoxStart(db,crypto.randomUUID(),new BoxError('box_unreachable'))).toBe(false);
 const client=new BoxClient('synthetic',(async()=>new Response('private',{status:429})) as any);
 let rejection:unknown;try{await client.command('existing','true');}catch(error){rejection=error;}
 expect(await deferRejectedBoxStart(db,crypto.randomUUID(),rejection)).toBe(false);
});
test('an ambiguous lifetime extension is reconciled without repeating PATCH',async()=>{
 const c=await createCompanion('00000000-0000-4000-8000-000000000001',{name:'Maintained specialist',provider:'box'});
 await db`UPDATE companions SET temporary=true,box_id='ttl-box',keep_alive_until=now()+interval '30 minutes' WHERE id=${c.id}`;
 let extensions=0;
 const provider:any={get:async()=>({archiveAfter:new Date(Date.now()+30*60_000).toISOString()}),extend:async()=>{extensions++;throw new BoxError('box_unreachable');}};
 await renewSpecialistProviderLifetime(db,provider,c.id,async()=>{});
 await db`UPDATE companions SET provider_ttl_checked_at=now()-interval '16 minutes' WHERE id=${c.id}`;
 await renewSpecialistProviderLifetime(db,provider,c.id,async()=>{});
 expect(extensions).toBe(1);
 expect((await db`SELECT provider_ttl_target_until FROM companions WHERE id=${c.id}`)[0].provider_ttl_target_until).not.toBeNull();
});
test('lifetime renewal rechecks archive intent after observing the provider',async()=>{
 const c=await createCompanion('00000000-0000-4000-8000-000000000001',{name:'Stopping specialist',provider:'box'});
 await db`UPDATE companions SET temporary=true,box_id='stopping-box',keep_alive_until=now()+interval '30 minutes' WHERE id=${c.id}`;
 let extensions=0;
 const provider:any={get:async()=>{await db`UPDATE companions SET archive_requested_at=now() WHERE id=${c.id}`;return {archiveAfter:new Date().toISOString()};},extend:async()=>{extensions++;}};
 await renewSpecialistProviderLifetime(db,provider,c.id,async()=>{});
 expect(extensions).toBe(0);
});
