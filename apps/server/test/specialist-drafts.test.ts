import {beforeAll,expect,test} from 'bun:test';
import {db,migrate,createCompanion} from '../src/store';
import {saveTemplate,listTemplates,allowTemplate} from '../src/templates';
import {spawnChild} from '../src/delegation';
import {openSpecialistDraft,readSpecialistDraft,updateSpecialistDraft,requestSpecialistPublication,requestSpecialistTest} from '../src/specialist-drafts';
import {progressSpecialistDrafts} from '../src/specialist-runtime';
const owner='00000000-0000-4000-8000-000000000001';
beforeAll(()=>migrate());
test('configuring a specialist preserves published instructions, applies identity and rejects a stale edit',async()=>{
 const profile=await saveTemplate(owner,{name:'Developer',instructions:'Published instructions'});
 const opened=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 const changed=await updateSpecialistDraft(owner,profile.id,{expectedGeneration:opened.draft.generation,expectedIdentityRevision:opened.draft.identityRevision,instructions:'Draft instructions',initScript:'git fetch origin',avatar:{shape:2,color:5,face:1}});
 expect(changed.draft.instructions).toBe('Draft instructions');
 expect(changed.draft.avatar).toEqual({shape:2,color:5,face:1});
 expect((await listTemplates(owner)).find((p:any)=>p.id===profile.id).avatar).toEqual({shape:2,color:5,face:1});
 expect((await listTemplates(owner)).find((p:any)=>p.id===profile.id).instructions).toBe('Published instructions');
 await expect(updateSpecialistDraft(owner,profile.id,{expectedGeneration:opened.draft.generation,expectedIdentityRevision:opened.draft.identityRevision,instructions:'Lost update'})).rejects.toThrow();
 expect(await readSpecialistDraft('another-owner',profile.id)).toBeNull();
});

test('identity applies immediately to the library and missions without publishing or invalidating configuration',async()=>{
 const profile=await saveTemplate(owner,{name:'Old name',instructions:'Published instructions'});
 const parent=await createCompanion(owner,{name:'Identity parent',provider:'local'});
 await allowTemplate(owner,parent.id,{templateId:profile.id,maxChildren:2});
 const existing=await spawnChild(owner,parent.id,null,crypto.randomUUID(),{templateId:profile.id,prompt:'Existing mission'});
 const {draft}=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 const renamed=await updateSpecialistDraft(owner,profile.id,{expectedGeneration:draft.generation,expectedIdentityRevision:draft.identityRevision,name:'Robin',avatar:{shape:2,color:5,face:1}});
 expect(renamed.draft.generation).toBe(draft.generation);
 expect(renamed.draft.identityRevision).toBe(draft.identityRevision+1);
 await expect(updateSpecialistDraft(owner,profile.id,{expectedGeneration:draft.generation,expectedIdentityRevision:draft.identityRevision,name:'Old name',avatar:{shape:1,color:2,face:0}})).rejects.toThrow('Identity changed');
 await expect(updateSpecialistDraft(owner,profile.id,{expectedGeneration:draft.generation,name:'Missing token'})).rejects.toThrow('Identity changed');
 expect(renamed.draft.publication).toBeNull();
 const library=(await listTemplates(owner)).find((p:any)=>p.id===profile.id);
 expect(library).toMatchObject({name:'Robin',avatar:{shape:2,color:5,face:1},revision:1,instructions:'Published instructions',hasPublished:true});
 const next=await spawnChild(owner,parent.id,null,crypto.randomUUID(),{templateId:profile.id,prompt:'Next mission'});
 const identities=await db`SELECT name,avatar FROM companions WHERE id IN (${draft.companionId},${existing.companionId},${next.companionId})`;
 expect(identities).toHaveLength(3);
 for(const identity of identities)expect(identity).toMatchObject({name:'Robin',avatar:{shape:2,color:5,face:1}});
 const [unchanged]=await db`SELECT instructions,template_revision FROM companions WHERE id=${existing.companionId}`;
 expect(unchanged).toMatchObject({instructions:'Published instructions',template_revision:1});
 await expect(updateSpecialistDraft('another-owner',profile.id,{expectedGeneration:draft.generation,expectedIdentityRevision:draft.identityRevision,name:'Forbidden'})).rejects.toThrow();
});
test('a confirmed prepared image publishes atomically without replacing the configuration conversation',async()=>{
 const profile=await saveTemplate(owner,{name:'Prepared writer',instructions:'Old'});
 const {draft}=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 await db`UPDATE companions SET provider='box',box_id='source-box',status='ready' WHERE id=${draft.companionId}`;
 const updated=await updateSpecialistDraft(owner,profile.id,{expectedGeneration:draft.generation,expectedIdentityRevision:draft.identityRevision,instructions:'New',avatar:{shape:3,color:6,face:2}});
 const {publication}=await requestSpecialistPublication(owner,profile.id,{commandId:crypto.randomUUID(),expectedGeneration:updated.draft.generation,contentReviewed:true});
 const snapshots=new Set<string>();let sanitized=0;
 const machines:any={freezeSpecialist:async()=>{},snapshotStatus:async(name:string)=>snapshots.has(name)?'ready':'missing',snapshot:async(_:any,name:string)=>{snapshots.add(name);},createSpecialistImage:async(_:any,checkpoint:any)=>{await checkpoint('image-box');return true;},sanitizeSpecialistImage:async()=>{sanitized++;}};
 const authority={assertLeader:async()=>{},checkpoint:<T>(fn:(tx:any)=>Promise<T>)=>db.begin(fn)};
 for(let i=0;i<10;i++){
  await progressSpecialistDrafts(db,machines,authority);
  // Provider archive acknowledgement is the only event that frees a source/image.
  await db`UPDATE companions SET archived_at=now(),archive_requested_at=null WHERE archive_requested_at IS NOT NULL`;
 }
 const result=await readSpecialistDraft(owner,profile.id);
 expect(result.draft.publication.status).toBe('succeeded');
 expect(result.draft.companionId).toBe(draft.companionId);
 expect((await listTemplates(owner)).find((p:any)=>p.id===profile.id).instructions).toBe('New');
 expect((await listTemplates(owner)).find((p:any)=>p.id===profile.id).avatar).toEqual({shape:3,color:6,face:2});
 expect(sanitized).toBe(1);
 expect(result.draft.publication.id).toBe(publication.id);
});
test('publication is durable and idempotent and needs explicit content review',async()=>{
 const profile=await saveTemplate(owner,{name:'Writer'});
 const {draft}=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 const commandId=crypto.randomUUID();
 await expect(requestSpecialistPublication(owner,profile.id,{commandId,expectedGeneration:draft.generation,contentReviewed:false})).rejects.toThrow();
 const input={commandId,expectedGeneration:draft.generation,contentReviewed:true};
 const first=await requestSpecialistPublication(owner,profile.id,input);
 const second=await requestSpecialistPublication(owner,profile.id,input);
 expect(second.publication.id).toBe(first.publication.id);
 expect(first.publication.status).toBe('queued');
 await expect(updateSpecialistDraft(owner,profile.id,{expectedGeneration:draft.generation,expectedIdentityRevision:draft.identityRevision,name:'During capture'})).rejects.toThrow();
});
test('publication reuses the exact tested image and waits for test file retention and archive acknowledgement',async()=>{
 const profile=await saveTemplate(owner,{name:'Tested developer',instructions:'Build the repository'});
 const {draft}=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 await db`UPDATE companions SET provider='box',box_id='source-tested',status='ready' WHERE id=${draft.companionId}`;
 const requested=await requestSpecialistTest(owner,profile.id,{commandId:crypto.randomUUID(),expectedGeneration:draft.generation,prompt:'Compile the repository'});
 const snapshots=new Set<string>();let captures=0,durable=false;
 const machines:any={freezeSpecialist:async()=>{},snapshotStatus:async(name:string)=>snapshots.has(name)?'ready':'missing',snapshot:async(_:any,name:string)=>{captures++;snapshots.add(name);},createSpecialistImage:async(_:any,checkpoint:any)=>{await checkpoint('image-tested');return true;},sanitizeSpecialistImage:async()=>{}};
 const authority={assertLeader:async()=>{},checkpoint:<T>(fn:(tx:any)=>Promise<T>)=>db.begin(fn)};
 const progress=()=>progressSpecialistDrafts(db,machines,authority,async()=>true,draft.companionId,async()=>durable);
 for(let i=0;i<8;i++){
  await progress();
  await db`UPDATE companions SET archived_at=now(),archive_requested_at=null WHERE archive_requested_at IS NOT NULL AND id IN (SELECT companion_id FROM specialist_drafts WHERE template_id=${profile.id} UNION SELECT image_companion_id FROM specialist_operations WHERE template_id=${profile.id})`;
 }
 const [operation]=await db`SELECT * FROM specialist_operations WHERE id=${requested.test.id}`;
 expect(operation.status).toBe('running');expect(operation.run_id).toBeTruthy();
 await db`UPDATE runs SET status='succeeded',finished_at=now() WHERE id=${operation.run_id}`;
 await progress();expect((await readSpecialistDraft(owner,profile.id)).draft.status).toBe('testing');
 durable=true;await progress();
 expect((await readSpecialistDraft(owner,profile.id)).draft.status).toBe('testing');
 await db`UPDATE companions SET archived_at=now(),archive_requested_at=null WHERE id=${operation.test_companion_id}`;
 await progress();expect((await readSpecialistDraft(owner,profile.id)).draft.lastTest.status).toBe('succeeded');
 const renamed=await updateSpecialistDraft(owner,profile.id,{expectedGeneration:draft.generation,expectedIdentityRevision:draft.identityRevision,name:'Renamed tested developer'});
 expect(renamed.draft.generation).toBe(draft.generation);
 const publication=await requestSpecialistPublication(owner,profile.id,{commandId:crypto.randomUUID(),expectedGeneration:draft.generation,contentReviewed:true});
 await progress();
 const [published]=await db`SELECT name,snapshot_name FROM agent_templates WHERE id=${profile.id}`;
 expect(published.name).toBe('Renamed tested developer');
 expect(published.snapshot_name).toBe(operation.snapshot_name);expect(captures).toBe(2);
 expect((await readSpecialistDraft(owner,profile.id)).draft.publication).toMatchObject({id:publication.publication.id,status:'succeeded'});
});
test('a cancelled operation cannot submit its snapshot or publish after its in-flight freeze returns',async()=>{
 const profile=await saveTemplate(owner,{name:'Cancelled capture'});
 const {draft}=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 await db`UPDATE companions SET provider='box',box_id='cancel-source',status='ready' WHERE id=${draft.companionId}`;
 const {publication}=await requestSpecialistPublication(owner,profile.id,{commandId:crypto.randomUUID(),expectedGeneration:draft.generation,contentReviewed:true});
 let captures=0;
 const machines:any={freezeSpecialist:async()=>{await db`UPDATE specialist_operations SET status='failed',error='Cancelled' WHERE id=${publication.id}`;},snapshotStatus:async()=> 'missing',snapshot:async()=>{captures++;},createSpecialistImage:async()=>true,sanitizeSpecialistImage:async()=>{}};
 const authority={assertLeader:async()=>{},checkpoint:<T>(fn:(tx:any)=>Promise<T>)=>db.begin(fn)};
 await progressSpecialistDrafts(db,machines,authority,async()=>true,draft.companionId);
 await progressSpecialistDrafts(db,machines,authority,async()=>true,draft.companionId);
 expect(captures).toBe(0);
 expect((await readSpecialistDraft(owner,profile.id)).draft.publication.status).toBe('failed');
 expect((await db`SELECT revision FROM agent_templates WHERE id=${profile.id}`)[0].revision).toBe(1);
});
test('cancellation during snapshot observation prevents the subsequent snapshot POST',async()=>{
 const profile=await saveTemplate(owner,{name:'Cancelled observation'});
 const {draft}=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 await db`UPDATE companions SET provider='box',box_id='observed-source',status='ready' WHERE id=${draft.companionId}`;
 const {publication}=await requestSpecialistPublication(owner,profile.id,{commandId:crypto.randomUUID(),expectedGeneration:draft.generation,contentReviewed:true});
 let captures=0;
 const machines:any={freezeSpecialist:async()=>{},snapshotStatus:async()=>{await db`UPDATE specialist_operations SET status='failed',error='Cancelled' WHERE id=${publication.id}`;return 'missing';},snapshot:async()=>{captures++;},createSpecialistImage:async()=>true,sanitizeSpecialistImage:async()=>{}};
 const authority={assertLeader:async()=>{},checkpoint:<T>(fn:(tx:any)=>Promise<T>)=>db.begin(fn)};
 await progressSpecialistDrafts(db,machines,authority,async()=>true,draft.companionId);
 await progressSpecialistDrafts(db,machines,authority,async()=>true,draft.companionId);
 expect(captures).toBe(0);
 expect((await readSpecialistDraft(owner,profile.id)).draft.publication.status).toBe('failed');
});
test('a create acknowledged after cancellation records the Box identity for cleanup without sanitizing it',async()=>{
 const profile=await saveTemplate(owner,{name:'Late image create'});
 const {draft}=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 await db`UPDATE companions SET provider='box',box_id='late-source',status='ready' WHERE id=${draft.companionId}`;
 const {publication}=await requestSpecialistPublication(owner,profile.id,{commandId:crypto.randomUUID(),expectedGeneration:draft.generation,contentReviewed:true});
 const snapshots=new Set<string>();let sanitized=0;
 const machines:any={freezeSpecialist:async()=>{},snapshotStatus:async(name:string)=>snapshots.has(name)?'ready':'missing',snapshot:async(_:any,name:string)=>{snapshots.add(name);},
  createSpecialistImage:async(image:any,checkpoint:any)=>{
   expect((await db`SELECT create_started_at FROM companions WHERE id=${image.id}`)[0].create_started_at).not.toBeNull();
   await db`UPDATE specialist_operations SET status='failed',error='Cancelled' WHERE id=${publication.id}`;
   await checkpoint('late-image-box');return true;
  },sanitizeSpecialistImage:async()=>{sanitized++;}};
 const authority={assertLeader:async()=>{},checkpoint:<T>(fn:(tx:any)=>Promise<T>)=>db.begin(fn)};
 for(let i=0;i<5;i++){
  await progressSpecialistDrafts(db,machines,authority,async()=>true,draft.companionId);
  await db`UPDATE companions SET archived_at=now(),archive_requested_at=null WHERE id=${draft.companionId} AND archive_requested_at IS NOT NULL`;
 }
 const [image]=await db`SELECT c.box_id,c.archive_requested_at FROM companions c JOIN specialist_operations o ON o.image_companion_id=c.id WHERE o.id=${publication.id}`;
 expect(image.box_id).toBe('late-image-box');expect(image.archive_requested_at).not.toBeNull();expect(sanitized).toBe(0);
});

test('only an active configuration specialist can persist its next chat card',async()=>{
 const {proposeSpecialistNextStep}=await import('../src/specialist-drafts');
 const profile=await saveTemplate(owner,{name:'Guided developer'});
 const {draft}=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 expect((await readSpecialistDraft(owner,profile.id)).draft.nextStep).toBeNull();
 const runId=crypto.randomUUID(),commandId=crypto.randomUUID();
 await db`INSERT INTO runs(id,companion_id,client_message_id,content,status) VALUES(${runId},${draft.companionId},${crypto.randomUUID()},'Prepare my repositories','running')`;
 const card={kind:'connections',message:'Connect GitHub and Linear so I can prepare your repositories.',providers:['github','linear']};
 await expect(proposeSpecialistNextStep('another-owner',draft.companionId,runId,commandId,card)).rejects.toThrow();
 await proposeSpecialistNextStep(owner,draft.companionId,runId,commandId,card);
 await proposeSpecialistNextStep(owner,draft.companionId,runId,commandId,card);
 expect((await readSpecialistDraft(owner,profile.id)).draft.nextStep).toMatchObject({...card,id:commandId});
 const [count]=await db`SELECT count(*)::int AS n FROM specialist_guidance WHERE id=${commandId}`;
 expect(count.n).toBe(1);
 await db`UPDATE runs SET cancel_requested=true WHERE id=${runId}`;
 await expect(proposeSpecialistNextStep(owner,draft.companionId,runId,crypto.randomUUID(),card)).rejects.toThrow();
});

test('publishes a sealed archived image without consuming named snapshot capacity',async()=>{
 const profile=await saveTemplate(owner,{name:'Archived specialist',instructions:'Review code'});
 const {draft}=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 await db`UPDATE companions SET provider='box',box_id='bx_source',status='ready' WHERE id=${draft.companionId}`;
 await requestSpecialistPublication(owner,profile.id,{commandId:crypto.randomUUID(),expectedGeneration:draft.generation,contentReviewed:true});
 let namedCaptures=0;
 const machines:any={archivedSpecialistImages:true,freezeSpecialist:async()=>{},snapshot:async()=>{namedCaptures++;throw Error('Named quota exhausted');},snapshotStatus:async(name:string)=>{
  const [image]=await db`SELECT archived_at FROM companions WHERE box_id=${name.slice(4)}`;
  return image?.archived_at?'ready':'pending';
 },createSpecialistImage:async(image:any,checkpoint:any)=>{expect(image.snapshot_name).toBe('box:bx_source');await checkpoint('bx_sealed');return true;},sanitizeSpecialistImage:async()=>{}};
 const authority={assertLeader:async()=>{},checkpoint:<T>(fn:(tx:any)=>Promise<T>)=>db.begin(fn)};
 for(let i=0;i<12;i++){
  await progressSpecialistDrafts(db,machines,authority,undefined,draft.companionId);
  await db`UPDATE companions SET archived_at=now(),archive_requested_at=null WHERE archive_requested_at IS NOT NULL AND box_id IN ('bx_source','bx_sealed')`;
 }
 const result=await readSpecialistDraft(owner,profile.id);
 expect(result.draft.publication.status).toBe('succeeded');expect(namedCaptures).toBe(0);
 const [version]=await db`SELECT prepared_disk_snapshot FROM agent_templates WHERE id=${profile.id}`;
 expect(version.prepared_disk_snapshot).toBe('box:bx_sealed');
 const [image]=await db`SELECT retired_at,archived_at FROM companions WHERE box_id='bx_sealed'`;
 expect(image.retired_at).not.toBeNull();expect(image.archived_at).not.toBeNull();
});


test('opening a legacy specialist requests its environment once before entering configuration chat',async()=>{
 const profile=await saveTemplate(owner,{name:'Legacy specialist',instructions:'Prepare development tools'});
 const commandId=crypto.randomUUID();
 const first=await openSpecialistDraft(owner,profile.id,{commandId});
 const retry=await openSpecialistDraft(owner,profile.id,{commandId});
 const reopen=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 expect(retry.draft.companionId).toBe(first.draft.companionId);
 expect(reopen.draft.companionId).toBe(first.draft.companionId);
 const admissions=await db`SELECT kind,state FROM machine_admission_requests WHERE companion_id=${first.draft.companionId}`;
 expect(admissions).toHaveLength(1);
 expect(admissions[0].kind).toBe('configuration');
 expect(['admitted','queued']).toContain(admissions[0].state);
 const [machine]=await db`SELECT prepare_requested FROM companions WHERE id=${first.draft.companionId}`;
 if(admissions[0].state==='admitted')expect(machine.prepare_requested).toBe(true);
 expect(await db`SELECT id FROM runs WHERE companion_id=${first.draft.companionId}`).toHaveLength(0);
});
