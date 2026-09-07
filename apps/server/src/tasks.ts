import {z} from 'zod';
import {db} from './store';
import {filesForThread} from './files';

const uuid=z.string().uuid();
const cursorSchema=z.object({v:z.literal(1),companionId:uuid,time:z.iso.datetime({precision:6}),id:uuid}).strict();
const summaryColumns=`r.id,r.status,r.lane,r.source,r.created_at AS "createdAt",r.finished_at AS "finishedAt",left(btrim(r.content),120) AS title`;
const detailColumns=`${summaryColumns},r.content,r.result_text AS "resultText",r.error,r.started_at AS "startedAt",r.prepared_at AS "preparedAt",r.cancel_requested AS "cancelRequested",r.publish_to_chat AS "publishToChat"`;
const terminal=new Set(['succeeded','failed','interrupted','cancelled']);
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const missing=()=>json({error:'Task not found.'},404);
class SharedChatCancellation extends Error {}

function decodeCursor(value:string|null,companionId:string){
 if(value===null)return null;
 if(value.length>512||!value||!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Invalid cursor');
 const bytes=Buffer.from(value,'base64url');
 if(bytes.toString('base64url')!==value)throw Error('Invalid cursor');
 const cursor=cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
 if(cursor.companionId!==companionId)throw Error('Invalid cursor');
 return cursor;
}
function encodeCursor(companionId:string,row:any){
 return Buffer.from(JSON.stringify({v:1,companionId,time:row.cursorTime,id:row.id})).toString('base64url');
}
function summary(row:any){
 return {id:row.id,status:row.status,lane:row.lane,source:row.source,createdAt:row.createdAt,finishedAt:row.finishedAt,title:row.title};
}
function taskDetail(row:any){
 return {...summary(row),content:row.content,resultText:row.resultText,error:row.error,startedAt:row.startedAt,preparedAt:row.preparedAt,cancelRequested:row.cancelRequested,publishToChat:row.publishToChat};
}

/** Only this task is cancelled; the executor owns any subsequent daemon contact. */
export async function cancelTask(ownerId:string,companionId:string,taskId:string,database:any=db){
 return database.begin(async(tx:any)=>{
  // Same order as admission and retirement, so a concurrently removed Companion wins safely.
  const [companion]=await tx`SELECT id FROM companions WHERE id=${companionId} AND owner_id=${ownerId} AND retired_at IS NULL AND archive_requested_at IS NULL FOR UPDATE`;
  if(!companion)return null;
  const [task]=await tx.unsafe(`SELECT ${detailColumns},r.dispatched FROM runs r WHERE r.id=$1 AND r.companion_id=$2 FOR UPDATE`,[taskId,companionId]);
  if(!task)return null;
  if(terminal.has(task.status))return taskDetail(task);
  // Native steers share a Pi response root; only the chat stop action may stop that group.
  if(task.lane==='main'&&task.dispatched)throw new SharedChatCancellation('Stop the current response from chat.');
  await tx`UPDATE runs SET cancel_requested=true,finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END,
   status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE id=${taskId} AND companion_id=${companionId}`;
  return taskDetail((await tx.unsafe(`SELECT ${detailColumns} FROM runs r WHERE r.id=$1 AND r.companion_id=$2`,[taskId,companionId]))[0]);
 });
}

export async function handleTasks(request:Request,ownerId:string):Promise<Response|null>{
 const url=new URL(request.url),match=url.pathname.match(/^\/api\/companions\/([^/]+)\/tasks(?:\/([^/]+))?(\/cancel)?$/);
 if(!match)return null;
 const companionId=uuid.parse(match[1]),taskId=match[2]?uuid.parse(match[2]):null;
 if(match[3]&&taskId&&request.method==='POST'){
  try{
   const task=await cancelTask(ownerId,companionId,taskId);
   return task?json({task}):missing();
  }catch(error){if(error instanceof SharedChatCancellation)return json({error:error.message},409);throw error;}
 }
 if(request.method!=='GET'||match[3])return json({error:'Method not allowed.'},405);
 const [companion]=await db`SELECT id FROM companions WHERE id=${companionId} AND owner_id=${ownerId}`;
 if(!companion)return missing();
 if(taskId){
  const [row]=await db.unsafe(`SELECT ${detailColumns} FROM runs r WHERE r.id=$1 AND r.companion_id=$2`,[taskId,companionId]);
  if(!row)return missing();
  return json({task:taskDetail(row),files:await filesForThread(ownerId,companionId,{runId:taskId})});
 }
 let limit:number,cursor:ReturnType<typeof decodeCursor>;
 try{
  const rawLimit=url.searchParams.get('limit')??'20';
  if(!/^\d{1,2}$/.test(rawLimit)||url.searchParams.getAll('limit').length>1||url.searchParams.getAll('before').length>1)throw Error('Invalid pagination');
  limit=z.number().int().min(1).max(50).parse(Number(rawLimit));
  cursor=decodeCursor(url.searchParams.get('before'),companionId);
 }catch{return json({error:'Invalid task pagination.'},400);}
 const rows=await db.unsafe(`SELECT ${summaryColumns},to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
  FROM runs r WHERE r.companion_id=$1 AND ($2::timestamptz IS NULL OR (r.created_at,r.id)<($2::timestamptz,$3::uuid))
  ORDER BY r.created_at DESC,r.id DESC LIMIT $4`,[companionId,cursor?.time??null,cursor?.id??null,limit+1]);
 const page=rows.slice(0,limit);
 return json({tasks:page.map(summary),nextCursor:rows.length>limit?encodeCursor(companionId,page.at(-1)):null});
}
