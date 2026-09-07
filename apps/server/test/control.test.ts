import {beforeAll,test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentControl} from '../../../packages/control/agent';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {applyControl,registerControl,controlHandlers} from '../src/control';
import {addCustomPlugin,attachPlugin,listPluginAccounts,machinePlugins,disconnectPlugin} from '../src/plugins';
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
