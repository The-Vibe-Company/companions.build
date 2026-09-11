import {z} from 'zod';
import {db,companionColumns} from './store';
import {filesForThread} from './files';

const uuid=z.string().uuid();
const kind=z.enum(['message','question','thinking']);
const cursorSchema=z.object({v:z.literal(1),companionId:uuid,time:z.iso.datetime({precision:6}),sequence:z.number().int().min(0).max(2147483647),kind,id:uuid}).strict();
const activeStatuses=['queued','preparing','running','needs_input'];
const runColumns=`r.id,r.status,r.error,r.lane,r.source,r.started_at AS "startedAt",r.result_text AS "resultText",r.preview_text AS "previewText",r.message_version AS "messageVersion",r.thinking_text AS "thinkingText",r.publish_to_chat AS "publishToChat",r.response_root_id AS "responseRootId",r.created_at AS "createdAt",r.prepared_at AS "preparedAt",r.finished_at AS "finishedAt",
 EXISTS(SELECT 1 FROM messages published WHERE published.run_id=r.id AND published.role='assistant') AS "hasPublishedMessage",
 EXISTS(SELECT 1 FROM task_questions asked WHERE asked.run_id=r.id) AS "hasQuestion"`;
const entryCte=`WITH entries AS NOT MATERIALIZED (
 SELECT m.id,'message'::text AS kind,m.created_at,m.sequence,m.run_id FROM messages m WHERE m.companion_id=$1
 UNION ALL
 SELECT q.id,'question',q.created_at,0,q.run_id FROM task_questions q WHERE q.companion_id=$1
 UNION ALL
 SELECT r.id,'thinking',r.created_at,0,r.id FROM runs r WHERE r.companion_id=$1 AND r.lane='main'
  AND r.thinking_text IS NOT NULL AND r.status IN ('succeeded','failed','interrupted','cancelled')
)`;

export type ChatEntry={id:string;kind:'message'|'question'|'thinking';createdAt:string;sequence:number;cursor:string;runId:string};
export type ChatPage={entries:ChatEntry[];messages:any[];runs:any[];questions:any[];files:any[];beforeCursor:string|null;afterCursor:string|null;nextCursor:string|null};
type Cursor=z.infer<typeof cursorSchema>;
type Query={limit:number;before:Cursor|null;after:Cursor|null;around:Cursor|null;from:Cursor|null;through:Cursor|null};
export class ChatPaginationError extends Error{}

function decode(value:string|null,companionId:string):Cursor|null{
 if(value===null)return null;
 try{
  if(!value||value.length>512||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
  const bytes=Buffer.from(value,'base64url');
  if(bytes.toString('base64url')!==value)throw Error();
  const parsed=cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
  if(parsed.companionId!==companionId)throw Error();
  return parsed;
 }catch{throw new ChatPaginationError('Invalid chat pagination.');}
}
function encode(companionId:string,row:any){
 return Buffer.from(JSON.stringify({v:1,companionId,time:row.cursorTime,sequence:Number(row.sequence),kind:row.kind,id:row.id})).toString('base64url');
}
function compare(a:Cursor,b:Cursor){
 return a.time.localeCompare(b.time)||a.sequence-b.sequence||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id);
}
export function parseChatQuery(url:URL,companionId:string):Query{
 const names=['limit','before','after','around','from','through'];
 if(names.some(name=>url.searchParams.getAll(name).length>1))throw new ChatPaginationError('Invalid chat pagination.');
 const raw=url.searchParams.get('limit')??'50';
 if(!/^\d{1,2}$/.test(raw))throw new ChatPaginationError('Invalid chat pagination.');
 const limit=Number(raw);
 if(limit<1||limit>50)throw new ChatPaginationError('Invalid chat pagination.');
 const before=decode(url.searchParams.get('before'),companionId),after=decode(url.searchParams.get('after'),companionId),around=decode(url.searchParams.get('around'),companionId);
 if(Number(!!before)+Number(!!after)+Number(!!around)>1)throw new ChatPaginationError('Invalid chat pagination.');
 const from=decode(url.searchParams.get('from'),companionId),through=decode(url.searchParams.get('through'),companionId);
 if(from&&through&&compare(from,through)>0)throw new ChatPaginationError('Invalid chat pagination.');
 return {limit,before,after,around,from,through};
}
function values(cursor:Cursor|null){return [cursor?.time??null,cursor?.sequence??null,cursor?.kind??null,cursor?.id??null];}
async function selectEntries(tx:any,companionId:string,query:Query){
 const bounds=[...values(query.from),...values(query.through)];
 const boundSql=` AND ($6::timestamptz IS NULL OR (created_at,sequence,kind,id)>=($6::timestamptz,$7::int,$8::text,$9::uuid))
  AND ($10::timestamptz IS NULL OR (created_at,sequence,kind,id)<=($10::timestamptz,$11::int,$12::text,$13::uuid))`;
 const columns=`id,kind,sequence,run_id AS "runId",to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"`;
 if(query.around){
  const pivot=values(query.around),older=Math.floor(query.limit/2),newer=query.limit-older;
  const left=await tx.unsafe(`${entryCte} SELECT ${columns} FROM entries WHERE (created_at,sequence,kind,id)<($2::timestamptz,$3::int,$4::text,$5::uuid)${boundSql} ORDER BY created_at DESC,sequence DESC,kind DESC,id DESC LIMIT $14`,[companionId,...pivot,...bounds,query.limit]);
  const right=await tx.unsafe(`${entryCte} SELECT ${columns} FROM entries WHERE (created_at,sequence,kind,id)>=($2::timestamptz,$3::int,$4::text,$5::uuid)${boundSql} ORDER BY created_at,sequence,kind,id LIMIT $14`,[companionId,...pivot,...bounds,query.limit]);
  const rightCount=Math.min(right.length,left.length<older?query.limit-left.length:newer);
  const leftCount=Math.min(left.length,query.limit-rightCount);
  return {rows:[...left.slice(0,leftCount).reverse(),...right.slice(0,rightCount)],more:false};
 }
 const cursor=query.before??query.after;
 const forward=!!query.after||(!query.before&&!!query.from);
 const cursorSql=` AND ($2::timestamptz IS NULL OR (created_at,sequence,kind,id)${forward?'>':'<'}($2::timestamptz,$3::int,$4::text,$5::uuid))`;
 const descending=!forward;
 const rows=await tx.unsafe(`${entryCte} SELECT ${columns} FROM entries WHERE true${cursorSql}${boundSql} ORDER BY created_at ${descending?'DESC':'ASC'},sequence ${descending?'DESC':'ASC'},kind ${descending?'DESC':'ASC'},id ${descending?'DESC':'ASC'} LIMIT $14`,[companionId,...values(cursor),...bounds,query.limit+1]);
 const more=rows.length>query.limit,page=rows.slice(0,query.limit);
 if(descending)page.reverse();
 return {rows:page,more};
}

async function hydrate(tx:any,ownerId:string,companionId:string,query:Query):Promise<ChatPage>{
 const selected=await selectEntries(tx,companionId,query);
 const rows=selected.rows,runIds=[...new Set(rows.map((row:any)=>row.runId))] as string[],messageIds=rows.filter((row:any)=>row.kind==='message').map((row:any)=>row.id),questionIds=rows.filter((row:any)=>row.kind==='question').map((row:any)=>row.id);
 const [messages,runs,questions,files,lastAssistants]=await Promise.all([
  messageIds.length?tx.unsafe(`SELECT id,role,content,sequence,complete,created_at AS "createdAt",run_id AS "runId" FROM messages WHERE companion_id=$1 AND id=ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)::uuid)) ORDER BY created_at,sequence,id`,[companionId,messageIds]):[],
  runIds.length?tx.unsafe(`SELECT ${runColumns} FROM runs r WHERE r.companion_id=$1 AND r.id=ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)::uuid)) ORDER BY r.created_at,r.id`,[companionId,runIds]):[],
  questionIds.length?tx.unsafe(`SELECT q.id,q.run_id AS "runId",q.question,q.options,q.answer,q.created_at AS "createdAt",q.context_text AS "contextText",r.status AS "runStatus" FROM task_questions q JOIN runs r ON r.id=q.run_id WHERE q.companion_id=$1 AND q.id=ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)::uuid)) ORDER BY q.created_at,q.id`,[companionId,questionIds]):[],
  filesForThread(ownerId,companionId,{database:tx,runIds}),
  runIds.length?tx.unsafe(`SELECT DISTINCT ON (run_id) run_id AS "runId",id FROM messages WHERE companion_id=$1 AND run_id=ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)::uuid)) AND role='assistant' ORDER BY run_id,created_at DESC,sequence DESC,id DESC`,[companionId,runIds]):[],
 ]);
 const lastAssistant=new Map(lastAssistants.map((row:any)=>[row.runId,row.id]));
 const withFiles=messages.map((message:any)=>({...message,files:files.filter((file:any)=>file.runId===message.runId&&file.kind===(message.role==='user'?'user_upload':'agent_output')&&(message.role==='user'||lastAssistant.get(message.runId)===message.id))}));
 const thinking=new Set(rows.filter((row:any)=>row.kind==='thinking').map((row:any)=>row.runId));
 const safeRuns=runs.map((run:any)=>{if(thinking.has(run.id))return run;const {thinkingText:_,...safe}=run;return safe;});
 const entries=rows.map((row:any)=>({id:`${row.kind==='message'||row.kind==='question'?'':row.kind+'-'}${row.id}`,kind:row.kind,createdAt:row.cursorTime,sequence:Number(row.sequence),cursor:encode(companionId,row),runId:row.runId}));
 let beforeCursor:string|null=null,afterCursor:string|null=null;
 if(entries.length){
  const first=rows[0],last=rows.at(-1);
  const [edge]=await tx.unsafe(`${entryCte} SELECT EXISTS(SELECT 1 FROM entries WHERE (created_at,sequence,kind,id)<($2::timestamptz,$3::int,$4::text,$5::uuid)) AS older,EXISTS(SELECT 1 FROM entries WHERE (created_at,sequence,kind,id)>($6::timestamptz,$7::int,$8::text,$9::uuid)) AS newer`,[companionId,...values(cursorSchema.parse({v:1,companionId,time:first.cursorTime,sequence:Number(first.sequence),kind:first.kind,id:first.id})),...values(cursorSchema.parse({v:1,companionId,time:last.cursorTime,sequence:Number(last.sequence),kind:last.kind,id:last.id}))]);
  if(edge.older)beforeCursor=entries[0].cursor;if(edge.newer)afterCursor=entries.at(-1)!.cursor;
 }
 const forward=!!query.after||(!query.before&&!query.around&&!!query.from);
 const continuation=selected.more?(forward?entries.at(-1)?.cursor:entries[0]?.cursor)??null:null;
 return {entries,messages:withFiles,runs:safeRuns,questions,files,beforeCursor,afterCursor,nextCursor:continuation};
}

async function transaction<T>(work:(tx:any)=>Promise<T>){
 return db.begin(async tx=>{await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');return work(tx);});
}
export async function chatPage(ownerId:string,companionId:string,query:Query){
 return transaction(async tx=>{
  const [owned]=await tx.unsafe('SELECT id FROM companions WHERE id=$1 AND owner_id=$2',[companionId,ownerId]);
  return owned?hydrate(tx,ownerId,companionId,query):null;
 });
}
export async function companionHttpDetail(ownerId:string,companionId:string,query:Query){
 return transaction(async tx=>{
  const [companion]=await tx.unsafe(`SELECT ${companionColumns} FROM companions WHERE id=$1 AND owner_id=$2`,[companionId,ownerId]);
  if(!companion)return null;
  const chat=await hydrate(tx,ownerId,companionId,query);
  const liveRunRows=await tx.unsafe(`SELECT ${runColumns},to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime" FROM runs r WHERE r.companion_id=$1 AND r.status=ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb))) ORDER BY r.created_at,r.id`,[companionId,activeStatuses]);
  const liveQuestionRows=await tx.unsafe(`SELECT to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime",q.id,q.run_id AS "runId",q.question,q.options,q.answer,q.created_at AS "createdAt",q.context_text AS "contextText",r.status AS "runStatus" FROM task_questions q JOIN runs r ON r.id=q.run_id WHERE q.companion_id=$1 AND q.answer IS NULL AND r.status=ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb))) ORDER BY q.created_at,q.id`,[companionId,activeStatuses]);
  // Off-page items carry a durable location so the web can retain their settled state.
  const liveRuns=liveRunRows.map(({cursorTime,...run}:any)=>({...run,cursor:encode(companionId,{id:run.id,kind:'thinking',sequence:0,cursorTime})}));
  const liveQuestions=liveQuestionRows.map(({cursorTime,...question}:any)=>({...question,createdAt:cursorTime,cursor:encode(companionId,{id:question.id,kind:'question',sequence:0,cursorTime})}));
  const runMap=new Map(chat.runs.map((run:any)=>[run.id,run]));for(const run of liveRuns)runMap.set(run.id,run);
  const questionMap=new Map(chat.questions.map((question:any)=>[question.id,question]));for(const question of liveQuestions)questionMap.set(question.id,question);
  const runs=[...runMap.values()],questions=[...questionMap.values()];
  return {companion,messages:chat.messages,runs,questions,files:chat.files,activity:runs.filter((run:any)=>run.lane==='background'),chat,live:{runs:liveRuns,questions:liveQuestions}};
 });
}
