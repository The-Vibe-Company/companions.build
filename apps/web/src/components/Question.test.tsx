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
