import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "./store";
import { agentRequest } from "./machines";
import { createObjectStorage, type ObjectStorage } from "./storage";
import { portableSkillCredentialRisk } from "../../../packages/control/skills";

const MAX_BYTES=10*1024*1024,MAX_FILES=500;
const name=z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
const manifestSchema=z.object({version:z.literal(1),skills:z.array(z.object({name,files:z.array(z.object({path:z.string().min(1).max(500),data:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)})).min(1)}))});
type Manifest=z.infer<typeof manifestSchema>;
type RequestAgent=(endpoint:string,token:string,path:string,method?:string,body?:unknown)=>Promise<any>;
export interface DeliverySkillDependencies {storage?:ObjectStorage;requestAgent?:RequestAgent;notifyReady?:(deliveryId:string)=>Promise<unknown>}
export interface DeliverySkillExecution {
 sql:any;
 assertLeader():Promise<void>;
 checkpoint<T>(body:(tx:any)=>Promise<T>):Promise<T>;
}
class BundleError extends Error{}
const digest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");

export async function migrateDeliverySkills(sql:any=db){await sql.unsafe(await Bun.file(new URL("./delivery-skills.sql",import.meta.url)).text());}

export async function queueDeliverySkillExports(sql:any,input:{deliveryId:string;ownerId:string;companionId:string;templates:Array<{sourceTemplateId:string;sourceCompanionId:string|null;skillBundleId:string|null}>}){
 await sql`INSERT INTO portable_skill_exports(id,delivery_id,source_owner_id,source_companion_id,target_kind)
  VALUES(${crypto.randomUUID()},${input.deliveryId},${input.ownerId},${input.companionId},'delivery_main')`;
 for(const template of input.templates){
  if(template.skillBundleId){
   await sql`INSERT INTO portable_skill_exports(id,delivery_id,source_owner_id,source_companion_id,target_kind,source_template_id,status,bundle_id,finished_at)
    VALUES(${crypto.randomUUID()},${input.deliveryId},${input.ownerId},${template.sourceCompanionId??input.companionId},'delivery_template',${template.sourceTemplateId},'ready',${template.skillBundleId},now())`;
  }else if(template.sourceCompanionId){
   const [source]=await sql`SELECT retired_at FROM companions WHERE id=${template.sourceCompanionId} AND owner_id=${input.ownerId}`;
   await sql`INSERT INTO portable_skill_exports(id,delivery_id,source_owner_id,source_companion_id,target_kind,source_template_id,status,error,finished_at)
    VALUES(${crypto.randomUUID()},${input.deliveryId},${input.ownerId},${template.sourceCompanionId},'delivery_template',${template.sourceTemplateId},${source&&!source.retired_at?'pending':'error'},${source&&!source.retired_at?null:'Template skills are no longer available for export.'},${source&&!source.retired_at?null:new Date()})`;
  }
 }
 await sql`UPDATE companions SET prepare_requested=true,error=null WHERE owner_id=${input.ownerId} AND retired_at IS NULL AND id IN
  (SELECT source_companion_id FROM portable_skill_exports WHERE delivery_id=${input.deliveryId} AND status='pending')`;
 await refreshDelivery(sql,input.deliveryId);
}

export async function queueTemplateSkillExport(sql:any,ownerId:string,templateId:string,sourceCompanionId:string,targetRevision:number){
 const [owned]=await sql`SELECT t.id FROM agent_templates t JOIN companions c ON c.id=${sourceCompanionId} AND c.owner_id=t.owner_id AND c.retired_at IS NULL WHERE t.id=${templateId} AND t.owner_id=${ownerId}`;
 if(!owned)throw Error("TEMPLATE_SKILL_SOURCE_UNAVAILABLE");
 const [row]=await sql`INSERT INTO portable_skill_exports(id,source_owner_id,source_companion_id,target_kind,source_template_id,target_revision)
  VALUES(${crypto.randomUUID()},${ownerId},${sourceCompanionId},'template_revision',${templateId},${targetRevision})
  ON CONFLICT(source_template_id,target_revision) WHERE target_kind='template_revision' DO NOTHING
  RETURNING id,status,bundle_id AS "bundleId",error`;
 await sql`UPDATE companions SET prepare_requested=true,error=null WHERE id=${sourceCompanionId} AND owner_id=${ownerId} AND retired_at IS NULL`;
 if(row)return row;
 const [prior]=await sql`SELECT id,status,bundle_id AS "bundleId",error,source_owner_id,source_companion_id FROM portable_skill_exports WHERE target_kind='template_revision' AND source_template_id=${templateId} AND target_revision=${targetRevision}`;
 if(!prior||prior.source_owner_id!==ownerId||prior.source_companion_id!==sourceCompanionId)throw Error("TEMPLATE_SKILL_EXPORT_CONFLICT");return prior;
}
export async function templateSkillExport(sql:any,ownerId:string,templateId:string,targetRevision:number){
 const [row]=await sql`SELECT e.status,e.bundle_id AS "bundleId",e.error FROM portable_skill_exports e JOIN agent_templates t ON t.id=e.source_template_id AND t.owner_id=${ownerId} WHERE e.target_kind='template_revision' AND e.source_template_id=${templateId} AND e.target_revision=${targetRevision}`;
 return row??null;
}

/** Global executor scan: durable scheduling intent only. It never contacts agents, storage, or email. */
export async function progressDeliverySkills(sql:any=db,_deps:DeliverySkillDependencies={}){
 const [lock]=await sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=721440139 AND granted) AS owned`;
 if(!lock.owned)throw Error("Executor ownership required");
 const jobs=await sql`SELECT e.id,e.delivery_id,e.source_companion_id,e.source_owner_id,c.id AS source_exists,c.retired_at,d.status AS delivery_status,d.expires_at
  FROM portable_skill_exports e LEFT JOIN companions c ON c.id=e.source_companion_id AND c.owner_id=e.source_owner_id
  LEFT JOIN companion_deliveries d ON d.id=e.delivery_id
  WHERE e.status='pending' ORDER BY e.created_at LIMIT 100`;
 let scheduled=0;
 for(const job of jobs){
  if(!job.source_exists||job.retired_at){await failJob(sql,job,"Skill source is no longer available.");continue;}
  if(job.delivery_id&&(job.delivery_status!=="pending"||new Date(job.expires_at)<=new Date()))continue;
  await sql`UPDATE companions SET prepare_requested=true,error=null WHERE id=${job.source_companion_id} AND owner_id=${job.source_owner_id} AND retired_at IS NULL`;scheduled++;
 }
 return {processed:jobs.length,scheduled};
}

/** Execute exports for exactly one Companion from its reserved, fenced lifecycle job. */
export async function progressDeliverySkillsForCompanion(sql:any,companionId:string,endpoint:string,token:string,deps:DeliverySkillDependencies={},execution?:DeliverySkillExecution){
 const assertLeader=execution?.assertLeader??(async()=>{});
 const checkpoint=execution?.checkpoint??(<T>(body:(tx:any)=>Promise<T>)=>sql.begin(body));
 const jobs=await sql`SELECT e.*,c.id AS source_exists,c.retired_at,d.status AS delivery_status,d.expires_at
  FROM portable_skill_exports e JOIN companions c ON c.id=e.source_companion_id AND c.owner_id=e.source_owner_id
  LEFT JOIN companion_deliveries d ON d.id=e.delivery_id
  WHERE e.status='pending' AND e.source_companion_id=${companionId}
   AND (e.delivery_id IS NULL OR (d.status='pending' AND d.expires_at>now())) ORDER BY e.created_at LIMIT 20`;
 if(!jobs.length)return {processed:0,ready:0,pending:0};
 const storage=deps.storage??createObjectStorage(),request=deps.requestAgent??agentRequest;
 let processed=0;
 for(const job of jobs){
  if(job.retired_at){await failJob(sql,job,"Skill source is no longer available.");continue;}
  let storedKey:string|null=null;
  try{
   await assertLeader();
   const manifest=validateManifest(await request(endpoint,token,"/skills/export"));
   const bytes=Buffer.from(JSON.stringify(manifest));const objectSha=digest(bytes),bundle=manifestHash(manifest);
   storedKey=`portable-skills/${job.id}/${objectSha}.json`;await assertLeader();await storage.put(storedKey,bytes,"application/json");
   const committed=await checkpoint(async(tx:any)=>{
    const [current]=await tx`SELECT status FROM portable_skill_exports WHERE id=${job.id} FOR UPDATE`;
    if(current?.status!=="pending")return false;
    if(job.delivery_id){const [delivery]=await tx`SELECT status,expires_at FROM companion_deliveries WHERE id=${job.delivery_id} FOR UPDATE`;if(delivery?.status!=="pending"||new Date(delivery.expires_at)<=new Date())return false;}
    await tx`INSERT INTO portable_skill_bundles(id,source_owner_id,source_companion_id,manifest_version,bundle_hash,object_sha256,byte_size,storage_key)
     VALUES(${job.id},${job.source_owner_id},${job.source_companion_id},1,${bundle},${objectSha},${bytes.length},${storedKey})`;
    await tx`UPDATE portable_skill_exports SET status='ready',bundle_id=${job.id},error=null,finished_at=now() WHERE id=${job.id}`;
    if(job.delivery_id)await refreshDelivery(tx,job.delivery_id);
    return true;
   });
   if(!committed){await assertLeader();await deleteIfUnreferenced(sql,storage,storedKey);}
   processed++;
  }catch(error){
   if(storedKey){await assertLeader();await deleteIfUnreferenced(sql,storage,storedKey);}
   if(error instanceof BundleError||error instanceof z.ZodError)await checkpoint(async(tx:any)=>failJobTx(tx,job,"Exported skills failed validation."));
  }
 }
 const ready=await sql`SELECT DISTINCT d.id FROM companion_deliveries d JOIN portable_skill_exports e ON e.delivery_id=d.id
  WHERE e.source_companion_id=${companionId} AND d.status='pending' AND d.expires_at>now() AND d.skills_status='ready' AND d.email_status='pending' ORDER BY d.id LIMIT 20`;
 const notify=deps.notifyReady??(async(id:string)=>{const module=await import("./delivery");await module.sendDeliveryReadyInvite(id);});
 for(const row of ready)try{await assertLeader();await notify(row.id);}catch{}
 const [{count:pending}]=await sql`SELECT count(*)::int AS count FROM portable_skill_exports e LEFT JOIN companion_deliveries d ON d.id=e.delivery_id
  WHERE e.source_companion_id=${companionId} AND e.status='pending' AND (e.delivery_id IS NULL OR (d.status='pending' AND d.expires_at>now()))`;
 return {processed,ready:ready.length,pending};
}

export async function stageDeliverySkills(companionId:string,endpoint:string,token:string,deps:Pick<DeliverySkillDependencies,"storage"|"requestAgent">={},execution?:DeliverySkillExecution){
 const sql=execution?.sql??db,assertLeader=execution?.assertLeader??(async()=>{});
 const checkpoint=execution?.checkpoint??(<T>(body:(tx:any)=>Promise<T>)=>sql.begin(body));
 const [row]=await sql`SELECT c.box_id,c.skills_staged_hash,c.skills_staged_box_id,b.id AS bundle_id,b.bundle_hash,b.object_sha256,b.byte_size,b.storage_key
  FROM companions c LEFT JOIN template_revisions r ON r.template_id=c.template_id AND r.revision=c.template_revision
  JOIN portable_skill_bundles b ON b.id=COALESCE(r.skill_bundle_id,c.skill_bundle_id) WHERE c.id=${companionId} AND c.retired_at IS NULL`;
 if(!row)return {staged:false};
 if(row.skills_staged_hash===row.bundle_hash&&row.skills_staged_box_id===row.box_id)return {staged:false,bundleHash:row.bundle_hash};
 await assertLeader();const blob=await (deps.storage??createObjectStorage()).get(row.storage_key);const bytes=Buffer.from(await blob.arrayBuffer());
 if(bytes.length!==row.byte_size||digest(bytes)!==row.object_sha256)throw Error("DELIVERY_SKILL_STORAGE_INTEGRITY_FAILED");
 const manifest=validateManifest(JSON.parse(bytes.toString("utf8")));
 if(manifestHash(manifest)!==row.bundle_hash)throw Error("DELIVERY_SKILL_BUNDLE_INTEGRITY_FAILED");
 await assertLeader();const result=await (deps.requestAgent??agentRequest)(endpoint,token,"/skills/import","PUT",manifest);
 if(result?.bundleHash!==row.bundle_hash)throw Error("DELIVERY_SKILL_IMPORT_FAILED");
 await checkpoint(async(tx:any)=>{await tx`UPDATE companions SET skills_staged_hash=${row.bundle_hash},skills_staged_box_id=box_id WHERE id=${companionId} AND box_id IS NOT DISTINCT FROM ${row.box_id} AND COALESCE((SELECT skill_bundle_id FROM template_revisions WHERE template_id=companions.template_id AND revision=companions.template_revision),skill_bundle_id)=${row.bundle_id}`;});
 return {staged:true,bundleHash:row.bundle_hash};
}

async function refreshDelivery(sql:any,deliveryId:string){
 const [summary]=await sql`SELECT count(*) FILTER(WHERE status='error')::int AS errors,count(*) FILTER(WHERE status='pending')::int AS pending FROM portable_skill_exports WHERE delivery_id=${deliveryId}`;
 await sql`UPDATE companion_deliveries SET skills_status=${summary.errors?'error':summary.pending?'pending':'ready'},skills_error=${summary.errors?'Portable skills could not be prepared.':null} WHERE id=${deliveryId}`;
}
async function failJob(sql:any,job:any,message:string){await sql.begin(async(tx:any)=>{await tx`UPDATE portable_skill_exports SET status='error',error=${message},finished_at=now() WHERE id=${job.id} AND status='pending'`;if(job.delivery_id)await refreshDelivery(tx,job.delivery_id);});}
async function failJobTx(tx:any,job:any,message:string){await tx`UPDATE portable_skill_exports SET status='error',error=${message},finished_at=now() WHERE id=${job.id} AND status='pending'`;if(job.delivery_id)await refreshDelivery(tx,job.delivery_id);}
async function deleteIfUnreferenced(sql:any,storage:ObjectStorage,key:string){try{if(!(await sql`SELECT id FROM portable_skill_bundles WHERE storage_key=${key} LIMIT 1`).length)await storage.delete(key);}catch{/* Preserve bytes when reference state is uncertain. */}}
function validateManifest(raw:unknown):Manifest{
 const value=manifestSchema.parse(raw);let total=0,count=0;const names=new Set<string>();
 for(const skill of value.skills){if(names.has(skill.name))throw new BundleError();names.add(skill.name);const paths=new Set<string>();
  for(const file of skill.files){if(paths.has(file.path)||unsafe(file.path))throw new BundleError();paths.add(file.path);const bytes=decode(file.data);total+=bytes.length;count++;if(total>MAX_BYTES||count>MAX_FILES||digest(bytes)!==file.sha256||portableSkillCredentialRisk(file.path,bytes))throw new BundleError();}
  const skillFile=skill.files.find(file=>file.path==="SKILL.md");if(!skillFile)throw new BundleError();
  const skillBytes=decode(skillFile.data);if(!skillBytes.length)throw new BundleError();try{new TextDecoder("utf-8",{fatal:true}).decode(skillBytes);}catch{throw new BundleError();}
 }
 return {version:1,skills:value.skills.map(skill=>({name:skill.name,files:[...skill.files].sort((a,b)=>a.path.localeCompare(b.path))})).sort((a,b)=>a.name.localeCompare(b.name))};
}
function unsafe(path:string){const parts=path.split("/");return path.includes("\\")||path.startsWith("/")||/^[a-z]:/i.test(path)||portableSkillCredentialRisk(path,new Uint8Array())||parts.some(part=>{const value=part.toLowerCase();return !part||part==="."||part===".."||value===".env"||value.startsWith(".env.")||["auth.json","cookies","keys","node_modules",".git",".companions-skill-import.json"].includes(value);});}
function decode(value:string){if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new BundleError();const bytes=Buffer.from(value,"base64");if(bytes.toString("base64")!==value)throw new BundleError();return bytes;}
function manifestHash(manifest:Manifest){const outer=createHash("sha256").update("skills-v1\0");for(const skill of manifest.skills){const inner=createHash("sha256").update(`skill\0${skill.name}\0`);for(const file of skill.files){const bytes=decode(file.data);inner.update(`${file.path}\0${file.sha256}\0${bytes.length}\0`);}outer.update(`${skill.name}\0${inner.digest("hex")}\0`);}return outer.digest("hex");}
