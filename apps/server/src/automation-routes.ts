import {db} from './store';
import {z} from 'zod';
import {listRoutines,createRoutine,updateRoutine,deleteRoutine,routineHistory,routineInput} from './automations';
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'cache-control':'no-store'}});
export async function handleAutomations(request:Request,ownerId:string):Promise<Response|null>{
 const path=new URL(request.url).pathname;
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
