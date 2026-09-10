import {createHash} from 'node:crypto';
import {z} from 'zod';
import {anyArtifactPublicationSchema,anyArtifactRevisionSchema,anyWorkbenchEventSchema,artifactPublicationSchema,designArtifactPublicationSchema,designPublicationInputSchema,type ArtifactPreview,type ArtifactPublication,type WorkbenchSnapshot} from '../../../packages/workbench/artifacts';
import {designRunContextSchema} from '../../../packages/workbench/projects';
import {activeDesignSkill,profiles} from '../../../packages/workbench/profiles';
import {db,Conflict} from './store';

const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);

export async function publishArtifactRevisionInTransaction(ownerId:string,raw:unknown,tx:any):Promise<any>{
 const publication=anyArtifactPublicationSchema.parse(raw),{manifest,html}=publication;
 if(manifest.status==='ready'&&createHash('sha256').update(html!).digest('hex')!==manifest.source.sha256)throw new Conflict('Artifact preview does not match its source hash.');
 const profile=profiles[manifest.provenance.profileId];
 if(!profile.skills.some(skill=>skill.id===manifest.provenance.skill.id&&skill.version===manifest.provenance.skill.version))throw new Conflict('The publishing skill is not enabled for this profile.');
 const [companion]=await tx`SELECT id,profile_id FROM companions WHERE id=${manifest.provenance.companionId} AND owner_id=${ownerId} AND retired_at IS NULL FOR UPDATE`;
 if(!companion)throw new Conflict('Companion not found.');
 if(companion.profile_id!==manifest.provenance.profileId||!['design-v1','design-v2'].includes(manifest.provenance.profileId))throw new Conflict('Artifact publishing requires the matching design profile.');
 const [run]=await tx`SELECT id,companion_id,lane,response_root_id,project_id,design_context FROM runs WHERE id=${manifest.provenance.runId}`;
 if(!run||run.companion_id!==companion.id)throw new Conflict('Artifact provenance does not belong to this Companion.');
 const expectedConversation=run.lane==='background'?(run.response_root_id??run.id):companion.id;
 if(manifest.provenance.conversation.kind!==run.lane||manifest.provenance.conversation.id!==expectedConversation)throw new Conflict('Artifact conversation provenance does not match its run.');
 const projectId=manifest.schemaVersion===2?manifest.provenance.projectId:null;
 if(manifest.schemaVersion===2){
  const context=designRunContextSchema.safeParse(run.design_context);
  if(!context.success||run.project_id!==projectId||context.data.project.id!==projectId||context.data.project.revision!==manifest.provenance.projectRevision)throw new Conflict('Artifact project provenance does not match its admitted run.');
 }
 const [existing]=await tx`SELECT manifest,html FROM artifact_revisions WHERE revision_id=${manifest.revisionId}`;
 if(existing){
  const previous={manifest:anyArtifactRevisionSchema.parse(existing.manifest),html:existing.html};
  if(!same(previous,publication))throw new Conflict('This revision identifier was already used with different content.');
  return previous;
 }
 if(manifest.schemaVersion===2){
  const [binding]=await tx`INSERT INTO design_artifacts(owner_id,companion_id,artifact_id,project_id) VALUES(${ownerId},${companion.id},${manifest.artifactId},${projectId}) ON CONFLICT(companion_id,artifact_id) DO NOTHING RETURNING project_id`;
  if(!binding){const [prior]=await tx`SELECT project_id FROM design_artifacts WHERE companion_id=${companion.id} AND artifact_id=${manifest.artifactId}`;if(prior?.project_id!==projectId)throw new Conflict('An artifact cannot move between projects.');}
 }
 const [latest]=await tx`SELECT revision_id,revision FROM artifact_revisions WHERE companion_id=${companion.id} AND artifact_id=${manifest.artifactId} AND project_id IS NOT DISTINCT FROM ${projectId}::uuid ORDER BY revision DESC LIMIT 1`;
 const expectedRevision=latest?Number(latest.revision)+1:1;
 if(manifest.revision!==expectedRevision||manifest.previousRevisionId!==(latest?.revision_id??null))throw new Conflict('Artifact revision does not follow its predecessor.');
 const event={id:crypto.randomUUID(),type:'artifact.revision' as const,artifactId:manifest.artifactId,revisionId:manifest.revisionId,provenance:manifest.provenance,createdAt:manifest.createdAt};
 anyWorkbenchEventSchema.parse(event);
 await tx`INSERT INTO artifact_revisions(revision_id,owner_id,companion_id,run_id,artifact_id,revision,previous_revision_id,status,manifest,html,created_at,project_id) VALUES(${manifest.revisionId},${ownerId},${companion.id},${manifest.provenance.runId},${manifest.artifactId},${manifest.revision},${manifest.previousRevisionId},${manifest.status},${manifest},${html},${manifest.createdAt},${projectId})`;
 await tx`INSERT INTO workbench_events(id,owner_id,companion_id,run_id,event_type,artifact_id,revision_id,event,created_at,project_id) VALUES(${event.id},${ownerId},${companion.id},${manifest.provenance.runId},${event.type},${manifest.artifactId},${manifest.revisionId},${event},${manifest.createdAt},${projectId})`;
 return publication;
}

export async function publishArtifactRevision(ownerId:string,raw:unknown,sql:any=db):Promise<ArtifactPublication>{
 const publication=artifactPublicationSchema.parse(raw);
 return sql.begin((tx:any)=>publishArtifactRevisionInTransaction(ownerId,publication,tx));
}

export interface PublishDesignContext {ownerId:string;companionId:string;runId:string;commandId:string}
export async function publishDesign(context:PublishDesignContext,raw:unknown,sql:any=db):Promise<{artifactId:string;revisionId:string;revision:number;projectId:string}>{
 const value=designPublicationInputSchema.parse(raw),expectedPath=`artifacts/projects/${value.projectId}/${value.artifactId}/${value.publicationId}.html`;
 if(value.workspacePath!==expectedPath)throw new Conflict('Publication path does not match its immutable identifier.');
 if(createHash('sha256').update(value.html).digest('hex')!==value.sha256)throw new Conflict('Published HTML does not match its source hash.');
 return sql.begin(async(tx:any)=>{
  const [row]=await tx`SELECT c.id AS companion_id,c.profile_id,r.id AS run_id,r.lane,r.response_root_id,r.status,r.cancel_requested,r.project_id,r.design_context,p.archived
   FROM companions c JOIN runs r ON r.companion_id=c.id JOIN design_projects p ON p.id=r.project_id AND p.companion_id=c.id AND p.owner_id=c.owner_id
   WHERE c.id=${context.companionId} AND c.owner_id=${context.ownerId} AND c.retired_at IS NULL AND r.id=${context.runId} FOR UPDATE OF c,r,p`;
  if(!row||row.profile_id!=='design-v2'||row.project_id!==value.projectId)throw new Conflict('This run is not bound to the requested design project.');
  if(row.archived)throw new Conflict('Archived design projects cannot receive new publications.');
  if(row.cancel_requested||!['running','needs_input'].includes(row.status))throw new Conflict('This run no longer has publication authority.');
  const admitted=designRunContextSchema.parse(row.design_context);
  const [existing]=await tx`SELECT manifest,html FROM artifact_revisions WHERE revision_id=${value.publicationId}`;
  if(existing){
   const manifest=anyArtifactRevisionSchema.parse(existing.manifest);
   if(manifest.schemaVersion!==2||manifest.provenance.companionId!==context.companionId||manifest.provenance.runId!==context.runId||manifest.artifactId!==value.artifactId||manifest.previousRevisionId!==value.previousRevisionId||manifest.title!==value.title||manifest.source.workspacePath!==value.workspacePath||manifest.source.sha256!==value.sha256||manifest.provenance.projectId!==value.projectId||existing.html!==value.html)throw new Conflict('This publication identifier was already used with different content.');
   return {artifactId:manifest.artifactId,revisionId:manifest.revisionId,revision:manifest.revision,projectId:manifest.provenance.projectId};
  }
  const [latest]=await tx`SELECT revision_id,revision FROM artifact_revisions WHERE companion_id=${context.companionId} AND artifact_id=${value.artifactId} AND project_id=${value.projectId} ORDER BY revision DESC LIMIT 1`;
  if(value.previousRevisionId!==(latest?.revision_id??null))throw new Conflict('Artifact revision does not follow its predecessor.');
  const manifest={schemaVersion:2 as const,artifactId:value.artifactId,revisionId:value.publicationId,revision:latest?Number(latest.revision)+1:1,previousRevisionId:value.previousRevisionId,title:value.title,
   kind:'static-html' as const,renderer:'sandboxed-html-v1' as const,status:'ready' as const,failureCode:null,source:{workspacePath:value.workspacePath,sha256:value.sha256},
   provenance:{companionId:context.companionId,runId:context.runId,conversation:{kind:row.lane,id:row.lane==='background'?(row.response_root_id??context.runId):context.companionId},profileId:'design-v2' as const,skill:activeDesignSkill,projectId:value.projectId,projectRevision:admitted.project.revision},createdAt:new Date().toISOString()};
  const publication=designArtifactPublicationSchema.parse({manifest,html:value.html});
  await publishArtifactRevisionInTransaction(context.ownerId,publication,tx);
  return {artifactId:manifest.artifactId,revisionId:manifest.revisionId,revision:manifest.revision,projectId:value.projectId};
 });
}

const optionsSchema=z.object({projectId:z.uuid().optional(),cursor:z.string().max(500).optional()}).strict();
function cursorValue(raw?:string){if(!raw)return null;try{return z.object({at:z.iso.datetime(),revision:z.number().int().positive(),id:z.uuid()}).parse(JSON.parse(Buffer.from(raw,'base64url').toString()));}catch{throw new Conflict('Invalid workbench cursor.');}}
function makeCursor(row:any){return Buffer.from(JSON.stringify({at:new Date(row.created_at).toISOString(),revision:row.revision,id:row.revision_id})).toString('base64url');}
export async function readWorkbench(ownerId:string,companionId:string,optionsOrSql:unknown={},injectedSql?:any):Promise<WorkbenchSnapshot|null>{
 const legacySql=typeof optionsOrSql==='function'?optionsOrSql:null,sql=injectedSql??legacySql??db,options=optionsSchema.parse(legacySql?{}:optionsOrSql),cursor=cursorValue(options.cursor);
 const [owned]=await sql`SELECT id FROM companions WHERE id=${companionId} AND owner_id=${ownerId}`;if(!owned)return null;
 const revisionRows=await sql`SELECT manifest,created_at,revision,revision_id FROM artifact_revisions WHERE companion_id=${companionId} AND owner_id=${ownerId}
  AND (${options.projectId??null}::uuid IS NULL OR project_id=${options.projectId??null}) AND (${cursor?.at??null}::timestamptz IS NULL OR (created_at,revision,revision_id)<(${cursor?.at??null}::timestamptz,${cursor?.revision??null}::integer,${cursor?.id??null}::uuid))
  ORDER BY created_at DESC,revision DESC,revision_id DESC LIMIT 101`;
 const page=revisionRows.slice(0,100),boundary=page.at(-1);
 const eventRows=await sql`SELECT e.event FROM workbench_events e JOIN artifact_revisions r ON r.revision_id=e.revision_id AND r.companion_id=e.companion_id
  WHERE e.companion_id=${companionId} AND e.owner_id=${ownerId} AND (${options.projectId??null}::uuid IS NULL OR e.project_id=${options.projectId??null})
  AND (${cursor?.at??null}::timestamptz IS NULL OR (r.created_at,r.revision,r.revision_id)<(${cursor?.at??null}::timestamptz,${cursor?.revision??null}::integer,${cursor?.id??null}::uuid))
  ORDER BY r.created_at DESC,r.revision DESC,r.revision_id DESC LIMIT 100`;
 return {revisions:page.map((row:any)=>anyArtifactRevisionSchema.parse(row.manifest)),events:eventRows.map((row:any)=>anyWorkbenchEventSchema.parse(row.event)),hasMore:revisionRows.length>100,nextCursor:revisionRows.length>100&&boundary?makeCursor(boundary):null};
}

export async function readArtifactPreview(ownerId:string,companionId:string,artifactId:string,atRevisionId?:string,sql:any=db):Promise<ArtifactPreview|null>{
 let maximumRevision:number|null=null;
 if(atRevisionId){const [requested]=await sql`SELECT r.revision FROM artifact_revisions r JOIN companions c ON c.id=r.companion_id WHERE r.revision_id=${atRevisionId} AND r.companion_id=${companionId} AND r.artifact_id=${artifactId} AND r.owner_id=${ownerId} AND c.owner_id=${ownerId}`;if(!requested)return null;maximumRevision=Number(requested.revision);}
 const [row]=await sql`SELECT r.revision_id AS "revisionId",r.html FROM artifact_revisions r JOIN companions c ON c.id=r.companion_id
  WHERE r.companion_id=${companionId} AND r.artifact_id=${artifactId} AND r.owner_id=${ownerId} AND c.owner_id=${ownerId} AND r.status='ready' AND (${maximumRevision}::integer IS NULL OR r.revision<=${maximumRevision}) ORDER BY r.revision DESC LIMIT 1`;
 return row??null;
}
