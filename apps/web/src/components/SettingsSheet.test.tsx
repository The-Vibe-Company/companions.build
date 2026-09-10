import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { api, workspaceApi, type CompanionDetail } from '@/api';
import { SettingsSheet } from './SettingsSheet';

const detail: CompanionDetail = {
  companion: { id:'ada',name:'Ada',instructions:'Research customer questions.',provider:'box',status:'ready',error:null,createdAt:'2026-09-06T12:00:00Z',avatar:{shape:1,color:2,face:0} },
  messages:[],runs:[],activity:[],
};
beforeEach(() => vi.spyOn(workspaceApi, 'templates').mockResolvedValue({ templates: [] }));
function setup() {
  const callbacks = { onClose:vi.fn(),onDeleted:vi.fn(),onSaved:vi.fn().mockResolvedValue(undefined),onActivity:vi.fn(),onDesktop:vi.fn() };
  render(<SettingsSheet detail={detail} initialPage="identity" models={[]} connections={<p>Applications</p>} {...callbacks}/>);
  return { user:userEvent.setup(),...callbacks };
}

it('keeps the edited identity across close and Escape, discarding only explicitly', async () => {
  const {user,onClose}=setup();
  await user.clear(screen.getByLabelText('Name'));
  await user.type(screen.getByLabelText('Name'),'Mila');
  await user.click(screen.getByRole('button',{name:'Close settings'}));
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog',{name:'Keep your changes?'})).toBeInTheDocument();
  fireEvent(screen.getByRole('dialog'),new Event('cancel',{bubbles:true,cancelable:true}));
  expect(screen.getByLabelText('Name')).toHaveValue('Mila');
  await user.click(screen.getByRole('button',{name:'Close settings'}));
  await user.click(screen.getByRole('button',{name:'Discard changes'}));
  expect(onClose).toHaveBeenCalledOnce();
});

it('retains a failed save and clears the unsaved guard only after successful persistence', async () => {
  const save=vi.spyOn(api,'updateCompanion').mockRejectedValueOnce(new Error('Could not save.')).mockResolvedValue({companion:detail.companion});
  const {user,onClose}=setup();
  await user.clear(screen.getByLabelText('Name'));
  await user.type(screen.getByLabelText('Name'),'Mila');
  await user.click(screen.getByRole('button',{name:'Save changes'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save.');
  expect(screen.getByLabelText('Name')).toHaveValue('Mila');
  await user.click(screen.getByRole('button',{name:'Close settings'}));
  await user.click(screen.getByRole('button',{name:'Keep editing'}));
  await user.click(screen.getByRole('button',{name:'Save changes'}));
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Changes saved'));
  expect(save).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button',{name:'Save changes'})).toBeDisabled();
  await user.click(screen.getByRole('button',{name:'Close settings'}));
  expect(onClose).toHaveBeenCalledOnce();
});

it('patches only edited fields and adopts external changes to untouched fields', async () => {
  const external = { ...detail, companion: { ...detail.companion, instructions: 'Updated by Ada.\n' } };
  const save = vi.spyOn(api, 'updateCompanion').mockResolvedValue({ companion: { ...external.companion, name: 'Mila' } });
  const props = { embedded:true, models:[], connections:null, onDeleted:vi.fn(), onClose:vi.fn(), onSaved:vi.fn().mockResolvedValue(undefined), onActivity:vi.fn(), onDesktop:vi.fn() };
  const view = render(<SettingsSheet detail={detail} {...props}/>);
  view.rerender(<SettingsSheet detail={external} {...props}/>);
  expect(screen.getByLabelText('Role')).toHaveValue('Updated by Ada.\n');
  await userEvent.clear(screen.getByLabelText('Name'));
  await userEvent.type(screen.getByLabelText('Name'), 'Mila');
  await userEvent.click(screen.getByRole('button', { name:'Save changes' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('ada', { name:'Mila' }));
  expect(screen.getByLabelText('Role')).toHaveValue('Updated by Ada.\n');
});

it('guards the computer action when unsaved identity changes are kept on the settings overview', async () => {
  const {user,onDesktop}=setup();
  await user.type(screen.getByLabelText('Role'),' More context.');
  await user.click(screen.getByRole('button',{name:'Back to settings'}));
  expect(screen.getByText('Personality changes not saved')).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Open computer'}));
  expect(onDesktop).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Discard changes'}));
  expect(onDesktop).toHaveBeenCalledOnce();
});


it('requires explicit deletion, keeps failure visible, and retries the same companion', async () => {
  const remove=vi.spyOn(api,'deleteCompanion').mockRejectedValueOnce(new Error('Could not delete.')).mockResolvedValue({deleted:true,companionIds:['ada','child']});
  const {user,onDeleted}=setup();
  await user.click(screen.getByRole('button',{name:'Back to settings'}));
  await user.click(screen.getByRole('button',{name:'Delete companion'}));
  expect(screen.getByRole('button',{name:'Keep companion'})).toHaveFocus();
  expect(remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Keep companion'}));
  expect(remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Delete companion'}));
  await user.click(screen.getByRole('button',{name:'Delete companion'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete.');
  expect(onDeleted).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Delete companion'}));
  await waitFor(()=>expect(onDeleted).toHaveBeenCalledWith(['ada','child']));
  expect(remove).toHaveBeenNthCalledWith(1,'ada');
  expect(remove).toHaveBeenNthCalledWith(2,'ada');
});

it('prevents duplicate deletion and closing while the request is pending', async () => {
  let finish!: (value: {deleted:true;companionIds:string[]}) => void;
  const remove=vi.spyOn(api,'deleteCompanion').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const {user,onDeleted,onClose}=setup();
  await user.click(screen.getByRole('button',{name:'Back to settings'}));
  await user.click(screen.getByRole('button',{name:'Delete companion'}));
  await user.click(screen.getByRole('button',{name:'Delete companion'}));
  expect(screen.getByRole('button',{name:'Deleting…'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Close settings'})).toBeDisabled();
  fireEvent(screen.getByRole('dialog'),new Event('cancel',{bubbles:true,cancelable:true}));
  expect(onClose).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledOnce();
  finish({deleted:true,companionIds:['ada']});
  await waitFor(()=>expect(onDeleted).toHaveBeenCalledWith(['ada']));
});


it('renders applications in one settings page and preserves drafts across delete confirmation', async () => {
  const user=userEvent.setup();
  render(<SettingsSheet embedded detail={detail} models={[]} connections={<p>Choose connected apps</p>} onDeleted={vi.fn()} onClose={vi.fn()} onSaved={vi.fn()} onActivity={vi.fn()} onDesktop={vi.fn()}/>);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('navigation',{name:'Settings sections'})).not.toBeInTheDocument();
  expect(screen.getByRole('region', {name:'Applications'})).toHaveTextContent('Choose connected apps');
  expect(document.querySelector('.settings-appearance')).not.toBeInTheDocument();
  expect(screen.getByRole('heading',{name:'Share with a client'})).toBeInTheDocument();
  expect(screen.getByPlaceholderText('client@company.com')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Deliver'})).toBeDisabled();
  expect(screen.getByLabelText('Offer maintenance access (revocable, audited)')).toBeInTheDocument();
  expect(screen.queryByText('Prepare delivery')).not.toBeInTheDocument();
  expect(screen.getByText('Delete Ada')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Delete…'})).toBeInTheDocument();
  await user.clear(screen.getByLabelText('Name'));
  await user.type(screen.getByLabelText('Name'),'Mila draft');
  await user.click(screen.getByRole('button',{name:'Delete…'}));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Keep companion'}));
  expect(screen.getByLabelText('Name')).toHaveValue('Mila draft');
});

it('unmounts computer controls when the settings page is inactive', async () => {
  const props={embedded:true,initialPage:'computer' as const,detail,models:[],connections:null,computer:<p>Computer controls</p>,onDeleted:vi.fn(),onClose:vi.fn(),onSaved:vi.fn(),onActivity:vi.fn(),onDesktop:vi.fn()};
  const view=render(<SettingsSheet {...props}/>);
  expect(screen.getByText('Computer controls')).toBeInTheDocument();
  view.rerender(<SettingsSheet {...props} active={false}/>);
  expect(screen.queryByText('Computer controls')).not.toBeInTheDocument();
});

it('keeps appearance progressive and saves only the selected appearance values',async()=>{
 const avatar={shape:7,color:10,face:4};
 const save=vi.spyOn(api,'updateCompanion').mockResolvedValue({companion:{...detail.companion,avatar}});
 render(<SettingsSheet embedded detail={detail} models={[]} connections={null} onDeleted={vi.fn()} onClose={vi.fn()} onSaved={vi.fn().mockResolvedValue(undefined)} onActivity={vi.fn()} onDesktop={vi.fn()}/>);
 const user=userEvent.setup();
 expect(screen.queryByRole('button',{name:'Shape 8'})).not.toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'Change appearance'}));
 expect(document.querySelector('.settings-appearance')).toBeInTheDocument();
 expect(screen.queryByText('Appearance')).not.toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'Shape 8'}));
 await user.click(screen.getByRole('button',{name:'Color 11'}));
 await user.click(screen.getByRole('button',{name:'Face 5'}));
 await user.click(screen.getByRole('button',{name:'Save changes'}));
 await waitFor(()=>expect(save).toHaveBeenCalledWith('ada',{avatar}));
});

it('saves the visible model preference with the identity form and disables editing while saving',async()=>{
 let finish!: (value:{companion:CompanionDetail['companion']})=>void;
 const save=vi.spyOn(api,'updateCompanion').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 render(<SettingsSheet embedded detail={detail} models={[{id:'chosen',name:'Chosen model'}]} connections={null} onDeleted={vi.fn()} onClose={vi.fn()} onSaved={vi.fn().mockResolvedValue(undefined)} onActivity={vi.fn()} onDesktop={vi.fn()}/>);
 const user=userEvent.setup();
 expect(screen.getByRole('button',{name:'Save changes'})).toBeDisabled();
 await user.selectOptions(screen.getByLabelText('Model'),'chosen');
 await user.click(screen.getByRole('button',{name:'Save changes'}));
 expect(save).toHaveBeenCalledWith('ada',{modelId:'chosen'});
 expect(screen.getByLabelText('Name')).toBeDisabled();
 expect(screen.getByLabelText('Role')).toBeDisabled();
 expect(screen.getByLabelText('Model')).toBeDisabled();
 expect(screen.getByRole('button',{name:'Change appearance'})).toBeDisabled();
 finish({companion:{...detail.companion,modelId:'chosen'}});
 await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Changes saved'));
 expect(screen.getByLabelText('Model')).toBeEnabled();
});

const productModels = [
 {id:'gpt-5.6-luna',name:'Great',isDefault:true},
 {id:'deepseek-flash',name:'Fast'},
];

it.each([null, 'gpt-5.6-luna'])('shows the Great default once for a %s persisted model', modelId => {
 const productDetail = {...detail, companion:{...detail.companion,modelId}};
 render(<SettingsSheet embedded detail={productDetail} models={productModels} connections={null} onDeleted={vi.fn()} onClose={vi.fn()} onSaved={vi.fn().mockResolvedValue(undefined)} onActivity={vi.fn()} onDesktop={vi.fn()}/>);
 const model = screen.getByLabelText('Model');
 expect(model).toHaveValue('gpt-5.6-luna');
 expect(screen.getAllByRole('option')).toHaveLength(2);
 expect(screen.getByRole('option',{name:'Great (default)'})).toBeInTheDocument();
 expect(screen.getByRole('option',{name:'Fast'})).toBeInTheDocument();
 expect(screen.queryByRole('option',{name:'Default model'})).not.toBeInTheDocument();
 expect(model).not.toHaveTextContent('gpt-5.6-luna');
 expect(model).not.toHaveTextContent('deepseek-flash');
});

it('retains an explicitly saved Great model when another setting changes', async () => {
 const explicitGreat = {...detail, companion:{...detail.companion,modelId:'gpt-5.6-luna'}};
 const save = vi.spyOn(api,'updateCompanion').mockResolvedValue({companion:{...explicitGreat.companion,name:'Mila'}});
 render(<SettingsSheet embedded detail={explicitGreat} models={productModels} connections={null} onDeleted={vi.fn()} onClose={vi.fn()} onSaved={vi.fn().mockResolvedValue(undefined)} onActivity={vi.fn()} onDesktop={vi.fn()}/>);
 const user = userEvent.setup();
 await user.clear(screen.getByLabelText('Name'));
 await user.type(screen.getByLabelText('Name'),'Mila');
 await user.click(screen.getByRole('button',{name:'Save changes'}));
 await waitFor(() => expect(save).toHaveBeenCalledWith('ada',{name:'Mila'}));
 expect(screen.getByLabelText('Model')).toHaveValue('gpt-5.6-luna');
});

it('persists Fast, retains it after an error, and maps Great back to the default', async () => {
 const save = vi.spyOn(api,'updateCompanion')
  .mockRejectedValueOnce(new Error('Could not save model.'))
  .mockResolvedValueOnce({companion:{...detail.companion,modelId:'deepseek-flash'}})
  .mockResolvedValueOnce({companion:{...detail.companion,modelId:null}});
 render(<SettingsSheet embedded detail={detail} models={productModels} connections={null} onDeleted={vi.fn()} onClose={vi.fn()} onSaved={vi.fn().mockResolvedValue(undefined)} onActivity={vi.fn()} onDesktop={vi.fn()}/>);
 const user = userEvent.setup();
 const model = screen.getByLabelText('Model');
 await user.selectOptions(model,'deepseek-flash');
 await user.click(screen.getByRole('button',{name:'Save changes'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Could not save model.');
 expect(model).toHaveValue('deepseek-flash');
 expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
 await user.click(screen.getByRole('button',{name:'Save changes'}));
 await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Changes saved'));
 expect(save).toHaveBeenNthCalledWith(1,'ada',{modelId:'deepseek-flash'});
 expect(save).toHaveBeenNthCalledWith(2,'ada',{modelId:'deepseek-flash'});
 await user.selectOptions(model,'gpt-5.6-luna');
 await user.click(screen.getByRole('button',{name:'Save changes'}));
 await waitFor(() => expect(save).toHaveBeenNthCalledWith(3,'ada',{modelId:null}));
 expect(model).toHaveValue('gpt-5.6-luna');
 expect(screen.getByRole('button',{name:'Save changes'})).toBeDisabled();
});

it('shows unavailable persisted Fast and preserves it until the user chooses Great', async () => {
 const fast = {...detail,companion:{...detail.companion,modelId:'deepseek-flash'}};
 const save = vi.spyOn(api,'updateCompanion')
  .mockResolvedValueOnce({companion:{...fast.companion,name:'Mila'}})
  .mockResolvedValueOnce({companion:{...fast.companion,name:'Mila',modelId:null}});
 render(<SettingsSheet embedded detail={fast} models={[productModels[0]]} connections={null} onDeleted={vi.fn()} onClose={vi.fn()} onSaved={vi.fn().mockResolvedValue(undefined)} onActivity={vi.fn()} onDesktop={vi.fn()}/>);
 const user = userEvent.setup();
 const model = screen.getByLabelText('Model');
 expect(model).toHaveValue('deepseek-flash');
 expect(screen.getByRole('option',{name:'Fast (unavailable)'})).toBeDisabled();
 await user.clear(screen.getByLabelText('Name'));
 await user.type(screen.getByLabelText('Name'),'Mila');
 await user.click(screen.getByRole('button',{name:'Save changes'}));
 await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Changes saved'));
 expect(save).toHaveBeenNthCalledWith(1,'ada',{name:'Mila'});
 expect(model).toHaveValue('deepseek-flash');
 await user.selectOptions(model,'gpt-5.6-luna');
 await user.click(screen.getByRole('button',{name:'Save changes'}));
 await waitFor(() => expect(save).toHaveBeenNthCalledWith(2,'ada',{modelId:null}));
 expect(model).toHaveValue('gpt-5.6-luna');
 expect(screen.queryByRole('option',{name:'Fast (unavailable)'})).not.toBeInTheDocument();
});
