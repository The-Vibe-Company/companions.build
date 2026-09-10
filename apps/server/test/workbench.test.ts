import {beforeAll,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {handler} from '../src/api';
import {setMagicLinkDeliveryForTests} from '../src/auth';
import {configureCompanion} from '../src/control';
import {Conflict,createCompanion,db,migrate} from '../src/store';
import {publishArtifactRevision,readArtifactPreview,readWorkbench} from '../src/workbench';
import {designSkill} from '../../../packages/workbench/profiles';
import type {ArtifactPublication} from '../../../packages/workbench/artifacts';

beforeAll(async()=>{await migrate();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${other},'Other owner','workbench-other@example.test',true) ON CONFLICT DO NOTHING`;});
const owner='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
async function signIn(label:string){let link='';setMagicLinkDeliveryForTests(message=>{link=message.url;});await handler(new Request('http://127.0.0.1:4310/api/auth/sign-in/magic-link',{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:4310'},body:JSON.stringify({email:`${label}-${crypto.randomUUID()}@example.com`,callbackURL:'/'})}));const verified=await handler(new Request(link,{redirect:'manual'}));const cookie=verified.headers.get('set-cookie')!.split(';')[0]!;const me=await handler(new Request('http://127.0.0.1:4310/api/me',{headers:{cookie}}));return {cookie,ownerId:(await me.json() as any).user.id as string};}
async function designCompanion(ownerId=owner){
 const id=crypto.randomUUID();
 await db`INSERT INTO companions(id,owner_id,name,instructions,provider,create_key,agent_secret,profile_id)
  VALUES(${id},${ownerId},'Design workbench','',${'local'},${crypto.randomUUID()},${'historical-secret'},'design-v1')`;
 return {id,profileId:'design-v1' as const};
}
async function run(companionId:string,lane:'main'|'background'='main',responseRootId:string|null=null){const id=crypto.randomUUID();await db`INSERT INTO runs(id,companion_id,client_message_id,content,lane,response_root_id) VALUES(${id},${companionId},${crypto.randomUUID()},'Create artifact',${lane},${responseRootId})`;return id;}
function publication(companionId:string,runId:string,artifactId=crypto.randomUUID(),revision=1,previousRevisionId:string|null=null,status:'ready'|'failed'='ready',conversationId=companionId,conversationKind:'main'|'background'='main'):ArtifactPublication{
 const html=status==='ready'?`<main>revision ${revision}</main>`:null;
 return {manifest:{schemaVersion:1,artifactId,revisionId:crypto.randomUUID(),revision,previousRevisionId,title:'Landing page',kind:'static-html',renderer:'sandboxed-html-v1',status,failureCode:status==='failed'?'generation_failed':null,source:{workspacePath:'artifacts/landing.html',sha256:createHash('sha256').update(html??'').digest('hex')},provenance:{companionId,runId,conversation:{kind:conversationKind,id:conversationId},profileId:'design-v1',skill:designSkill},createdAt:new Date().toISOString()},html};
}

test('profile migration preserves legacy null and profiles are immutable',async()=>{
 const legacy=await createCompanion(owner,{name:'Legacy',provider:'local'}),creationId=crypto.randomUUID();
 const first=await createCompanion(owner,{name:'Compatible retry',provider:'local',clientCreationId:creationId});
 const stored=(await db`SELECT creation_fingerprint FROM companions WHERE id=${first.id}`)[0].creation_fingerprint;await migrate();
 expect((await db`SELECT profile_id FROM companions WHERE id=${legacy.id}`)[0].profile_id).toBeNull();
 expect((await createCompanion(owner,{name:'Compatible retry',provider:'local',clientCreationId:creationId,profileId:null})).id).toBe(first.id);
 expect(stored).toBe('682a795707d09a930a3b50c62d15b16d918a4bbd6de8aa406c126c9037ba44bb');
 expect((await db`SELECT creation_fingerprint FROM companions WHERE id=${first.id}`)[0].creation_fingerprint).toBe(stored);
 await expect(createCompanion(owner,{name:'Compatible retry',provider:'local',clientCreationId:creationId,profileId:'default-v1'})).rejects.toBeInstanceOf(Conflict);
 const explicit=await designCompanion();expect(explicit.profileId).toBe('design-v1');
 await expect(configureCompanion(owner,explicit.id,{profileId:'default-v1'})).rejects.toThrow();
 await expect((async()=>await db`UPDATE companions SET profile_id='default-v1' WHERE id=${explicit.id}`)()).rejects.toThrow('companion profile is immutable');
 await expect((async()=>await db`UPDATE companions SET profile_id='design-v1' WHERE id=${legacy.id}`)()).rejects.toThrow('companion profile is immutable');
});

test('creation API validates and returns profile IDs',async()=>{
 const {cookie}=await signIn('profile');
 const create=(profileId:string)=>handler(new Request('http://127.0.0.1:4310/api/companions',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({name:'Profiled',provider:'local',prepare:false,profileId})}));
 const accepted=await create('design-v2');expect(accepted.status).toBe(201);const companion=(await accepted.json() as any).companion;expect(companion.profileId).toBe('design-v2');
 expect((await create('design-v1')).status).toBe(409);expect((await create('made-up-v1')).status).toBe(400);
 const patch=await handler(new Request(`http://127.0.0.1:4310/api/companions/${companion.id}`,{method:'PATCH',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({profileId:'default-v1'})}));expect(patch.status).toBe(400);
});

test('HTTP workbench and preview reads are owner scoped and support retired Companions',async()=>{
 const mine=await signIn('workbench-owner'),theirs=await signIn('workbench-other'),companion=await designCompanion(mine.ownerId),runId=await run(companion.id),artifactId=crypto.randomUUID(),first=publication(companion.id,runId,artifactId);await publishArtifactRevision(mine.ownerId,first);
 const get=(path:string,cookie:string)=>handler(new Request(`http://127.0.0.1:4310/api/companions/${companion.id}${path}`,{headers:{cookie}}));
 expect((await get('/workbench',mine.cookie)).status).toBe(200);expect((await get(`/artifacts/${artifactId}/preview`,mine.cookie)).status).toBe(200);expect((await get('/workbench',theirs.cookie)).status).toBe(404);expect((await get(`/artifacts/${artifactId}/preview`,theirs.cookie)).status).toBe(404);
 const second=publication(companion.id,runId,artifactId,2,first.manifest.revisionId);await publishArtifactRevision(mine.ownerId,second);const historical=await get(`/artifacts/${artifactId}/preview?revisionId=${first.manifest.revisionId}`,mine.cookie);expect(historical.status).toBe(200);expect((await historical.json() as any).revisionId).toBe(first.manifest.revisionId);
 await db`UPDATE companions SET retired_at=now() WHERE id=${companion.id}`;
 expect((await get('/workbench',mine.cookie)).status).toBe(200);expect((await get(`/artifacts/${artifactId}/preview`,mine.cookie)).status).toBe(200);await expect(publishArtifactRevision(mine.ownerId,publication(companion.id,runId,artifactId,3,second.manifest.revisionId))).rejects.toThrow('Companion not found');
});

test('publication validates ownership, run, conversation, profile and skill',async()=>{
 const companion=await designCompanion(),runId=await run(companion.id),valid=publication(companion.id,runId);
 await expect(publishArtifactRevision(other,valid)).rejects.toBeInstanceOf(Conflict);
 const foreign=await designCompanion(other),foreignRun=await run(foreign.id);await expect(publishArtifactRevision(owner,publication(companion.id,foreignRun))).rejects.toBeInstanceOf(Conflict);
 await expect(publishArtifactRevision(owner,publication(companion.id,runId,undefined,1,null,'ready',crypto.randomUUID()))).rejects.toBeInstanceOf(Conflict);
 const ordinary=await createCompanion(owner,{name:'Ordinary',provider:'local',profileId:'default-v1'}),ordinaryRun=await run(ordinary.id);await expect(publishArtifactRevision(owner,publication(ordinary.id,ordinaryRun))).rejects.toThrow('design profile');
 const forged={...valid,manifest:{...valid.manifest,provenance:{...valid.manifest.provenance,skill:{...designSkill,version:'9.9.9'}}}};await expect(publishArtifactRevision(owner,forged)).rejects.toThrow();
});

test('revisions are sequential, idempotent and retain the last ready preview',async()=>{
 const companion=await designCompanion(),runId=await run(companion.id),artifactId=crypto.randomUUID(),first=publication(companion.id,runId,artifactId);const duplicate=await Promise.all(Array.from({length:8},()=>publishArtifactRevision(owner,first)));expect(duplicate.every(value=>value.manifest.revisionId===first.manifest.revisionId)).toBe(true);
 expect((await db`SELECT revision_id FROM artifact_revisions WHERE revision_id=${first.manifest.revisionId}`).length).toBe(1);expect((await db`SELECT id FROM workbench_events WHERE revision_id=${first.manifest.revisionId}`).length).toBe(1);
 await expect(publishArtifactRevision(owner,{...first,html:'<main>changed</main>'})).rejects.toThrow();
 await expect(publishArtifactRevision(owner,publication(companion.id,runId,artifactId,3,first.manifest.revisionId))).rejects.toBeInstanceOf(Conflict);
 const failed=publication(companion.id,runId,artifactId,2,first.manifest.revisionId,'failed');await publishArtifactRevision(owner,failed);
 expect(await readArtifactPreview(owner,companion.id,artifactId)).toEqual({revisionId:first.manifest.revisionId,html:first.html!});expect(await readArtifactPreview(owner,companion.id,artifactId,failed.manifest.revisionId)).toEqual({revisionId:first.manifest.revisionId,html:first.html!});
 const third=publication(companion.id,runId,artifactId,3,failed.manifest.revisionId);await publishArtifactRevision(owner,third);expect(await readArtifactPreview(owner,companion.id,artifactId)).toEqual({revisionId:third.manifest.revisionId,html:third.html!});expect(await readArtifactPreview(owner,companion.id,artifactId,failed.manifest.revisionId)).toEqual({revisionId:first.manifest.revisionId,html:first.html!});
 await expect((async()=>await db`UPDATE artifact_revisions SET html='changed' WHERE revision_id=${first.manifest.revisionId}`)()).rejects.toThrow('append-only');
 const snapshot=await readWorkbench(owner,companion.id);expect(snapshot?.revisions.map(value=>value.revision)).toEqual([3,2,1]);expect(snapshot?.events).toHaveLength(3);expect(await readWorkbench(other,companion.id)).toBeNull();
});

test('background provenance uses response root and ready html matches source hash',async()=>{
 const companion=await designCompanion(),root=await run(companion.id),background=await run(companion.id,'background',root),valid=publication(companion.id,background,undefined,1,null,'ready',root,'background');await publishArtifactRevision(owner,valid);
 const bad=publication(companion.id,background,undefined,1,null,'ready',root,'background');bad.manifest.source.sha256='0'.repeat(64);await expect(publishArtifactRevision(owner,bad)).rejects.toThrow('source hash');
});
