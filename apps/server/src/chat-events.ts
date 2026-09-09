import {z} from 'zod';
const integer=z.number().int().positive().max(2147483647);
const snapshotShape=z.object({
 messageVersion:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 messages:z.array(z.object({sequence:integer,order:integer.optional(),text:z.string(),createdAt:z.string().datetime(),complete:z.boolean()})),
 events:z.array(z.object({sequence:integer,kind:z.enum(['thinking','tool']),createdAt:z.string().datetime(),text:z.string().max(20_000).optional(),
  toolName:z.string().max(200).optional(),application:z.object({name:z.string().max(200),provider:z.string().max(100)}).optional(),
  status:z.enum(['running','succeeded','failed','unknown']).optional()})).optional()
}).refine(value=>new Set(value.messages.map(m=>m.sequence)).size===value.messages.length)
 .refine(value=>!value.events?.length||[...value.messages.map(m=>m.order??0),...value.events.map(e=>e.sequence)].sort((a,b)=>a-b).every((order,index)=>order===index+1));
/** One snapshot transaction keeps version fencing, new positions and content inseparable. */
export async function persistChatSnapshot(sql:any,run:any,result:unknown,leaderPid?:number){
 const parsed=snapshotShape.safeParse(result);if(!parsed.success)return;
 const snapshot=parsed.data;
 await sql.begin(async(tx:any)=>{
  const [observed]=await tx`UPDATE runs SET message_version=${snapshot.messageVersion}
   WHERE id=${run.id} AND companion_id=${run.companion_id} AND (message_version IS NULL OR message_version<${snapshot.messageVersion})
   AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=COALESCE(${leaderPid??null}::int,pg_backend_pid()) AND objid=721440139 AND granted)
   RETURNING lane`;
  if(!observed||observed.lane!=='main')return;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${run.companion_id}::text,9158))`;
  const previousMessages=new Map((await tx`SELECT sequence,content,complete FROM messages WHERE run_id=${run.id} AND role='assistant'`).map((row:any)=>[row.sequence,row]));
  const previousEvents=new Map((await tx`SELECT sequence,text,status FROM chat_events WHERE run_id=${run.id}`).map((row:any)=>[row.sequence,row]));
  const entries=[...snapshot.messages.map(message=>({order:message.order??message.sequence,message,event:null})),
   ...(snapshot.events??[]).map(event=>({order:event.sequence,message:null,event}))].sort((a,b)=>a.order-b.order);
  for(const entry of entries){
   if(entry.message){const m=entry.message;const previous:any=previousMessages.get(m.sequence);if(!m.text||previous?.complete||previous?.content===m.text&&previous?.complete===m.complete)continue;
    await tx`INSERT INTO messages(id,companion_id,run_id,role,sequence,content,created_at,complete)
     VALUES(gen_random_uuid(),${run.companion_id},${run.id},'assistant',${m.sequence},${m.text},${m.createdAt},${m.complete})
     ON CONFLICT(run_id,role,sequence) DO UPDATE SET content=EXCLUDED.content,complete=EXCLUDED.complete
      WHERE NOT messages.complete AND (messages.content,messages.complete) IS DISTINCT FROM (EXCLUDED.content,EXCLUDED.complete)`;
   }else if(entry.event){const e=entry.event;const previous:any=previousEvents.get(e.sequence);
    if(previous&&(e.kind==='tool'&&previous.status!=='running'||previous.text===(e.text??null)&&previous.status===(e.status??null)))continue;
    await tx`INSERT INTO chat_events(companion_id,run_id,sequence,kind,position,created_at,text,tool_name,application,status)
     VALUES(${run.companion_id},${run.id},${e.sequence},${e.kind},nextval('conversation_position_seq'),${e.createdAt},${e.text??null},${e.toolName??null},${e.application??null},${e.status??null})
     ON CONFLICT(run_id,sequence) DO UPDATE SET text=EXCLUDED.text,status=EXCLUDED.status
      WHERE chat_events.kind=EXCLUDED.kind AND (chat_events.kind='thinking' OR chat_events.status='running')
       AND (chat_events.text,chat_events.status) IS DISTINCT FROM (EXCLUDED.text,EXCLUDED.status)`;
   }
  }
 });
}
