import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { api, type CompanionDetail } from '@/api';
import { SettingsSheet } from './SettingsSheet';

const detail: CompanionDetail = {
  companion: { id:'ada',name:'Ada',instructions:'Research customer questions.',provider:'box',status:'ready',error:null,createdAt:'2026-09-06T12:00:00Z',avatar:{shape:1,color:2,face:0} },
  messages:[],runs:[],activity:[],
};
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
  expect(screen.getByLabelText('Purpose')).toHaveValue('Updated by Ada.\n');
  await userEvent.clear(screen.getByLabelText('Name'));
  await userEvent.type(screen.getByLabelText('Name'), 'Mila');
  await userEvent.click(screen.getByRole('button', { name:'Save changes' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('ada', { name:'Mila' }));
  expect(screen.getByLabelText('Purpose')).toHaveValue('Updated by Ada.\n');
});

it('guards the computer action when unsaved identity changes are kept on the settings overview', async () => {
  const {user,onDesktop}=setup();
  await user.type(screen.getByLabelText('Purpose'),' More context.');
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
  expect(document.querySelector('.settings-appearance')).not.toHaveAttribute('open');
  await user.clear(screen.getByLabelText('Name'));
  await user.type(screen.getByLabelText('Name'),'Mila draft');
  await user.click(screen.getByRole('button',{name:'Delete companion'}));
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
 expect(screen.getByRole('button',{name:'Shape 8'})).not.toBeVisible();
 await user.click(screen.getByRole('button',{name:'Change appearance'}));
 expect(document.querySelector('.settings-appearance')).toHaveAttribute('open');
 expect(document.querySelector('.settings-appearance summary')).toHaveFocus();
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
 expect(screen.getByLabelText('Purpose')).toBeDisabled();
 expect(screen.getByLabelText('Model')).toBeDisabled();
 expect(screen.getByRole('button',{name:'Change appearance'})).toBeDisabled();
 finish({companion:{...detail.companion,modelId:'chosen'}});
 await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Changes saved'));
 expect(screen.getByLabelText('Model')).toBeEnabled();
});
