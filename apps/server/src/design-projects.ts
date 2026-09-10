import {createHash} from "node:crypto";
import {designProjectCreateSchema,designProjectSchema,designProjectUpdateSchema,type DesignProject,type DesignProjectPage} from '../../../packages/workbench/projects';
import {db,Conflict} from './store';
import {z} from 'zod';

const columns=`id,companion_id AS "companionId",name,brief,revision,archived,created_at AS "createdAt",updated_at AS "updatedAt"`;
const prefixedColumns=`p.id,p.companion_id AS "companionId",p.name,p.brief,p.revision,p.archived,p.created_at AS "createdAt",p.updated_at AS "updatedAt"`;
const parseProject=(row:any)=>designProjectSchema.parse({id:row.id,companionId:row.companionId,name:row.name,brief:row.brief,revision:row.revision,archived:row.archived,createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString()});

export async function listDesignProjects(ownerId:string,companionId:string,raw:unknown={},sql:any=db):Promise<DesignProjectPage|null>{
 const value=z.object({q:z.string().trim().max(200).optional(),cursor:z.uuid().optional()}).parse(raw);
 const [companion]=await sql`SELECT id FROM companions WHERE id=${companionId} AND owner_id=${ownerId} AND retired_at IS NULL AND profile_id='design-v2'`;
 if(!companion)return null;
 const rows=await sql.unsafe(`SELECT ${columns} FROM design_projects WHERE owner_id=$1 AND companion_id=$2
  AND ($3::uuid IS NULL OR id>$3::uuid) AND ($4::text IS NULL OR name ILIKE '%'||$4||'%' OR brief ILIKE '%'||$4||'%')
  ORDER BY id LIMIT 41`,[ownerId,companionId,value.cursor??null,value.q||null]);
 return {projects:rows.slice(0,40).map(parseProject),nextCursor:rows.length>40?rows[39].id:null};
}

export async function createDesignProject(ownerId:string,companionId:string,raw:unknown,sql:any=db):Promise<DesignProject>{
 const value=designProjectCreateSchema.parse(raw);
 const fingerprint=createHash("sha256").update(JSON.stringify(value)).digest("hex");
 return sql.begin(async(tx:any)=>{
  const [companion]=await tx`SELECT id FROM companions WHERE id=${companionId} AND owner_id=${ownerId} AND retired_at IS NULL AND profile_id='design-v2' FOR UPDATE`;
  if(!companion)throw new Conflict('Design projects require an owned Design Companion.');
  const [existing]=await tx.unsafe(`SELECT ${columns},owner_id,creation_fingerprint FROM design_projects WHERE id=$1`,[value.id]);
  if(existing){
   if(existing.owner_id!==ownerId||existing.companionId!==companionId||existing.creation_fingerprint!==fingerprint)
    throw new Conflict('This project identifier was already used with different details.');
   return parseProject(existing);
  }
  const [row]=await tx.unsafe(`INSERT INTO design_projects(id,owner_id,companion_id,name,brief,creation_fingerprint) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`,[value.id,ownerId,companionId,value.name,value.brief,fingerprint]);
  return parseProject(row);
 });
}

export async function readDesignProject(ownerId:string,companionId:string,projectId:string,sql:any=db):Promise<DesignProject|null>{
 const [row]=await sql.unsafe(`SELECT ${prefixedColumns} FROM design_projects p JOIN companions c ON c.id=p.companion_id AND c.owner_id=p.owner_id
  WHERE p.id=$1 AND p.companion_id=$2 AND p.owner_id=$3 AND c.retired_at IS NULL AND c.profile_id='design-v2'`,[projectId,companionId,ownerId]);
 return row?parseProject(row):null;
}

export async function updateDesignProject(ownerId:string,companionId:string,projectId:string,raw:unknown,sql:any=db):Promise<DesignProject>{
 const value=designProjectUpdateSchema.parse(raw);
 const [row]=await sql.unsafe(`UPDATE design_projects p SET name=COALESCE($1,p.name),brief=COALESCE($2,p.brief),archived=COALESCE($3,p.archived),revision=p.revision+1,updated_at=now()
  FROM companions c WHERE p.id=$4 AND p.companion_id=$5 AND p.owner_id=$6 AND p.revision=$7 AND c.id=p.companion_id AND c.owner_id=p.owner_id
   AND c.retired_at IS NULL AND c.profile_id='design-v2' RETURNING ${prefixedColumns}`,
  [value.name??null,value.brief??null,value.archived??null,projectId,companionId,ownerId,value.expectedRevision]);
 if(row)return parseProject(row);
 const [existing]=await sql`SELECT revision FROM design_projects p JOIN companions c ON c.id=p.companion_id AND c.owner_id=p.owner_id WHERE p.id=${projectId} AND p.companion_id=${companionId} AND p.owner_id=${ownerId} AND c.retired_at IS NULL`;
 if(!existing)throw new Conflict('Design project not found.');
 throw new Conflict('The design project changed. Reload it and try again.');
}

export {listDesignProjects as list,createDesignProject as create,readDesignProject as read,updateDesignProject as updateProject};
