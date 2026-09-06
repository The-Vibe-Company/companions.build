import {db} from './store';
import {z} from 'zod';
import {listRoutines,createRoutine,updateRoutine,deleteRoutine,routineHistory,routineInput,requestRunResume} from './automations';
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'cache-control':'no-store'}});
export async function handleAutomations(request:Request,ownerId:string):Promise<Response|null>{
 const path=new URL(request.url).pathname;
 const question=path.match(/^\/api\/companions\/([a-f0-9-]+)\/questions\/([a-f0-9-]+)\/answer$/);
 if(question&&request.method==='POST') {
  const companionId=z.string().uuid().parse(question[1]);const id=z.string().uuid().parse(question[2]);
  const {answer}=z.object({answer:z.string().trim().min(1).max(5000)}).parse(await request.json());
  return db.begin(async tx=>{
   const [row]=await tx`SELECT q.*,r.status FROM task_questions q JOIN companions c ON c.id=q.companion_id JOIN runs r ON r.id=q.run_id WHERE q.id=${id} AND c.id=${companionId} AND c.owner_id=${ownerId} FOR UPDATE OF q`;
   if(!row)return json({error:'Question not found.'},404);
   if(row.answer)return row.answer===answer?json({ok:true}):json({error:'This question already has an answer.'},409);
   if(!['running','needs_input'].includes(row.status))return json({error:'This task is no longer waiting.'},409);
   await tx`UPDATE task_questions SET answer=${answer},answered_at=now() WHERE id=${id}`;
   await requestRunResume(companionId,row.run_id,tx);return json({ok:true});
  });
 }
 const task=path.match(/^\/api\/companions\/([a-f0-9-]+)\/runs\/([a-f0-9-]+)\/cancel$/);
 if(task&&request.method==='POST') {
  const companionId=z.string().uuid().parse(task[1]);const runId=z.string().uuid().parse(task[2]);
  const rows=await db`UPDATE runs r SET cancel_requested=CASE WHEN r.status IN ('succeeded','failed','interrupted','cancelled') THEN r.cancel_requested ELSE true END,finished_at=CASE WHEN r.status='queued' THEN now() ELSE r.finished_at END,status=CASE WHEN r.status='queued' THEN 'cancelled' ELSE r.status END WHERE r.id=${runId} AND r.companion_id=${companionId} AND EXISTS(SELECT 1 FROM companions c WHERE c.id=r.companion_id AND c.owner_id=${ownerId}) RETURNING r.id`;
  return rows.length?json({ok:true}):json({error:'Task not found.'},404);
 }
 const match=path.match(/^\/api\/companions\/([a-f0-9-]+)\/routines(?:\/([a-f0-9-]+))?(\/history)?$/);
 if(!match)return null;
 const id=z.string().uuid().parse(match[1]);
 const [companion]=await db`SELECT id FROM companions WHERE id=${id} AND owner_id=${ownerId} AND retired_at IS NULL`;
 if(!companion)return json({error:'Companion not found.'},404);
 if(match[2])z.string().uuid().parse(match[2]);
 if(request.method==='GET')return match[2]?json(await routineHistory(id,match[2])):json({routines:await listRoutines(id)});
 if(request.method==='POST'&&!match[2])return json({routine:await createRoutine(id,routineInput.parse(await request.json()))},201);
 if(request.method==='PATCH'&&match[2])return json({routine:await updateRoutine(id,match[2],routineInput.partial().parse(await request.json()))});
 if(request.method==='DELETE'&&match[2])return json({ok:await deleteRoutine(id,match[2])});
 return json({error:'Method not allowed.'},405);
}
