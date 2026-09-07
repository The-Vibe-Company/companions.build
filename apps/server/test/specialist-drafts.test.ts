import {beforeAll,expect,test} from 'bun:test';
import {db,migrate} from '../src/store';
import {saveTemplate,listTemplates} from '../src/templates';
import {openSpecialistDraft,readSpecialistDraft,updateSpecialistDraft,requestSpecialistPublication} from '../src/specialist-drafts';
import {progressSpecialistDrafts} from '../src/specialist-runtime';
const owner='00000000-0000-4000-8000-000000000001';
beforeAll(()=>migrate());
test('configuring a specialist preserves the published profile and rejects a stale edit',async()=>{
 const profile=await saveTemplate(owner,{name:'Developer',instructions:'Published instructions'});
 const opened=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 const changed=await updateSpecialistDraft(owner,profile.id,{expectedGeneration:opened.draft.generation,instructions:'Draft instructions',initScript:'git fetch origin'});
 expect(changed.draft.instructions).toBe('Draft instructions');
 expect((await listTemplates(owner)).find((p:any)=>p.id===profile.id).instructions).toBe('Published instructions');
 await expect(updateSpecialistDraft(owner,profile.id,{expectedGeneration:opened.draft.generation,instructions:'Lost update'})).rejects.toThrow();
 expect(await readSpecialistDraft('another-owner',profile.id)).toBeNull();
});
test('a confirmed prepared image publishes atomically without replacing the configuration conversation',async()=>{
 const profile=await saveTemplate(owner,{name:'Prepared writer',instructions:'Old'});
 const {draft}=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 await db`UPDATE companions SET provider='box',box_id='source-box',status='ready' WHERE id=${draft.companionId}`;
 const updated=await updateSpecialistDraft(owner,profile.id,{expectedGeneration:draft.generation,instructions:'New'});
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
 await expect(updateSpecialistDraft(owner,profile.id,{expectedGeneration:draft.generation,name:'During capture'})).rejects.toThrow();
});
