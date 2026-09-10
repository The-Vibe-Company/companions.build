import {beforeAll,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createDesignProject,listDesignProjects,readDesignProject,updateDesignProject} from '../src/design-projects';
import {acceptMessage,Conflict,createCompanion,db,migrate} from '../src/store';
import {publishDesign,readWorkbench} from '../src/workbench';
import {designRunContextSchema} from '../../../packages/workbench/projects';
import {acquireExecutor,claimQueuedRuns} from '../src/executor';
import {readArtifactPreview} from '../src/workbench';

const owner='00000000-0000-4000-8000-000000000001';
beforeAll(()=>migrate());
async function fixture(){return createCompanion(owner,{name:'Design projects',provider:'local',profileId:'design-v2'});}
const input=(name:string)=>({id:crypto.randomUUID(),name,brief:`Brief for ${name}`});

test('projects are bounded, searchable, owner scoped, idempotent and optimistic',async()=>{
 const companion=await fixture(),created=[];
 for(let index=0;index<45;index++)created.push(await createDesignProject(owner,companion.id,input(`Project ${String(index).padStart(2,'0')}`)));
 const first=await listDesignProjects(owner,companion.id);expect(first?.projects).toHaveLength(40);expect(first?.nextCursor).not.toBeNull();
 const second=await listDesignProjects(owner,companion.id,{cursor:first!.nextCursor!});expect(second?.projects).toHaveLength(5);
 expect((await listDesignProjects(owner,companion.id,{q:'Project 44'}))?.projects.map(project=>project.id)).toEqual([created[44]!.id]);
 expect(await createDesignProject(owner,companion.id,{id:created[0]!.id,name:created[0]!.name,brief:created[0]!.brief})).toEqual(created[0]);
 await expect(createDesignProject(owner,companion.id,{id:created[0]!.id,name:'Changed intent',brief:created[0]!.brief})).rejects.toBeInstanceOf(Conflict);
 const updated=await updateDesignProject(owner,companion.id,created[0]!.id,{expectedRevision:1,brief:'New brief'});expect(updated).toMatchObject({revision:2,brief:'New brief'});
 expect(await createDesignProject(owner,companion.id,{id:created[0]!.id,name:created[0]!.name,brief:created[0]!.brief})).toEqual(updated);
 await expect(updateDesignProject(owner,companion.id,created[0]!.id,{expectedRevision:1,archived:true})).rejects.toBeInstanceOf(Conflict);
 expect(await readDesignProject(crypto.randomUUID(),companion.id,created[0]!.id)).toBeNull();
});

test('project and brief changes queue independently while matching snapshots retain native steering',async()=>{
 const companion=await fixture(),a=await createDesignProject(owner,companion.id,input('Queue A')),b=await createDesignProject(owner,companion.id,input('Queue B'));
 const first=(await acceptMessage(owner,companion.id,crypto.randomUUID(),'A',0,a.id))!;
 await db`UPDATE runs SET status='running',dispatched=true WHERE id=${first}`;
 const other=(await acceptMessage(owner,companion.id,crypto.randomUUID(),'B',0,b.id))!;
 const same=(await acceptMessage(owner,companion.id,crypto.randomUUID(),'A follow-up',0,a.id))!;
 const leader=await acquireExecutor();if(!leader)throw Error('Missing leader');
 try {
  await claimQueuedRuns(leader);
  expect((await db`SELECT status FROM runs WHERE id=${other}`)[0].status).toBe('queued');
  expect((await db`SELECT status FROM runs WHERE id=${same}`)[0].status).toBe('preparing');
  await db`UPDATE runs SET status='succeeded',finished_at=now() WHERE id=${same}`;
  await updateDesignProject(owner,companion.id,a.id,{expectedRevision:1,brief:'New direction'});
  const changed=(await acceptMessage(owner,companion.id,crypto.randomUUID(),'A new brief',0,a.id))!;
  await claimQueuedRuns(leader);expect((await db`SELECT status FROM runs WHERE id=${changed}`)[0].status).toBe('queued');
  await db`UPDATE runs SET status='succeeded',finished_at=now() WHERE id=${first}`;
  await claimQueuedRuns(leader);expect((await db`SELECT status FROM runs WHERE id=${other}`)[0].status).toBe('preparing');
 } finally {await leader`SELECT pg_advisory_unlock(721440139)`;leader.release();await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${companion.id} AND status IN ('queued','preparing','running','needs_input')`;}
});

test('more than 100 revisions remain reachable and unsafe publication leaves the last valid preview',async()=>{
 const companion=await fixture(),project=await createDesignProject(owner,companion.id,input('History'));
 const runId=(await acceptMessage(owner,companion.id,crypto.randomUUID(),'Many revisions',0,project.id))!;
 await db`UPDATE runs SET status='running',dispatched=true WHERE id=${runId}`;
 const context={ownerId:owner,companionId:companion.id,runId,commandId:crypto.randomUUID()},artifactId=crypto.randomUUID();
 let previousRevisionId:string|null=null,latest:any;
 for(let revision=1;revision<=105;revision++){
  const publicationId=crypto.randomUUID(),html=`<h1>Version ${revision}</h1>`;
  latest={publicationId,projectId:project.id,artifactId,previousRevisionId,title:'History',html,sha256:createHash('sha256').update(html).digest('hex'),workspacePath:`artifacts/projects/${project.id}/${artifactId}/${publicationId}.html`};
  await publishDesign(context,latest);previousRevisionId=publicationId;
 }
 const first=(await readWorkbench(owner,companion.id,{projectId:project.id}))!;
 const second=(await readWorkbench(owner,companion.id,{projectId:project.id,cursor:first.nextCursor!}))!;
 expect(first.revisions).toHaveLength(100);expect(second.revisions).toHaveLength(5);
 expect(new Set([...first.revisions,...second.revisions].map(item=>item.revisionId)).size).toBe(105);
 expect(first.revisions[0].revision).toBe(105);expect(second.revisions.at(-1)?.revision).toBe(1);
 expect(first.revisions[0].provenance).toMatchObject({companionId:companion.id,runId,profileId:'design-v2',projectId:project.id,projectRevision:1});
 const otherRun=(await acceptMessage(owner,companion.id,crypto.randomUUID(),'Other run',0,project.id))!;await db`UPDATE runs SET status='running' WHERE id=${otherRun}`;
 await expect(publishDesign({...context,runId:otherRun},latest)).rejects.toBeInstanceOf(Conflict);
 await db`UPDATE runs SET cancel_requested=true WHERE id=${runId}`;
 const failedId=crypto.randomUUID();await expect(publishDesign(context,{...latest,publicationId:failedId,previousRevisionId:latest.publicationId,workspacePath:`artifacts/projects/${project.id}/${artifactId}/${failedId}.html`})).rejects.toBeInstanceOf(Conflict);
 expect((await readArtifactPreview(owner,companion.id,artifactId))?.revisionId).toBe(latest.publicationId);
 expect(await readWorkbench(crypto.randomUUID(),companion.id,{projectId:project.id})).toBeNull();
});

test('database rejects missing or mutated admission context',async()=>{
 const companion=await fixture(),project=await createDesignProject(owner,companion.id,input('Constraint'));
 await expect((async()=>{await db`INSERT INTO runs(id,companion_id,client_message_id,content,project_id,design_context) VALUES(${crypto.randomUUID()},${companion.id},${crypto.randomUUID()},'Bad',${project.id},${{}})`;})()).rejects.toThrow();
 const runId=(await acceptMessage(owner,companion.id,crypto.randomUUID(),'Frozen',0,project.id))!;
 await expect((async()=>{await db`UPDATE runs SET project_id=null,design_context=null WHERE id=${runId}`;})()).rejects.toThrow();
});

test('message admission freezes the project snapshot and exact project intent',async()=>{
 const companion=await fixture(),project=await createDesignProject(owner,companion.id,input('Frozen')),clientMessageId=crypto.randomUUID();
 const runId=await acceptMessage(owner,companion.id,clientMessageId,'Make the page',0,project.id);expect(runId).not.toBeNull();
 await updateDesignProject(owner,companion.id,project.id,{expectedRevision:1,name:'Renamed',brief:'Changed later'});
 const [run]=await db`SELECT project_id,design_context FROM runs WHERE id=${runId}`;
 expect(run.project_id).toBe(project.id);expect(designRunContextSchema.parse(run.design_context).project).toMatchObject({name:'Frozen',brief:'Brief for Frozen',revision:1});
 expect(await acceptMessage(owner,companion.id,clientMessageId,'Make the page',0,project.id)).toBe(runId);
 await expect(acceptMessage(owner,companion.id,clientMessageId,'Make the page',0,crypto.randomUUID())).rejects.toBeInstanceOf(Conflict);
});

test('design publication is authoritative, idempotent and project filtered',async()=>{
 const companion=await fixture(),a=await createDesignProject(owner,companion.id,input('A')),b=await createDesignProject(owner,companion.id,input('B'));
 const runId=(await acceptMessage(owner,companion.id,crypto.randomUUID(),'Publish',0,a.id))!;await db`UPDATE runs SET status='running',dispatched=true WHERE id=${runId}`;
 const artifactId=crypto.randomUUID(),publicationId=crypto.randomUUID(),html='<main>A</main>',raw={publicationId,projectId:a.id,artifactId,previousRevisionId:null,title:'A page',html,sha256:createHash('sha256').update(html).digest('hex'),workspacePath:`artifacts/projects/${a.id}/${artifactId}/${publicationId}.html`};
 const context={ownerId:owner,companionId:companion.id,runId,commandId:crypto.randomUUID()};
 expect(await publishDesign(context,raw)).toMatchObject({artifactId,revisionId:publicationId,revision:1,projectId:a.id});
 expect(await publishDesign(context,raw)).toMatchObject({revisionId:publicationId,revision:1});
 await expect(publishDesign(context,{...raw,title:'Changed'})).rejects.toBeInstanceOf(Conflict);
 expect((await readWorkbench(owner,companion.id,{projectId:a.id}))?.revisions).toHaveLength(1);
 expect((await readWorkbench(owner,companion.id,{projectId:b.id}))?.revisions).toHaveLength(0);
 await updateDesignProject(owner,companion.id,a.id,{expectedRevision:1,archived:true});
 const archivedPublicationId=crypto.randomUUID();
 await expect(publishDesign(context,{...raw,publicationId:archivedPublicationId,workspacePath:`artifacts/projects/${a.id}/${artifactId}/${archivedPublicationId}.html`})).rejects.toBeInstanceOf(Conflict);
});

test('legacy and general companions cannot bind design projects',async()=>{
 const legacy=await createCompanion(owner,{name:'Legacy',provider:'local'}),design=await fixture(),project=await createDesignProject(owner,design.id,input('Owned elsewhere'));
 await expect(acceptMessage(owner,legacy.id,crypto.randomUUID(),'No project',0,project.id)).rejects.toBeInstanceOf(Conflict);
 await expect(acceptMessage(owner,design.id,crypto.randomUUID(),'Wrong project',0,crypto.randomUUID())).rejects.toBeInstanceOf(Conflict);
 expect(await acceptMessage(owner,design.id,crypto.randomUUID(),'General design chat')).not.toBeNull();
});

test('retired profiles remain readable and exactly retryable but cannot be created afresh',async()=>{
 const clientCreationId=crypto.randomUUID(),id=crypto.randomUUID(),name='Legacy design foundation';
 const fingerprint=createHash('sha256').update(JSON.stringify({name,instructions:null,provider:'local',prepare:false,avatar:null,templateId:null,templateRevision:null,profileId:'design-v1'})).digest('hex');
 await db`INSERT INTO companions(id,owner_id,name,instructions,provider,create_key,agent_secret,client_creation_id,creation_fingerprint,profile_id)
  VALUES(${id},${owner},${name},'',${'local'},${crypto.randomUUID()},${'historical-secret'},${clientCreationId},${fingerprint},'design-v1')`;
 const retry=await createCompanion(owner,{name,provider:'local',clientCreationId,profileId:'design-v1'});
 expect(retry).toMatchObject({id,profileId:'design-v1'});
 await expect(createCompanion(owner,{name:'Changed retry',provider:'local',clientCreationId,profileId:'design-v1'})).rejects.toThrow('creation identifier');
 await expect(createCompanion(owner,{name:'Fresh retired profile',provider:'local',clientCreationId:crypto.randomUUID(),profileId:'design-v1'})).rejects.toThrow('no longer available');
 await expect((async()=>{await db`UPDATE companions SET profile_id='design-v2' WHERE id=${id}`;})()).rejects.toThrow('profile is immutable');
});
