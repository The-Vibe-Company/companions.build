import {beforeAll,test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentControl} from '../../../packages/control/agent';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {applyControl,registerControl,controlHandlers} from '../src/control';
import {addCustomPlugin,attachPlugin,listPluginAccounts,machinePlugins,disconnectPlugin} from '../src/plugins';
import {encrypt} from '../src/config';
import '../src/control-product';
import '../src/runtime-product';
const owner='00000000-0000-4000-8000-000000000001';
beforeAll(async()=>{await migrate();});
test('control MCP persists a request and returns the controller result without a public callback',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'companions-control-'));const bridge=new AgentControl(dir);
 const factory=await bridge.toolsFactory({runId:crypto.randomUUID()});const tool=factory.tools[0];
 try{
   const pending=tool.execute('test',{operation:'identity',input:{}},new AbortController().signal,undefined,{} as any);
   let command:any;
   for(let i=0;i<20&&!command;i++) {const r=await bridge.handleRequest(new Request('http://agent/control'));command=(await r!.json() as any).requests[0];if(!command)await Bun.sleep(10);}
   expect(command.operation).toBe('identity');
   await bridge.handleRequest(new Request(`http://agent/control/${command.id}/result`,{method:'POST',body:JSON.stringify({name:'Ada'})}));
   const result=await pending;expect(result.content).toEqual([{type:'text',text:'{"name":"Ada"}'}]);
   const r=await bridge.handleRequest(new Request('http://agent/control'));expect((await r!.json() as any).requests).toHaveLength(0);
 }finally{await factory.close();bridge.close();rmSync(dir,{recursive:true,force:true});}
});
test('a repeated control request cannot repeat its effect or target another run',async()=>{
 const c=await createCompanion(owner,{name:'Control',instructions:'',provider:'local'});
 const runId=await acceptMessage(owner,c.id,crypto.randomUUID(),'Configure');
 await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${runId}`;
 const original=controlHandlers.identity;let effects=0;registerControl({identity:async()=>({counter:++effects})});
 const command={id:crypto.randomUUID(),runId,operation:'identity',input:{}};
 expect(await applyControl(c.id,command)).toEqual({counter:1});
 expect(await applyControl(c.id,command)).toEqual({counter:1});expect(effects).toBe(1);
 const [persisted]=await db`SELECT result,result_secret FROM control_commands WHERE id=${command.id}`;
 expect(persisted.result).toBeNull();expect(persisted.result_secret).not.toContain('counter');
 expect(await applyControl(crypto.randomUUID(),command)).toHaveProperty('error');expect(effects).toBe(1);
 await db`UPDATE runs SET status='succeeded' WHERE id=${runId}`;controlHandlers.identity=original;
});
test('plugin secrets are write-only and attaching another owner account is refused',async()=>{
 const other=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${other},'Other',${other+'@example.com'},true)`;
 const c=await createCompanion(owner,{name:'Plugins',instructions:'',provider:'local'});
 const account=await addCustomPlugin(owner,{label:'Private',transport:'http',url:'https://example.com/mcp',headers:{Authorization:'Bearer synthetic-plugin-secret'}});
 const foreign=await addCustomPlugin(other,{label:'Other',transport:'http',url:'https://example.com/mcp'});
 await expect(attachPlugin(owner,c.id,foreign.id,true)).rejects.toThrow('not found');
 await attachPlugin(owner,c.id,account.id,true);
 expect(JSON.stringify(await listPluginAccounts(owner))).not.toContain('synthetic-plugin-secret');
 expect((await machinePlugins(c.id))[0].headers?.Authorization).toBe('Bearer synthetic-plugin-secret');
 await disconnectPlugin(owner,account.id);expect(await machinePlugins(c.id)).toHaveLength(0);
});
test('companion_create uses the durable control command as its creation identity',async()=>{
 const commandId=crypto.randomUUID(),context={ownerId:owner,companionId:crypto.randomUUID(),runId:crypto.randomUUID(),commandId,isChild:false};
 const first=await controlHandlers.companion_create!(context,{name:'Created by control',instructions:'Stable'} as any) as any;
 const retried=await controlHandlers.companion_create!(context,{name:'Created by control',instructions:'Stable'} as any) as any;
 expect(retried.id).toBe(first.id);
 await expect(controlHandlers.companion_create!(context,{name:'Changed control intent'} as any)).rejects.toBeInstanceOf(Error);
 expect(await db`SELECT id FROM companions WHERE owner_id=${owner} AND client_creation_id=${commandId}`).toHaveLength(1);
});


test('control returns actionable lifecycle errors and correlation IDs without leaking unexpected payloads',async()=>{
 const c=await createCompanion(owner,{name:'Error control',provider:'local'});
 const runId=await acceptMessage(owner,c.id,crypto.randomUUID(),'Configure the companion');
 await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${runId}`;
 const command={id:crypto.randomUUID(),runId,operation:'desktop_release',input:{}};
 await db`UPDATE companions SET desktop_taken=true WHERE id=${c.id}`;
 const rejected=await applyControl(c.id,command);
 expect(rejected).toEqual({error:'HUMAN_DESKTOP_RELEASE_REQUIRED',code:'lifecycle_conflict',commandId:command.id});
 expect(await applyControl(c.id,command)).toEqual(rejected);
 const original=controlHandlers.identity;
 try{
  registerControl({identity:async()=>{throw Error('synthetic-sensitive-provider-payload');}});
  const id=crypto.randomUUID();
  const result=await applyControl(c.id,{id,runId,operation:'identity',input:{}});
  expect(result).toMatchObject({code:'operation_failed',commandId:id});
  expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-provider-payload');
 }finally{controlHandlers.identity=original;}
});

test('legacy runtimes receive a durable direct acknowledgement without a new approval question',async()=>{
 const c=await createCompanion(owner,{name:'Legacy MCP',provider:'local'});
 const runId=(await acceptMessage(owner,c.id,crypto.randomUUID(),'Create workspace'))!;
 await db`UPDATE runs SET status='running' WHERE id=${runId}`;
 const command={id:crypto.randomUUID(),runId,operation:'app_tool_confirm',input:{connectionId:crypto.randomUUID(),tool:'create_workspace',arguments:{}}};
 expect(await applyControl(c.id,command)).toEqual({answer:'Approve this call'});
 expect(await applyControl(c.id,command)).toEqual({answer:'Approve this call'});
 expect(await db`SELECT id FROM task_questions WHERE run_id=${runId}`).toHaveLength(0);
 expect((await db`SELECT status FROM control_commands WHERE id=${command.id}`)[0].status).toBe('done');
 const identity=await controlHandlers.identity!({ownerId:owner,companionId:c.id,runId,commandId:crypto.randomUUID(),isChild:false},{}) as any;
 expect(identity.operations).not.toContain('app_tool_confirm');
 await db`UPDATE runs SET cancel_requested=true WHERE id=${runId}`;
 expect(await applyControl(c.id,{...command,id:crypto.randomUUID()})).toHaveProperty('error');
});

test('legacy parked approvals resolve in place while explicit answers and ordinary questions remain intact',async()=>{
 const c=await createCompanion(owner,{name:'Parked MCP',provider:'local'});
 const runId=await acceptMessage(owner,c.id,crypto.randomUUID(),'Operate project');
 await db`UPDATE runs SET status='needs_input' WHERE id=${runId}`;
 for(const scenario of [
  {operation:'app_tool_confirm',answer:null,expected:'Approve this call'},
  {operation:'app_tool_confirm',answer:'Decline',expected:'Decline'},
  {operation:'ask_user',answer:null,expected:null},
 ]){
  const id=crypto.randomUUID(),result={pendingQuestionId:id};
  await db`INSERT INTO control_commands(id,companion_id,run_id,operation,status,result_secret) VALUES(${id},${c.id},${runId},${scenario.operation},'done',${encrypt(JSON.stringify(result))})`;
  await db`INSERT INTO task_questions(id,companion_id,run_id,question,options,answer) VALUES(${id},${c.id},${runId},'Legacy question',${[]},${scenario.answer})`;
  const command={id,runId,operation:scenario.operation,input:{}};
  expect(await applyControl(c.id,command)).toEqual(result);
  expect(await applyControl(c.id,command)).toEqual(result);
  expect((await db`SELECT answer FROM task_questions WHERE id=${id}`)[0].answer).toBe(scenario.expected);
 }
 expect(await db`SELECT id FROM task_questions WHERE run_id=${runId}`).toHaveLength(3);
});

test('legacy requests with unknown or rejected outcomes are never automatically approved',async()=>{
 const c=await createCompanion(owner,{name:'Ambiguous MCP',provider:'local'});
 const runId=await acceptMessage(owner,c.id,crypto.randomUUID(),'Operate project');
 await db`UPDATE runs SET status='running' WHERE id=${runId}`;
 for(const result of [null,{error:'Previously rejected'}]){
  const command={id:crypto.randomUUID(),runId,operation:'app_tool_confirm',input:{}};
  await db`INSERT INTO control_commands(id,companion_id,run_id,operation,result_secret) VALUES(${command.id},${c.id},${runId},${command.operation},${result?encrypt(JSON.stringify(result)):null})`;
  expect(await applyControl(c.id,command)).toHaveProperty('error');
 }
 expect(await db`SELECT id FROM task_questions WHERE run_id=${runId}`).toHaveLength(0);
});
