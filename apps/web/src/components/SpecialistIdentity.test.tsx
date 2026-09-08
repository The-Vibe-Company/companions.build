import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {SpecialistIdentity} from './SpecialistIdentity';
afterEach(()=>vi.unstubAllGlobals());
it('saves a name and avatar without requiring an agent profile card',async()=>{
 const draft={templateId:'template',companionId:'companion',generation:4,name:'Developer',instructions:'Review code',initScript:'',status:'editing' as const,avatar:{shape:0,color:0,face:0},lastTest:null,publication:null};
 const saved=vi.fn(),closed=vi.fn();
 const fetcher=vi.fn(async(_url:unknown,options?:RequestInit)=>new Response(JSON.stringify({draft:{...draft,...JSON.parse(String(options?.body)),generation:4}})));
 vi.stubGlobal('fetch',fetcher);
 render(<SpecialistIdentity draft={draft} onSaved={saved} onClose={closed}/>);
 fireEvent.change(screen.getByRole('textbox',{name:'Name'}),{target:{value:'Robin'}});
 fireEvent.click(screen.getByRole('button',{name:'Color 6'}));
 fireEvent.click(screen.getByRole('button',{name:'Save profile'}));
 await waitFor(()=>expect(saved).toHaveBeenCalledWith(expect.objectContaining({name:'Robin',avatar:{shape:0,color:5,face:0}})));
 expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({expectedGeneration:4,expectedIdentityRevision:1,name:'Robin',avatar:{shape:0,color:5,face:0}});
 expect(closed).toHaveBeenCalledOnce();
});
