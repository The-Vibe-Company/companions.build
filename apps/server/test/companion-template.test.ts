import {beforeAll,test,expect} from 'bun:test';
import {db,migrate,createCompanion,detail,Conflict} from '../src/store';
import {saveTemplate,recordTemplateRevision} from '../src/templates';
const owner='00000000-0000-4000-8000-000000000001';
beforeAll(()=>migrate());
test('permanent Companions pin the chosen revision with independent identity and empty history',async()=>{
 const template=await saveTemplate(owner,{name:'Coder',instructions:'Review carefully',avatar:{shape:2,color:3,face:1}});
 await db.begin(async tx=>{
  await tx`UPDATE agent_templates SET revision=revision+1,model_id='glm-template-fixture',snapshot_name='synthetic-prepared-template',instructions='Prepared coder' WHERE id=${template.id}`;
  await recordTemplateRevision(tx,template.id);
 });
 const first=await createCompanion(owner,{name:'First',provider:'box',templateId:template.id,prepare:true});
 const second=await createCompanion(owner,{name:'Second',provider:'box',templateId:template.id,templateRevision:2});
 expect(first.modelId).toBe('glm-template-fixture');expect(first.templateRevision).toBe(2);expect(first.instructions).toBe('Prepared coder');
 expect(first.avatar).toEqual({shape:2,color:3,face:1});expect(first.temporary).toBe(false);expect(first.parentId).toBeNull();
 const rows=await db`SELECT create_key,agent_secret,box_id,snapshot_name FROM companions WHERE id IN (${first.id},${second.id})`;
 expect(new Set(rows.map((r:any)=>r.create_key)).size).toBe(2);expect(new Set(rows.map((r:any)=>r.agent_secret)).size).toBe(2);
 expect(rows.every((r:any)=>r.box_id===null&&r.snapshot_name==='synthetic-prepared-template')).toBe(true);
 expect((await detail(owner,first.id))?.messages).toHaveLength(0);
 await saveTemplate(owner,{id:template.id,expectedRevision:2,name:'Changed',instructions:'Different'});
 expect((await detail(owner,first.id))?.companion.instructions).toBe('Prepared coder');
 const old=await createCompanion(owner,{name:'Older',provider:'local',templateId:template.id,templateRevision:1});
 expect(old.templateRevision).toBe(1);expect(old.instructions).toBe('Review carefully');
 const customized=await createCompanion(owner,{name:'Custom',provider:'box',templateId:template.id,templateRevision:2,instructions:'My role',avatar:{shape:0,color:0,face:0}});
 expect(customized.instructions).toBe('My role');expect(customized.avatar).toEqual({shape:0,color:0,face:0});
});
test('creation rejects foreign or missing templates and incompatible local snapshots without creating rows',async()=>{
 const foreign=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${foreign},'Other',${foreign+'@example.com'},true)`;
 const template=await saveTemplate(foreign,{name:'Private',instructions:'Private'});
 const [{count:before}]=await db`SELECT count(*)::int AS count FROM companions`;
 await expect(createCompanion(owner,{name:'Forbidden',provider:'box',templateId:template.id})).rejects.toBeInstanceOf(Conflict);
 await expect(createCompanion(owner,{name:'Missing',provider:'box',templateId:crypto.randomUUID()})).rejects.toBeInstanceOf(Conflict);
 await expect(createCompanion(owner,{name:'No template',provider:'box',templateRevision:2})).rejects.toBeInstanceOf(Conflict);
 const own=await saveTemplate(owner,{name:'Prepared'});
 await db.begin(async tx=>{await tx`UPDATE agent_templates SET revision=2,snapshot_name='synthetic-snapshot' WHERE id=${own.id}`;await recordTemplateRevision(tx,own.id);});
 await expect(createCompanion(owner,{name:'Wrong runtime',provider:'local',templateId:own.id})).rejects.toBeInstanceOf(Conflict);
 await expect(createCompanion(owner,{name:'Missing revision',provider:'box',templateId:own.id,templateRevision:99})).rejects.toBeInstanceOf(Conflict);
 const [{count:after}]=await db`SELECT count(*)::int AS count FROM companions`;expect(after).toBe(before);
});
