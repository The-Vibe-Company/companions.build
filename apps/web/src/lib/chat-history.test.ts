import { describe, expect, it, vi } from 'vitest';
import { ChatHistory, compareEntries } from './chat-history';
import { type ChatEntry, type ChatPage, type CompanionDetail } from '@/api';
const entry = (n: number, kind: ChatEntry['kind'] = 'message'): ChatEntry => ({ id: `${kind}-${n}`, kind, runId: `run-${n}`, createdAt: `2026-09-01T00:00:00.${String(n).padStart(6, '0')}Z`, sequence: 0, cursor: String(n) });
function page(numbers: number[], before: string | null = null, after: string | null = null): ChatPage {
  return { entries: numbers.map(n => entry(n)), messages: numbers.map(n => ({ id: `message-${n}`, role: 'assistant', content: `Text ${n}`, runId: `run-${n}`, createdAt: entry(n).createdAt })), runs: [], questions: [], files: [], specialists: [], beforeCursor: before, afterCursor: after, nextCursor: null };
}
const snapshot = (chat: ChatPage): CompanionDetail => ({ companion: { id: 'a', name: 'Ada', status: 'ready', provider: 'local', instructions: '', error: null, createdAt: '' }, ...chat, chat, live: { runs: [], questions: [] }, activity: [] });

describe('chat history reconciliation', () => {
  it('retains microsecond order instead of rounding timestamps to milliseconds', () => {
    expect([entry(12), entry(1), entry(11)].sort(compareEntries).map(e => e.cursor)).toEqual(['1', '11', '12']);
  });
  it('loads directly around a deep anchor and exposes a gap to the recent page', async () => {
    const fetch = vi.fn().mockResolvedValue(page([10, 11], '10', '11'));
    const history = new ChatHistory(snapshot(page([90, 91], '90')), fetch);
    await history.initialize({ bottom: false, id: 'message-10', cursor: '10', offset: 8 });
    expect(fetch.mock.calls[0][1]).toEqual({ around: '10' });
    expect(history.state.gaps).toEqual([{ beforeId: 'message-90', after: '11' }]);
    expect(history.state.detail.messages).toHaveLength(4);
    fetch.mockResolvedValueOnce(page([12, 90], '12', '90'));
    await history.fillGap('11');
    expect(history.state.gaps).toEqual([]);
    expect(history.state.detail.messages.map(m => m.id)).toEqual(['message-10', 'message-11', 'message-12', 'message-90', 'message-91']);
  });
  it('deduplicates concurrent loads, preserves loaded history and unchanged message references', async () => {
    let finish!: (value: ChatPage) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const history = new ChatHistory(snapshot(page([5, 6], '5')), fetch);
    await history.initialize({ bottom: true });
    const message = history.state.detail.messages[0];
    const first = history.older(); const second = history.older();
    await Promise.resolve();
    finish(page([3, 4], '3', '4'));
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(history.state.detail.messages).toHaveLength(4);
    expect(history.state.detail.messages.find(m => m.id === message.id)).toBe(message);
  });
  it('refreshes bounded ranges through all continuation pages, replacing removed rows', async () => {
    const fetch = vi.fn();
    const history = new ChatHistory(snapshot(page([1, 3])), fetch);
    await history.initialize({ bottom: true });
    fetch.mockResolvedValueOnce({ ...page([2]), nextCursor: '2' }).mockResolvedValueOnce(page([3]));
    await history.refresh(snapshot(page([4, 5], '4')));
    expect(fetch.mock.calls.map(call => call[1])).toEqual([{ from: '1', through: '3' }, { from: '1', through: '3', after: '2' }]);
    expect(history.state.detail.messages.map(m => m.id)).toEqual(['message-2', 'message-3', 'message-4', 'message-5']);
    expect(history.state.gaps).toHaveLength(1);
  });
  it('keeps an old active question reachable and removes the live state after cancellation', async () => {
    const first = snapshot(page([50]));
    first.live = { runs: [{ id: 'old', status: 'needs_input', error: null, createdAt: '', lane: 'background' }], questions: [{ id: 'question', runId: 'old', question: 'Continue?', options: [], answer: null }] };
    const history = new ChatHistory(first, vi.fn().mockResolvedValue(page([50])));
    await history.initialize({ bottom: true });
    expect(history.state.detail.questions?.[0].id).toBe('question');
    await history.refresh(snapshot(page([50])));
    expect(history.state.detail.questions).toEqual([]);
    expect(history.state.detail.runs).toEqual([]);
  });
  it('keeps existing content on failure, permits explicit retry, and ignores late reads after disposal', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(page([1], null, '1'));
    const history = new ChatHistory(snapshot(page([2], '2')), fetch);
    await history.initialize({ bottom: true });
    await history.older();
    expect(history.state.error).toBe('Offline'); expect(history.state.detail.messages).toHaveLength(1);
    await history.retry(); expect(history.state.detail.messages).toHaveLength(2);
    let finish!: (value: ChatPage) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; entered(); }));
    const reading = history.refresh(snapshot(page([3])));
    await started; history.dispose(); const last = history.state;
    finish(page([1, 2])); await reading;
    expect(history.state).toBe(last);
  });
});

it.each(['answered', 'cancelled'])('retains an off-page question after it is %s, using persisted state', async outcome => {
  const first = snapshot(page([50]));
  const question = { id:'old-question',runId:'old',question:'Continue?',options:[],answer:null,runStatus:'needs_input',cursor:'old-cursor' };
  first.live = { runs:[], questions:[question] };
  const closed = { ...question, answer:outcome === 'answered' ? 'Yes' : null, runStatus:outcome === 'cancelled' ? 'cancelled' : 'running' };
  const fetch = vi.fn().mockResolvedValueOnce({ ...page([]),questions:[closed] }).mockResolvedValueOnce(page([50]));
  const history = new ChatHistory(first,fetch);
  await history.initialize({bottom:true});
  await history.refresh(snapshot(page([50])));
  expect(fetch.mock.calls[0][1]).toEqual({around:'old-cursor',limit:1});
  expect(history.state.detail.questions).toEqual([closed]);
  expect(history.state.detail.live?.questions).toEqual([]);
});

it('retains an observed old silent routine after completion', async () => {
  const first=snapshot(page([50]));
  const run={id:'old-routine',cursor:'routine-cursor',source:'routine',status:'running' as const,lane:'background' as const,createdAt:'',error:null};
  first.live={runs:[run],questions:[]};
  const completed={...run,status:'succeeded' as const};
  const fetch=vi.fn().mockResolvedValueOnce({...page([]),entries:[{...entry(1,'routine'),id:'routine-old-routine'}],runs:[completed]}).mockResolvedValueOnce(page([50]));
  const history=new ChatHistory(first,fetch);await history.initialize({bottom:true});await history.refresh(snapshot(page([50])));
  expect(history.state.detail.retainedRuns).toEqual([completed]);
});

it('recovers from an invalid saved cursor using the recent page, while network failures remain retryable', async () => {
  const {ApiError}=await import('@/api');
  const fetch=vi.fn().mockRejectedValueOnce(new ApiError('Invalid pagination',400));
  const history=new ChatHistory(snapshot(page([50])),fetch);
  await history.initialize({bottom:false,id:'missing',cursor:'bad',offset:0});
  expect(history.state).toMatchObject({restoring:false,error:'',resetReading:true});
  expect(history.state.detail.messages.map(message=>message.id)).toEqual(['message-50']);
  expect(fetch).toHaveBeenCalledTimes(1);
});
