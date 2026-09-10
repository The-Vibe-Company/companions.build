import {beforeAll,test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentControl} from '../../../packages/control/agent';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {applyControl,registerControl,controlHandlers} from '../src/control';
import {addCustomPlugin,attachPlugin,listPluginAccounts,machinePlugins,disconnectPlugin} from '../src/plugins';
import {saveTemplate} from '../src/templates';
import {openSpecialistDraft,readSpecialistDraft} from '../src/specialist-drafts';
import {handleAutomations} from '../src/automation-routes';
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
test('plugin_select changes the specialist generation so an earlier test cannot validate new connections',async()=>{
 const profile=await saveTemplate(owner,{name:'Connected draft'});
 const {draft}=await openSpecialistDraft(owner,profile.id,{commandId:crypto.randomUUID()});
 const account=await addCustomPlugin(owner,{label:'Draft account',transport:'http',url:'https://example.com/mcp'});
 const runId=crypto.randomUUID();
 await db`INSERT INTO runs(id,companion_id,client_message_id,content,status,dispatched,started_at) VALUES(${runId},${draft.companionId},${crypto.randomUUID()},'Configure connections','running',true,now())`;
 await applyControl(draft.companionId,{id:crypto.randomUUID(),runId,operation:'plugin_select',input:{accountId:account.id,enabled:true}});
 expect((await readSpecialistDraft(owner,profile.id)).draft.generation).toBe(draft.generation+1);
});
test('companion_create uses the durable control command as its creation identity',async()=>{
 const commandId=crypto.randomUUID(),context={ownerId:owner,companionId:crypto.randomUUID(),runId:crypto.randomUUID(),commandId,isChild:false};
 const first=await controlHandlers.companion_create!(context,{name:'Created by control',instructions:'Stable'} as any) as any;
 const retried=await controlHandlers.companion_create!(context,{name:'Created by control',instructions:'Stable'} as any) as any;
 expect(retried.id).toBe(first.id);
 await expect(controlHandlers.companion_create!(context,{name:'Changed control intent'} as any)).rejects.toBeInstanceOf(Error);
 expect(await db`SELECT id FROM companions WHERE owner_id=${owner} AND client_creation_id=${commandId}`).toHaveLength(1);
});


test('agent control configures and tests a routine without enabling it, then rejects its deleted identity', async () => {
 const companion=await createCompanion(owner,{name:'Routine control',instructions:'',provider:'local'});
 const runId=await acceptMessage(owner,companion.id,crypto.randomUUID(),'Configure my routine');
 await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${runId}`;
 const invoke=(operation:string,input:unknown,id=crypto.randomUUID())=>applyControl(companion.id,{id,runId,operation,input});
 const routine=await invoke('routine_save',{name:'Daily check',prompt:'Check the repository',cron:'0 9 * * *',timezone:'Europe/Paris',enabled:false}) as any;
 expect(routine.id).toBeString();
 const edited=await invoke('routine_save',{id:routine.id,prompt:'Review the repository'}) as any;
 expect(edited).toMatchObject({prompt:'Review the repository',enabled:false,nextFireAt:null});
 const commandId=crypto.randomUUID();
 const tested=await invoke('routine_test',{id:routine.id},commandId) as any;
 expect(tested.runId).toBeString();
 expect(await invoke('routine_test',{id:routine.id},commandId)).toEqual(tested);
 expect((await db`SELECT content,lane,source,status FROM runs WHERE id=${tested.runId}`)[0]).toMatchObject({content:'Review the repository',lane:'background',source:'routine',status:'queued'});
 expect(await invoke('routine_delete',{id:routine.id})).toEqual({deleted:true});
 expect(await invoke('routine_test',{id:routine.id})).toEqual({error:'Routine not found.'});
 expect(await db`SELECT id FROM runs WHERE companion_id=${companion.id} AND source='routine'`).toHaveLength(1);
});


test('control returns actionable lifecycle errors and correlation IDs without leaking unexpected payloads',async()=>{
 const c=await createCompanion(owner,{name:'Error control',provider:'local'});
 const runId=await acceptMessage(owner,c.id,crypto.randomUUID(),'Spawn a specialist');
 await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${runId}`;
 const command={id:crypto.randomUUID(),runId,operation:'spawn',input:{templateId:crypto.randomUUID(),prompt:'Hello'}};
 const rejected=await applyControl(c.id,command);
 expect(rejected).toEqual({error:'Template is not authorized or has not been published.',code:'template_not_authorized',commandId:command.id});
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

test('ask_user persists a question once and only its owner can answer',async()=>{
 const c=await createCompanion(owner,{name:'Question',instructions:'',provider:'local'});
 const runId=await acceptMessage(owner,c.id,crypto.randomUUID(),'Inspect project');
 await db`UPDATE runs SET status='running' WHERE id=${runId}`;
 const input={question:'Which project?',options:['Project A','Project B']};
 const command={id:crypto.randomUUID(),runId,operation:'ask_user',input};
 expect(await applyControl(c.id,command)).toEqual({pendingQuestionId:command.id});
 expect(await applyControl(c.id,command)).toEqual({pendingQuestionId:command.id});
 const questions=await db`SELECT question,options,answer FROM task_questions WHERE id=${command.id}`;
 expect(questions).toEqual([{...input,answer:null}]);
 const answer=()=>new Request(`http://local/api/companions/${c.id}/questions/${command.id}/answer`,{method:'POST',body:JSON.stringify({answer:'Project A'})});
 expect((await handleAutomations(answer(),crypto.randomUUID()))?.status).toBe(404);
 expect((await db`SELECT answer FROM task_questions WHERE id=${command.id}`)[0].answer).toBeNull();
 expect((await handleAutomations(answer(),owner))?.status).toBe(200);
 expect((await db`SELECT answer FROM task_questions WHERE id=${command.id}`)[0].answer).toBe('Project A');
});
