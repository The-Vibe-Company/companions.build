import {afterAll,expect,test} from 'bun:test';
import {db,migrate} from '../src/store';
import {encrypt} from '../src/config';

afterAll(()=>db.close());
test('the complete previous schema upgrades with real foreign keys while permanent machines, skills, history and billing survive',async()=>{
 await db.begin(async tx=>{await tx.unsafe(await Bun.file(new URL('./fixtures/pre-discussions-schema.sql',import.meta.url)).text());});
 const owner=crypto.randomUUID(),permanent=crypto.randomUUID(),legacy=crypto.randomUUID(),profile=crypto.randomUUID(),bundle=crypto.randomUUID();
 const original=crypto.randomUUID(),routine=crypto.randomUUID(),legacyRun=crypto.randomUUID(),ledger=crypto.randomUUID();
 await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${owner},'Upgrade fixture',${owner+'@example.test'},true)`;
 await db`INSERT INTO agent_templates(id,owner_id,name,instructions) VALUES(${profile},${owner},'Old profile','Keep permanent instructions')`;
 for(const id of [permanent,legacy])await db`INSERT INTO companions(id,owner_id,name,provider,create_key,agent_secret) VALUES(${id},${owner},'Upgrade fixture','box',${crypto.randomUUID()},${encrypt('fixture-agent-key')})`;
 await db`UPDATE companions SET template_id=${profile},snapshot_name='retained-permanent-snapshot',box_id='retained-permanent-box',instructions='Preserved instructions',status='ready',endpoint_secret=${encrypt('http://fixture.invalid')},create_started_at=now() WHERE id=${permanent}`;
 await db`UPDATE companions SET temporary=true,parent_id=${permanent},box_id='archived-legacy-box',create_started_at=now(),archive_requested_at=now(),archived_at=now() WHERE id=${legacy}`;
 await db`INSERT INTO portable_skill_bundles(id,source_owner_id,source_companion_id,manifest_version,bundle_hash,object_sha256,byte_size,storage_key) VALUES(${bundle},${owner},${legacy},1,${'a'.repeat(64)},${'b'.repeat(64)},25,'retained-skill-bundle')`;
 // The old staging path prefers the pinned revision bundle; it need not exist on the companion row.
 await db`INSERT INTO template_revisions(template_id,revision,owner_id,name,instructions,avatar,skill_bundle_id) VALUES(${profile},1,${owner},'Pinned profile','Preserved instructions',${{}},${bundle})`;
 await db`UPDATE companions SET template_revision=1 WHERE id=${permanent}`;
 const deliveries:Array<{id:string;expected:string}>=[];
 for(const [mainStatus,templateStatus] of [['ready','pending'],['ready','error'],['pending','ready'],['error','ready']]){
  const id=crypto.randomUUID();deliveries.push({id,expected:mainStatus!});
  await db`INSERT INTO companion_deliveries(id,client_delivery_id,request_fingerprint,source_owner_id,source_companion_id,recipient_email,profile_snapshot,expires_at,include_skills,skills_status,skills_error)
   VALUES(${id},${id},${id},${owner},${permanent},'recipient@example.test',${{name:'Preserved delivery',instructions:'Retained instructions',avatar:null}},now()+interval '7 days',true,${templateStatus==='error'||mainStatus==='error'?'error':'pending'},'Old aggregate error')`;
  await db`INSERT INTO portable_skill_exports(id,delivery_id,source_owner_id,source_companion_id,target_kind,status,bundle_id)
   VALUES(${crypto.randomUUID()},${id},${owner},${permanent},'delivery_main',${mainStatus!},${mainStatus==='ready'?bundle:null})`;
  await db`INSERT INTO portable_skill_exports(id,delivery_id,source_owner_id,source_companion_id,target_kind,source_template_id,status,bundle_id)
   VALUES(${crypto.randomUUID()},${id},${owner},${permanent},'delivery_template',${profile},${templateStatus!},${templateStatus==='ready'?bundle:null})`;
 }
 for(const [id,c,source] of [[original,permanent,'chat'],[routine,permanent,'routine'],[legacyRun,legacy,'chat']]){
  await db`INSERT INTO runs(id,companion_id,client_message_id,content,source,status) VALUES(${id!},${c!},${crypto.randomUUID()},${source==='routine'?'Removed scheduled work':'Retained conversation'},${source!},'succeeded')`;
  await db`INSERT INTO messages(id,companion_id,run_id,role,content) VALUES(${crypto.randomUUID()},${c!},${id!},'user','History fixture')`;
 }
 await db`INSERT INTO usage_ledger(id,owner_id,companion_id,operation_id,category,quantity,unit,occurred_at) VALUES(${ledger},${owner},${legacy},${'upgrade-'+ledger},'model_tokens',13,'token',now())`;
 expect((await migrate()).applied).toBe(true);
 expect(await db`SELECT id FROM companions WHERE id=${legacy}`).toHaveLength(0);
 expect(await db`SELECT id FROM runs WHERE id IN (${routine},${legacyRun})`).toHaveLength(0);
 expect((await db`SELECT id,box_id,snapshot_name,instructions,agent_state_layout,skill_bundle_id FROM companions WHERE id=${permanent}`)[0]).toEqual({id:permanent,box_id:'retained-permanent-box',snapshot_name:'retained-permanent-snapshot',instructions:'Preserved instructions',agent_state_layout:'per_companion',skill_bundle_id:bundle});
 expect((await db`SELECT discussion_id FROM runs WHERE id=${original}`)[0].discussion_id).toBe(permanent);
 expect(await db`SELECT id FROM discussion_messages WHERE run_id=${original}`).toHaveLength(1);
 expect(await db`SELECT id FROM discussion_messages WHERE run_id=${routine}`).toHaveLength(0);
 expect((await db`SELECT quantity::text,companion_id FROM usage_ledger WHERE id=${ledger}`)[0]).toEqual({quantity:'13',companion_id:null});
 expect((await db`SELECT storage_key FROM portable_skill_bundles WHERE id=${bundle}`)[0].storage_key).toBe('retained-skill-bundle');
 for(const delivery of deliveries){
  expect((await db`SELECT skills_status,skills_error,email_status FROM companion_deliveries WHERE id=${delivery.id}`)[0]).toEqual({skills_status:delivery.expected,skills_error:delivery.expected==='error'?'Portable skills could not be prepared.':null,email_status:'pending'});
  expect(await db`SELECT id FROM portable_skill_exports WHERE delivery_id=${delivery.id}`).toHaveLength(1);
 }
 expect((await db`SELECT to_regclass('public.agent_templates') AS templates,to_regclass('public.routines') AS routines,to_regclass('public.triggers') AS triggers`)[0]).toEqual({templates:null,routines:null,triggers:null});
 expect((await migrate()).applied).toBe(false);
 await db`DELETE FROM companions_schema_state`;
 expect((await migrate()).applied).toBe(true);
 expect((await db`SELECT agent_state_layout FROM companions WHERE id=${permanent}`)[0].agent_state_layout).toBe('per_companion');
});
