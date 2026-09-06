import {beforeAll,test,expect} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {addCustomPlugin} from '../src/plugins';
import {applyControl} from '../src/control';
import '../src/control-product';
const owner='00000000-0000-4000-8000-000000000001';
beforeAll(()=>migrate());
test('control reports custom checks as requiring the agent and cannot inspect another owner account',async()=>{
 const companion=await createCompanion(owner,{name:'Connection check',provider:'local'});
 const runId=await acceptMessage(owner,companion.id,crypto.randomUUID(),'Check my connection');
 await db`UPDATE runs SET status='running',dispatched=true WHERE id=${runId}`;
 const own=await addCustomPlugin(owner,{label:'Custom',transport:'stdio',command:'never-execute-on-control-plane',args:[]});
 const result=await applyControl(companion.id,{id:crypto.randomUUID(),runId,operation:'plugin_check',input:{accountId:own.id}});
 expect(result.account).toMatchObject({id:own.id,healthStatus:'requires_agent',healthCode:'agent_check_required'});
 const foreign=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${foreign},'Other',${foreign+'@example.com'},true)`;
 const other=await addCustomPlugin(foreign,{label:'Private',transport:'http',url:'https://example.com/mcp'});
 expect(await applyControl(companion.id,{id:crypto.randomUUID(),runId,operation:'plugin_check',input:{accountId:other.id}})).toEqual({account:null});
 expect((await db`SELECT health_checked_at FROM plugin_accounts WHERE id=${other.id}`)[0].health_checked_at).toBeNull();
});
