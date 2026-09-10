import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '@/api';
import { MemoryPanel } from './MemoryPanel';
vi.mock('@/api',async importOriginal=>({...await importOriginal<typeof import('@/api')>(),api:{getMemory:vi.fn(),adoptLegacyMemory:vi.fn(),changeMemory:vi.fn(),memoryCommand:vi.fn()}}));
const record={id:'memory-1',version:2,content:'Use concise answers',status:'active',approval:'pending',scope:'global',kind:'preference',source:{type:'run',ref:'run-1'},provenance:'User requested concise replies',assertedAt:'2026-09-10T00:00:00Z',supersedes:[],supersededBy:[]};
beforeEach(()=>vi.resetAllMocks());
it('loads on explicit inspection and shows provenance and proposals',async()=>{
  vi.mocked(api.getMemory).mockResolvedValue({status:'ok',memories:[record] as any});
  render(<MemoryPanel companionId="c1"/>);expect(api.getMemory).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button',{name:'Inspect memory'}));
  expect(await screen.findByText('Proposed')).toBeInTheDocument();expect(screen.getByText('run: run-1')).toBeInTheDocument();
  expect(screen.getByText('User requested concise replies')).toBeInTheDocument();
});
it('shows a persisted pending decision without pretending the memory changed',async()=>{
  vi.mocked(api.getMemory).mockResolvedValue({status:'ok',memories:[record] as any});
  vi.mocked(api.changeMemory).mockResolvedValue({command:{operationId:'queued'}});
  vi.mocked(api.memoryCommand).mockResolvedValue({command:{operationId:'queued',settledAt:null,response:null}});
  render(<MemoryPanel companionId="c1"/>);await userEvent.click(screen.getByRole('button',{name:'Inspect memory'}));
  await userEvent.click(await screen.findByRole('button',{name:'Approve memory'}));
  expect(await screen.findByText('Request saved. Waiting for the Companion to apply it.')).toBeInTheDocument();
  expect(screen.getByText('Proposed')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Retire memory'})).toBeDisabled();
  expect(api.changeMemory).toHaveBeenCalledWith('c1','approve',expect.objectContaining({id:'memory-1',expectedVersion:2}));
});
it('unavailable is not empty memory and stale responses cannot populate another Companion',async()=>{
  vi.mocked(api.getMemory).mockRejectedValueOnce(new Error('Memory is temporarily unavailable.'));
  const view=render(<MemoryPanel companionId="c1"/>);await userEvent.click(screen.getByRole('button',{name:'Inspect memory'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');expect(screen.queryByText(/No memory records/)).not.toBeInTheDocument();
  let resolve:any;vi.mocked(api.getMemory).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  await userEvent.click(screen.getByRole('button',{name:'Refresh memory'}));view.rerender(<MemoryPanel companionId="c2"/>);
  resolve({status:'ok',memories:[record]});await waitFor(()=>expect(screen.getByRole('button',{name:'Inspect memory'})).toBeEnabled());expect(screen.queryByText(record.content)).not.toBeInTheDocument();
});

it('offers lifecycle adoption for preserved legacy content',async()=>{
  vi.mocked(api.getMemory).mockResolvedValue({status:'ok',memories:[{...record,id:'legacy-shared-memory',approval:'approved',source:{type:'run',ref:'legacy:workspace/MEMORY.md'}}] as any});
  vi.mocked(api.adoptLegacyMemory).mockResolvedValue({command:{operationId:'adopt'}});
  vi.mocked(api.memoryCommand).mockResolvedValue({command:{operationId:'adopt',settledAt:null,response:null}});
  render(<MemoryPanel companionId="c1"/>);await userEvent.click(screen.getByRole('button',{name:'Inspect memory'}));
  await userEvent.click(await screen.findByRole('button',{name:'Add lifecycle metadata'}));
  expect(api.adoptLegacyMemory).toHaveBeenCalledWith('c1',expect.any(String));
  expect(screen.getByText('Use concise answers')).toBeInTheDocument();
});
