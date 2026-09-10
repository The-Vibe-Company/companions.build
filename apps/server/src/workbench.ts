import {createHash} from 'node:crypto';
import {artifactPublicationSchema,artifactRevisionSchema,workbenchEventSchema,type ArtifactPreview,type ArtifactPublication,type WorkbenchSnapshot} from '../../../packages/workbench/artifacts';
import {profiles} from '../../../packages/workbench/profiles';
import {db,Conflict} from './store';

const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);

/** Trusted persistence seam. Runtime publication is intentionally not exposed through HTTP or agent control. */
export async function publishArtifactRevision(ownerId:string,raw:unknown,sql:any=db):Promise<ArtifactPublication>{
 const publication=artifactPublicationSchema.parse(raw),{manifest,html}=publication;
 if(manifest.status==='ready'&&createHash('sha256').update(html!).digest('hex')!==manifest.source.sha256)
  throw new Conflict('Artifact preview does not match its source hash.');
 const enabled=profiles['design-v1'].skills.some(skill=>skill.id===manifest.provenance.skill.id&&skill.version===manifest.provenance.skill.version);
 if(!enabled)throw new Conflict('The publishing skill is not enabled for this profile.');
 return sql.begin(async(tx:any)=>{
  const [companion]=await tx`SELECT id,profile_id FROM companions WHERE id=${manifest.provenance.companionId} AND owner_id=${ownerId} AND retired_at IS NULL FOR UPDATE`;
  if(!companion)throw new Conflict('Companion not found.');
  if(companion.profile_id!=='design-v1'||manifest.provenance.profileId!=='design-v1')throw new Conflict('Artifact publishing requires the design profile.');
  const [run]=await tx`SELECT id,companion_id,lane,response_root_id FROM runs WHERE id=${manifest.provenance.runId}`;
  if(!run||run.companion_id!==companion.id)throw new Conflict('Artifact provenance does not belong to this Companion.');
  const expectedConversation=run.lane==='background'?(run.response_root_id??run.id):companion.id;
  if(manifest.provenance.conversation.kind!==run.lane||manifest.provenance.conversation.id!==expectedConversation)
   throw new Conflict('Artifact conversation provenance does not match its run.');
  const [existing]=await tx`SELECT manifest,html FROM artifact_revisions WHERE revision_id=${manifest.revisionId}`;
  if(existing){
   const previous={manifest:artifactRevisionSchema.parse(existing.manifest),html:existing.html};
   if(!same(previous,publication))throw new Conflict('This revision identifier was already used with different content.');
   return previous;
  }
  const [latest]=await tx`SELECT revision_id,revision FROM artifact_revisions WHERE companion_id=${companion.id} AND artifact_id=${manifest.artifactId} ORDER BY revision DESC LIMIT 1`;
  const expectedRevision=latest?Number(latest.revision)+1:1;
  if(manifest.revision!==expectedRevision||manifest.previousRevisionId!==(latest?.revision_id??null))
   throw new Conflict('Artifact revision does not follow its predecessor.');
  const event={id:crypto.randomUUID(),type:'artifact.revision' as const,artifactId:manifest.artifactId,revisionId:manifest.revisionId,provenance:manifest.provenance,createdAt:manifest.createdAt};
  workbenchEventSchema.parse(event);
  await tx`INSERT INTO artifact_revisions(revision_id,owner_id,companion_id,run_id,artifact_id,revision,previous_revision_id,status,manifest,html,created_at)
    VALUES(${manifest.revisionId},${ownerId},${companion.id},${manifest.provenance.runId},${manifest.artifactId},${manifest.revision},${manifest.previousRevisionId},${manifest.status},${manifest},${html},${manifest.createdAt})`;
  await tx`INSERT INTO workbench_events(id,owner_id,companion_id,run_id,event_type,artifact_id,revision_id,event,created_at)
    VALUES(${event.id},${ownerId},${companion.id},${manifest.provenance.runId},${event.type},${manifest.artifactId},${manifest.revisionId},${event},${manifest.createdAt})`;
  return publication;
 });
}

export async function readWorkbench(ownerId:string,companionId:string,sql:any=db):Promise<WorkbenchSnapshot|null>{
 const [owned]=await sql`SELECT id FROM companions WHERE id=${companionId} AND owner_id=${ownerId}`;
 if(!owned)return null;
 const [revisionRows,eventRows]=await Promise.all([
  sql`SELECT manifest FROM artifact_revisions WHERE companion_id=${companionId} AND owner_id=${ownerId} ORDER BY created_at DESC,revision DESC,revision_id DESC LIMIT 101`,
  sql`SELECT event FROM workbench_events WHERE companion_id=${companionId} AND owner_id=${ownerId} ORDER BY created_at DESC,id DESC LIMIT 100`,
 ]);
 return {revisions:revisionRows.slice(0,100).map((row:any)=>artifactRevisionSchema.parse(row.manifest)),events:eventRows.map((row:any)=>workbenchEventSchema.parse(row.event)),hasMore:revisionRows.length>100};
}

export async function readArtifactPreview(ownerId:string,companionId:string,artifactId:string,atRevisionId?:string,sql:any=db):Promise<ArtifactPreview|null>{
 let maximumRevision:number|null=null;
 if(atRevisionId){
  const [requested]=await sql`SELECT r.revision FROM artifact_revisions r JOIN companions c ON c.id=r.companion_id
    WHERE r.revision_id=${atRevisionId} AND r.companion_id=${companionId} AND r.artifact_id=${artifactId} AND r.owner_id=${ownerId} AND c.owner_id=${ownerId}`;
  if(!requested)return null;
  maximumRevision=Number(requested.revision);
 }
 const [row]=await sql`SELECT r.revision_id AS "revisionId",r.html FROM artifact_revisions r JOIN companions c ON c.id=r.companion_id
   WHERE r.companion_id=${companionId} AND r.artifact_id=${artifactId} AND r.owner_id=${ownerId} AND c.owner_id=${ownerId} AND r.status='ready'
     AND (${maximumRevision}::integer IS NULL OR r.revision<=${maximumRevision})
   ORDER BY r.revision DESC LIMIT 1`;
 return row??null;
}
