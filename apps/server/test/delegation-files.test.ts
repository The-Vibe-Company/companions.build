import {beforeAll,expect,test} from 'bun:test';
import {db,migrate,createCompanion} from '../src/store';
import {acquireExecutor,runExecution} from '../src/executor';
import {progressLifecycle,type LifecycleMachines} from '../src/lifecycle';
import {saveTemplate,allowTemplate} from '../src/templates';
import {spawnChild} from '../src/delegation';
import {storeAgentOutput,filesForAgent,filesForThread,handleFiles,handoffDelegationFiles,FileRequestError} from '../src/files';
import {createObjectStorage} from '../src/storage';
import {productHooks} from '../src/runtime-product';
import {encrypt,decrypt} from '../src/config';
const owner='00000000-0000-4000-8000-000000000001';
beforeAll(async()=>{await migrate();});
async function leader(){const sql=await acquireExecutor();if(!sql)throw Error('No test executor');const [{pid}]=await sql`SELECT pg_backend_pid() AS pid`;return {sql,pid,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};}
// verify.py provides a private MinIO container. Never use inherited developer S3 credentials here.
test.skipIf(!process.env.COMPANIONS_VERIFY_RUN)('parent receives exact retained child bytes after archive with atomic, owner-scoped handoff',async()=>{
 const lock=await leader(),storage=createObjectStorage(),bytes=Buffer.from('child-only random marker '+crypto.randomUUID()+'\n'),clientFileId=crypto.randomUUID();let puts=0,deletes=0,archives=0;
 const tracked={async put(key:string,value:Uint8Array,type:string){puts++;await storage.put(key,value,type);},get:storage.get,async delete(key:string){deletes++;await storage.delete(key);}};
 const parent=await createCompanion(owner,{name:'Parent',instructions:'Read retained files.',provider:'box'}),template=await saveTemplate(owner,{name:'Worker',instructions:'Return a file.'});
 await allowTemplate(owner,parent.id,{templateId:template.id,maxChildren:1});
 const delegationId=crypto.randomUUID(),child=await spawnChild(owner,parent.id,null,delegationId,{templateId:template.id,prompt:'Generate a private random marker only in report.txt.'});
 await db`UPDATE companions SET prepare_requested=false,status='ready',box_id=${'owned-'+child.companionId} WHERE id=${child.companionId}`;
 await db`UPDATE runs SET status='succeeded',dispatched=true,started_at=now(),finished_at=now(),result_text='Report is in the outbox.' WHERE id=${child.runId}`;
 const output=await storeAgentOutput({ownerId:owner,companionId:child.companionId,runId:child.runId,clientFileId,position:0,filename:'report.txt',bytes},{storage:tracked});
 const staged:Array<{path:string;body:any}>=[];
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  if(path.startsWith('/api/'))return await handleFiles(request,request.headers.get('x-test-owner')??owner)??new Response(null,{status:404});
  if(path==='/files/outbox')return Response.json({files:[{id:clientFileId,position:0,name:'report.txt',sha256:output.sha256,size:bytes.length}]});
  if(path.startsWith('/runs/'))return Response.json({status:'succeeded'});
  if(path.startsWith('/files/inbox/')){const body=await request.json();staged.push({path,body});return Response.json({path:'/state/workspace/inbox/report.txt'});}
  return Response.json({});
 }});
 const endpoint=`http://127.0.0.1:${daemon.port}`;
 await db`UPDATE companions SET endpoint_secret=${encrypt(endpoint)} WHERE id IN (${parent.id},${child.companionId})`;
 const machine:LifecycleMachines={async prepare(){throw Error('Handoff must not prepare a machine');},async health(){throw Error('unused');},async pause(){},async archive(){archives++;return true;},async snapshot(){},async snapshotStatus(){return 'ready';}};
 const scope={companionId:child.companionId,leaderPid:lock.pid};
 try{
  await progressLifecycle(lock.sql,{filesDurable:async()=>false},machine,scope);
  expect((await db`SELECT returned_run_id FROM delegations WHERE id=${delegationId}`)[0].returned_run_id).toBeNull();
  // A failed reference checkpoint rolls back the review itself; retry cannot create a duplicate.
  await db.unsafe(`CREATE FUNCTION reject_test_handoff() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected handoff failure'; END $$; CREATE TRIGGER reject_test_handoff BEFORE INSERT ON delegation_files FOR EACH ROW EXECUTE FUNCTION reject_test_handoff()`);
  try{await expect(progressLifecycle(lock.sql,productHooks.lifecycle,machine,scope)).rejects.toThrow('injected handoff failure');}
  finally{await db.unsafe('DROP TRIGGER reject_test_handoff ON delegation_files; DROP FUNCTION reject_test_handoff()');}
  expect(await db`SELECT id FROM runs WHERE companion_id=${parent.id} AND source='delegation'`).toHaveLength(0);
  await progressLifecycle(lock.sql,productHooks.lifecycle,machine,scope);await progressLifecycle(lock.sql,productHooks.lifecycle,machine,scope);
  const [delegation]=await db`SELECT returned_run_id FROM delegations WHERE id=${delegationId}`,reviewId=delegation.returned_run_id;
  expect(await db`SELECT id FROM runs WHERE companion_id=${parent.id} AND source='delegation'`).toHaveLength(1);
  const references=await db`SELECT attachment_id FROM delegation_files WHERE target_run_id=${reviewId}`;expect(references.map((row:any)=>row.attachment_id)).toEqual([output.id]);
  await db.begin(tx=>handoffDelegationFiles(owner,delegationId,reviewId,tx));
  expect(await db`SELECT attachment_id FROM delegation_files WHERE target_run_id=${reviewId}`).toHaveLength(1);expect(puts).toBe(1);expect(deletes).toBe(0);
  // Provider archive may happen while the parent is idle, before it begins its review.
  await db`UPDATE companions SET status='archived',archived_at=now(),endpoint_secret=null WHERE id=${child.companionId}`;
  const [run]=await db`SELECT r.*,c.owner_id,c.endpoint_secret,c.agent_secret,c.box_id FROM runs r JOIN companions c ON c.id=r.companion_id WHERE r.id=${reviewId}`;
  expect(run.attachment_count).toBe(0);expect(run.content).not.toContain(bytes.toString());
  await productHooks.prepareRun!(run,endpoint,decrypt(run.agent_secret),runExecution(run,lock.pid));
  expect(staged).toHaveLength(1);expect(staged[0].path).toBe(`/files/inbox/${reviewId}/0`);expect(Buffer.from(staged[0].body.data,'base64')).toEqual(bytes);expect(run.content).toContain('/state/workspace/inbox/report.txt');
  const foreign=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${foreign},'Other',${foreign+'@example.test'},true)`;
  const foreignParent=await createCompanion(foreign,{name:'Other parent',instructions:'',provider:'box'});
  await expect(handoffDelegationFiles(foreign,delegationId,reviewId)).rejects.toBeInstanceOf(FileRequestError);
  await expect(filesForAgent({ownerId:foreign,companionId:parent.id,runId:reviewId})).rejects.toBeInstanceOf(FileRequestError);
  expect(await filesForThread(foreign,parent.id)).toEqual([]);expect(await filesForThread(foreign,foreignParent.id)).toEqual([]);
  // Normal finalization retires the child, but parent references and owner downloads survive.
  await db`UPDATE runs SET status='succeeded',finished_at=now() WHERE id=${reviewId}`;
  await progressLifecycle(lock.sql,productHooks.lifecycle,machine,scope);expect(archives).toBe(1);
  expect((await db`SELECT retired_at FROM companions WHERE id=${child.companionId}`)[0].retired_at).not.toBeNull();
  expect((await filesForAgent({ownerId:owner,companionId:parent.id,runId:reviewId}))[0].bytes).toEqual(new Uint8Array(bytes));
  const links=await filesForThread(owner,parent.id);expect(links).toHaveLength(1);expect(links[0]).toMatchObject({id:output.id,runId:reviewId,name:'report.txt',kind:'agent_output',url:`/api/companions/${child.companionId}/files/${output.id}`});
  const download=await fetch(endpoint+links[0].url,{signal:AbortSignal.timeout(2000)});expect(download.status).toBe(200);expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  expect((await fetch(endpoint+links[0].url,{headers:{'x-test-owner':foreign},signal:AbortSignal.timeout(2000)})).status).toBe(404);
  await expect((async()=>{await db`DELETE FROM attachments WHERE id=${output.id}`;})()).rejects.toThrow();
  const [stored]=await db`SELECT storage_key FROM attachments WHERE id=${output.id}`;expect(Buffer.from(await (await storage.get(stored.storage_key)).arrayBuffer())).toEqual(bytes);
  await storage.put(stored.storage_key,Buffer.from('corrupted'),'text/plain');
  await expect(filesForAgent({ownerId:owner,companionId:parent.id,runId:reviewId})).rejects.toThrow('integrity');
 }finally{await lock.close();daemon.stop(true);}
});
