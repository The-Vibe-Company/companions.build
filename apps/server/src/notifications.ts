import {z} from 'zod';
import {db} from './store';
const uuid=z.string().uuid();
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
const actionable=`q.answer IS NULL AND q.id IS NOT NULL AND r.status IN ('running','needs_input') AND NOT r.cancel_requested AND c.retired_at IS NULL AND c.archive_requested_at IS NULL`;
export async function handleNotifications(request:Request,ownerId:string):Promise<Response|null>{
 const url=new URL(request.url);
 if(url.pathname==='/api/notifications/summary'&&request.method==='GET'){
  const companions=await db.unsafe(`SELECT c.id AS "companionId",count(n.id) FILTER(WHERE n.read_at IS NULL)::int AS unread,
   count(n.id) FILTER(WHERE n.kind='question' AND ${actionable})::int AS "needsInput"
   FROM companions c LEFT JOIN routine_notifications n ON n.companion_id=c.id
   LEFT JOIN runs r ON r.id=n.run_id LEFT JOIN task_questions q ON n.kind='question' AND q.id=n.source_id
   WHERE c.owner_id=$1 AND c.retired_at IS NULL AND c.archive_requested_at IS NULL
   GROUP BY c.id`,[ownerId]);
  return json({companions});
 }
 const match=url.pathname.match(/^\/api\/companions\/([^/]+)\/notifications(?:\/([^/]+)\/read)?$/);
 if(!match)return null;
 const companionId=uuid.parse(match[1]);
 const [owner]=await db`SELECT id FROM companions WHERE id=${companionId} AND owner_id=${ownerId}`;
 if(!owner)return json({error:'Companion not found.'},404);
 if(match[2]&&request.method==='POST'){
  const id=uuid.parse(match[2]);
  const rows=await db`UPDATE routine_notifications SET read_at=COALESCE(read_at,now()) WHERE id=${id} AND companion_id=${companionId} RETURNING id`;
  return rows.length?json({read:true}):json({error:'Notification not found.'},404);
 }
 if(match[2]||request.method!=='GET')return json({error:'Not found.'},404);
 const limit=z.coerce.number().int().min(1).max(50).parse(url.searchParams.get('limit')??20);
 let cursor:{createdAt:string;id:string}|null=null;
 if(url.searchParams.has('cursor')){
  try{cursor=z.object({createdAt:z.string().datetime({offset:true}),id:uuid}).parse(JSON.parse(Buffer.from(url.searchParams.get('cursor')!,'base64url').toString()));}
  catch{return json({error:'Invalid notification cursor.'},400);}
 }
 const rows=await db.unsafe(`SELECT n.id,n.run_id AS "runId",n.kind,n.created_at AS "createdAt",
  to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorDate",
  n.read_at AS "readAt",r.routine_id AS "routineId",COALESCE(r.routine_name,'Routine') AS "routineName",
  to_char(n.created_at AT TIME ZONE COALESCE(r.routine_timezone,'UTC'),'YYYY-MM-DD') AS "groupDate",
  q.id AS "questionId",r.status AS "runStatus",COALESCE((${actionable}),false) AS actionable,
  CASE WHEN n.kind='question' THEN q.question WHEN n.kind='result' THEN COALESCE(m.content,r.result_text,'')
   WHEN r.status='interrupted' THEN 'This routine was interrupted. Inspect its activity before retrying.'
   ELSE 'This routine could not complete. Open its activity for details.' END AS text,
  CASE WHEN q.id IS NOT NULL THEN jsonb_build_object('id',q.id,'runId',q.run_id,'question',q.question,'options',q.options,
   'answer',q.answer,'runStatus',CASE WHEN r.cancel_requested THEN 'cancelled' ELSE r.status END,'createdAt',q.created_at,'contextText',q.context_text) END AS question
  FROM routine_notifications n JOIN companions c ON c.id=n.companion_id JOIN runs r ON r.id=n.run_id
  LEFT JOIN task_questions q ON n.kind='question' AND q.id=n.source_id
  LEFT JOIN messages m ON n.kind='result' AND m.id=n.source_id
  WHERE n.companion_id=$1 AND c.owner_id=$2 AND ($3::timestamptz IS NULL OR (n.created_at,n.id)<($3::timestamptz,$4::uuid))
  ORDER BY n.created_at DESC,n.id DESC LIMIT $5`,[companionId,ownerId,cursor?.createdAt??null,cursor?.id??null,limit+1]);
 const page=rows.slice(0,limit);const last=page.at(-1);
 return json({notifications:page.map(({cursorDate,...row}:any)=>row),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({createdAt:last.cursorDate,id:last.id})).toString('base64url'):null});
}
