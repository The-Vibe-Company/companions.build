import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SpecialistPreparation } from './SpecialistPreparation';
const response = (status: string) => Promise.resolve(new Response(JSON.stringify({ companion: { id: 'draft', name: 'Scout', status } })));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('opens the chat only after the persisted machine becomes ready', async () => {
  vi.useFakeTimers();
  const onReady = vi.fn();
  const fetchMock = vi.fn().mockImplementationOnce(() => response('new')).mockImplementationOnce(() => response('preparing')).mockImplementationOnce(() => response('ready'));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { render(<SpecialistPreparation companionId="draft" onReady={onReady}/>); });
  expect(screen.getByRole('heading')).toHaveTextContent('Waiting for an available machine');
  expect(onReady).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(screen.getByRole('heading')).toHaveTextContent('Preparing its environment');
  expect(onReady).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(onReady).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});
it('shows a recovery action without creating a second machine after a failed status read', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(Error('Connection lost')).mockImplementationOnce(() => response('ready')));
  const onReady = vi.fn();
  render(<SpecialistPreparation companionId="draft" onReady={onReady}/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  await act(async () => {});
  expect(onReady).toHaveBeenCalledOnce();
});
