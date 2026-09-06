import {beforeAll,expect,test} from 'bun:test';
import {acceptMessage,createCompanion,db,migrate} from '../src/store';
import {controlHandlers,type ControlContext} from '../src/control';

const owner='00000000-0000-4000-8000-000000000001';
beforeAll(()=>migrate());
test('history search returns bounded matching past work without exposing other companions or staged instructions',async()=>{
 const a=await createCompanion(owner,{name:'History A',instructions:'',provider:'local'});
 const b=await createCompanion(owner,{name:'History B',instructions:'',provider:'local'});
 const old=(await acceptMessage(owner,a.id,crypto.randomUUID(),'Choose the launch color'))!;
 await db`UPDATE runs SET status='succeeded',result_text=${'The launch color is vermilion. '+ 'Unrelated context. '.repeat(2000)} WHERE id=${old}`;
 const other=(await acceptMessage(owner,b.id,crypto.randomUUID(),'vermilion private-other-companion'))!;
 await db`UPDATE runs SET status='succeeded' WHERE id=${other}`;
 const active=(await acceptMessage(owner,a.id,crypto.randomUUID(),'Find vermilion'))!;
 const context:ControlContext={ownerId:owner,companionId:a.id,runId:active,commandId:crypto.randomUUID(),isChild:false};
 const result=await controlHandlers.history_search!(context,{query:'vermilion',limit:1}) as any;
 expect(result.matches).toHaveLength(1);
 expect(result.matches[0].runId).toBe(old);
 expect(result.matches[0].excerpt).toContain('vermilion');
 expect(result.matches[0].excerpt.length).toBeLessThan(1000);
 expect(JSON.stringify(result)).not.toContain('private-other-companion');
 expect(await controlHandlers.history_search!({...context,ownerId:crypto.randomUUID()},{query:'vermilion'})).toEqual({matches:[]});
 expect(await controlHandlers.history_search!(context,{query:'notfoundquartz'})).toEqual({matches:[]});
 await expect(controlHandlers.history_search!(context,{query:'vermilion',limit:100})).rejects.toThrow();
});
