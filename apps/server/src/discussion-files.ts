import {createHash} from 'node:crypto';
import {db} from './store';
import {ownedDiscussion,uuid,DiscussionMissing} from './discussions';
import {createObjectStorage,type ObjectStorage} from './storage';
import {boundedFormData,FileRequestError,FILE_MAX_BYTES,sanitizeFilename,sniffContentType,handleFiles} from './files';

const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export function discussionFile(row:any) {
 return {id:row.id,runId:row.run_id,kind:'user_upload',name:row.filename,mimeType:row.content_type,size:row.byte_size,url:`/api/discussions/${row.discussion_id}/files/${row.id}`};
}
export async function storeDiscussionUpload(ownerId:string,discussionId:string,runId:string,input:{clientFileId:string;position:number;filename:string;contentType:string;bytes:Uint8Array},storage?:ObjectStorage) {
 uuid.parse(input.clientFileId);
 if(!Number.isInteger(input.position)||input.position<0||input.position>4)throw new FileRequestError('Invalid file position.',400);
 if(!input.bytes.length||input.bytes.length>FILE_MAX_BYTES)throw new FileRequestError('File is empty or too large.',413);
 const type=sniffContentType(input.bytes,input.contentType,input.filename);
 if(!type)throw new FileRequestError('This file type is not supported.',400);
 const hash=sha(input.bytes),name=sanitizeFilename(input.filename,input.position,type);
 const row=await db.begin(async tx=>{
  await ownedDiscussion(ownerId,discussionId,tx);
  const [run]=await tx`SELECT * FROM discussion_runs WHERE id=${runId} AND discussion_id=${discussionId} FOR UPDATE`;
  if(!run)throw new DiscussionMissing('Task not found.');
  const [prior]=await tx`SELECT * FROM discussion_uploads WHERE run_id=${runId} AND (client_file_id=${input.clientFileId} OR position=${input.position})`;
  if(prior){if(prior.sha256!==hash||prior.client_file_id!==input.clientFileId||prior.position!==input.position||prior.filename!==name||prior.content_type!==type)throw new FileRequestError('This file identifier was already used.',409);return prior;}
  if(run.status!=='queued'||run.cancel_requested||input.position>=run.attachment_count)throw new FileRequestError('This task is not waiting for that file.',409);
  const key=`discussion-uploads/${sha(ownerId).slice(0,24)}/${discussionId}/${runId}/${input.clientFileId}-${hash}`;
  return (await tx`INSERT INTO discussion_uploads(id,discussion_id,run_id,client_file_id,position,filename,content_type,byte_size,sha256,storage_key)
   VALUES(${crypto.randomUUID()},${discussionId},${runId},${input.clientFileId},${input.position},${name},${type},${input.bytes.length},${hash},${key}) RETURNING *`)[0];
 });
 if(!row.ready){await (storage??createObjectStorage()).put(row.storage_key,input.bytes,type);await db`UPDATE discussion_uploads SET ready=true WHERE id=${row.id}`;}
 return discussionFile(row);
}
export async function handleDiscussionFiles(request:Request,ownerId:string):Promise<Response|null> {
 const path=new URL(request.url).pathname;
 const upload=path.match(/^\/api\/discussions\/([^/]+)\/runs\/([^/]+)\/files$/),download=path.match(/^\/api\/discussions\/([^/]+)\/files\/([^/]+)$/);
 if(!upload&&!download)return null;
 const id=uuid.parse((upload??download)![1]);await ownedDiscussion(ownerId,id);
 if(upload&&request.method==='POST'){
  const runId=uuid.parse(upload[2]);
  const [task]=await db`SELECT companion_id FROM runs WHERE id=${runId} AND discussion_id=${id}`;
  if(task){const url=new URL(request.url);url.pathname=`/api/companions/${task.companion_id}/runs/${runId}/files`;return handleFiles(new Request(url,new Request(request)),ownerId);}
  if(!(await db`SELECT id FROM discussion_runs WHERE id=${runId} AND discussion_id=${id}`).length)throw new DiscussionMissing('Task not found.');
  const form=await boundedFormData(request),file=form.get('file');
  if(!(file instanceof File))throw new FileRequestError('A file is required.',400);
  const value=await storeDiscussionUpload(ownerId,id,runId,{clientFileId:String(form.get('clientFileId')??''),position:Number(form.get('position')??NaN),filename:file.name,contentType:file.type,bytes:new Uint8Array(await file.arrayBuffer())});
  return Response.json({file:value},{status:201,headers:{'cache-control':'no-store'}});
 }
 if(download&&request.method==='GET'){
  const [file]=await db`SELECT * FROM discussion_uploads WHERE id=${uuid.parse(download[2])} AND discussion_id=${id} AND ready`;
  if(!file)throw new DiscussionMissing('File not found.');
  const blob=await createObjectStorage().get(file.storage_key);
  return new Response(blob.stream(),{headers:{'content-type':file.content_type,'content-length':String(file.byte_size),'content-disposition':`${file.content_type.startsWith('image/')?'inline':'attachment'}; filename="${file.filename}"`,'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
 }
 return Response.json({error:'Method not allowed.'},{status:405});
}

/** Cross-discussion bytes require an exact file ID in a user message, never an agent suggestion. */
export async function resolveDiscussionFile(ownerId:string,discussionId:string,fileId:string,sql:any=db){
 await ownedDiscussion(ownerId,discussionId,sql);
 const [file]=await sql`SELECT * FROM (
  SELECT u.id,u.discussion_id,u.filename,u.content_type,u.byte_size,u.sha256,u.storage_key
   FROM discussion_uploads u JOIN discussions d ON d.id=u.discussion_id WHERE u.id=${fileId} AND u.ready AND d.owner_id=${ownerId}
  UNION ALL
  SELECT a.id,r.discussion_id,a.filename,a.content_type,a.byte_size,a.sha256,a.storage_key
   FROM attachments a JOIN runs r ON r.id=a.run_id JOIN companions c ON c.id=a.companion_id WHERE a.id=${fileId} AND a.owner_id=${ownerId} AND c.owner_id=${ownerId}
 ) f WHERE f.discussion_id=${discussionId} OR EXISTS(SELECT 1 FROM discussion_messages m WHERE m.discussion_id=${discussionId} AND m.role='user' AND position(${fileId} in m.content)>0)`;
 return file??null;
}
