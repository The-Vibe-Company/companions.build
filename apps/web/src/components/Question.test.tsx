import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {Question} from './Question';
afterEach(()=>vi.unstubAllGlobals());
it('keeps the question and chosen answer visible after refresh, without allowing a second answer',async()=>{
 const question={id:'question',question:'Which language?',options:['French','English'],answer:null as string|null,runStatus:'needs_input'};
 const onAnswered=vi.fn(async()=>{});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:true}))));
 const view=render(<Question companionId="specialist" question={question} onAnswered={onAnswered}/>);
 fireEvent.click(screen.getByRole('button',{name:'French'}));
 await waitFor(()=>expect(onAnswered).toHaveBeenCalledOnce());
 view.rerender(<Question companionId="specialist" question={{...question,answer:'French',runStatus:'succeeded'}} onAnswered={onAnswered}/>);
 expect(screen.getByText('Which language?')).toBeInTheDocument();
 expect(screen.getByText('French')).toBeInTheDocument();
 expect(screen.getByRole('region',{name:'Answered question'})).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'French'})).not.toBeInTheDocument();
});

it('keeps free text available alongside suggested answers and submits the custom answer',async()=>{
 const onAnswered=vi.fn(async()=>{});
 const fetch=vi.fn(async()=>new Response(JSON.stringify({ok:true})));
 vi.stubGlobal('fetch',fetch);
 render(<Question companionId="designer" question={{id:'direction',question:'Which direction?',options:['Warm','Minimal'],runStatus:'needs_input'}} onAnswered={onAnswered}/>);
 expect(screen.getByRole('region',{name:'Waiting for your answer'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Warm'})).toBeEnabled();
 fireEvent.change(screen.getByRole('textbox',{name:'Your answer'}),{target:{value:'  Warm, with quieter colors  '}});
 fireEvent.click(screen.getByRole('button',{name:'Reply'}));
 await waitFor(()=>expect(onAnswered).toHaveBeenCalledOnce());
 expect(fetch).toHaveBeenCalledWith('/api/companions/designer/questions/direction/answer',expect.objectContaining({body:JSON.stringify({answer:'Warm, with quieter colors'})}));
});
it('keeps a rejected answer editable and shows the failure without reporting success',async()=>{
 const onAnswered=vi.fn(async()=>{});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:'Please try again.'}),{status:503})));
 render(<Question companionId="designer" question={{id:'brief',question:'What are we making?',options:[]}} onAnswered={onAnswered}/>);
 fireEvent.change(screen.getByRole('textbox',{name:'Your answer'}),{target:{value:'A portfolio'}});
 fireEvent.click(screen.getByRole('button',{name:'Reply'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Please try again.');
 expect(screen.getByRole('textbox',{name:'Your answer'})).toHaveValue('A portfolio');
 expect(screen.getByRole('button',{name:'Reply'})).toBeEnabled();
 expect(onAnswered).not.toHaveBeenCalled();
});
it.each(['cancelled','failed','succeeded'])('retains an unanswered question after the run is %s without asking for an unusable reply',runStatus=>{
 render(<Question companionId="designer" question={{id:'direction',question:'Which direction?',options:['Warm'],runStatus}} onAnswered={vi.fn(async()=>{})}/>);
 expect(screen.getByRole('region',{name:'Closed question'})).toHaveTextContent('Which direction?');
 expect(screen.getByText('This question is no longer waiting for an answer.')).toBeInTheDocument();
 expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
 expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('keeps a question draft when the notification panel is closed and reopened',async()=>{
 const question={id:'draft-question',question:'Which scope?',options:[],answer:null,runStatus:'needs_input'};
 const first=render(<Question companionId="designer" question={question} onAnswered={vi.fn(async()=>{})}/>);
 fireEvent.change(screen.getByRole('textbox',{name:'Your answer'}),{target:{value:'Keep the small scope'}});
 first.unmount();
 render(<Question companionId="designer" question={question} onAnswered={vi.fn(async()=>{})}/>);
 expect(screen.getByRole('textbox',{name:'Your answer'})).toHaveValue('Keep the small scope');
});
