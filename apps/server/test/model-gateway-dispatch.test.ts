import {beforeAll,test,expect} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {acquireExecutor,tick} from '../src/executor';
import {config,encrypt} from '../src/config';
import {verifyModelGatewayToken} from '../src/model-gateway-token';

beforeAll(async()=>{await migrate();});
test('gateway dispatch persists the selected model and usage authority before contacting Pi',async()=>{
 const owner='00000000-0000-4000-8000-000000000001';
 const previous={testMode:config.testMode,modelProvider:config.modelProvider,modelId:config.modelId,modelGatewayUrl:config.modelGatewayUrl};
 let seen:any,observed:any;
 const daemon=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  if(new URL(request.url).pathname==='/health')return Response.json({ready:true});
  if(request.method==='PUT'){
   seen=await request.json();const id=new URL(request.url).pathname.split('/').at(-1)!;
   [observed]=await db`SELECT dispatched,status,model_provider,model_id,usage_source FROM runs WHERE id=${id}`;
   return Response.json({status:'running',responseRootId:id});
  }
  return Response.json({status:'running'});
 }});
 let id:string|undefined,lock:Awaited<ReturnType<typeof acquireExecutor>>;
 try{
  Object.assign(config,{testMode:false,modelProvider:'zai',modelId:'default-model',modelGatewayUrl:'https://fixture.invalid/api/model-gateway'});
  const c=await createCompanion(owner,{name:'Gateway dispatch fixture',provider:'box',prepare:false});id=c.id;
  await db`UPDATE companions SET model_id='chosen-model',status='ready',prepare_requested=false,box_id='owned-test-box',ready_at=now(),endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${id}`;
  const runId=await acceptMessage(owner,id!,crypto.randomUUID(),'One model call');
  lock=await acquireExecutor();if(!lock)throw Error('No test leader');
  await tick(lock,{canStartWork:async()=>true});
  expect(observed).toEqual({dispatched:true,status:'running',model_provider:'zai',model_id:'chosen-model',usage_source:'gateway'});
  expect(seen.modelId).toBe('chosen-model');
  expect(Object.keys(seen.modelGateway)).toEqual(['token']);
  expect(verifyModelGatewayToken(seen.modelGateway.token)).toMatchObject({companionId:id,runId});
  await db`UPDATE companions SET model_id='future-model' WHERE id=${id}`;
  expect((await db`SELECT model_id FROM runs WHERE id=${runId}`)[0].model_id).toBe('chosen-model');
 }finally{
  if(id){await db`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${id}`;await db`UPDATE companions SET retired_at=now(),prepare_requested=false WHERE id=${id}`;}
  if(lock!){await lock`SELECT pg_advisory_unlock(721440139)`;lock.release();}
  Object.assign(config,previous);daemon.stop(true);
 }
});
