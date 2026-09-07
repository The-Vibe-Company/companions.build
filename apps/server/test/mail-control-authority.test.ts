import {beforeAll,test,expect} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {applyControl,controlHandlers} from '../src/control';
import {handler} from '../src/api';
const owner='00000000-0000-4000-8000-000000000001';
beforeAll(()=>migrate());
test('mail webhook routing leaves health and account authentication available',async()=>{
 expect((await handler(new Request('http://localhost/health'))).status).toBe(200);
 expect((await handler(new Request('http://localhost/api/me'))).status).toBe(401);
 expect((await handler(new Request('http://localhost/api/webhooks/resend',{method:'POST',body:'{}'}))).status).not.toBe(200);
});
test('email work cannot borrow owner authority to modify permissions or delegate',async()=>{
 const c=await createCompanion(owner,{name:'Mail authority',provider:'local'});
 const id=await acceptMessage(owner,c.id,crypto.randomUUID(),'Incoming mail');
 await db`UPDATE runs SET source='email',lane='background',status='running',dispatched=true WHERE id=${id}`;
 for(const operation of ['configure','plugin_select','companion_create','routine_save','mail_sender_allow','delegate','history_search'] as const){
  const previous=controlHandlers[operation];let called=false;
  controlHandlers[operation]=async()=>{called=true;return {ok:true};};
  try{
   expect(await applyControl(c.id,{id:crypto.randomUUID(),runId:id,operation,input:{}})).toHaveProperty('error');
   expect(called).toBe(false);
  }finally{controlHandlers[operation]=previous;}
 }
 const identity=await applyControl(c.id,{id:crypto.randomUUID(),runId:id,operation:'identity',input:{}}) as any;
 expect(identity.operations).not.toContain('configure');
 expect(identity.operations).not.toContain('history_search');
});
test('mail handler receives persisted source rather than a caller-selected authority',async()=>{
 const c=await createCompanion(owner,{name:'Mail source',provider:'local'});
 const id=await acceptMessage(owner,c.id,crypto.randomUUID(),'Send my mail');
 await db`UPDATE runs SET status='running',dispatched=true WHERE id=${id}`;
 const previous=controlHandlers.mail_prepare;
 controlHandlers.mail_prepare=async context=>({source:context.source});
 try{
  expect(await applyControl(c.id,{id:crypto.randomUUID(),runId:id,operation:'mail_prepare',input:{source:'email'}})).toEqual({source:'chat'});
 }finally{controlHandlers.mail_prepare=previous;}
});
