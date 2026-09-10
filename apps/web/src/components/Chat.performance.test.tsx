import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { api, type CompanionDetail } from '@/api';
import { Chat } from './Chat';
import * as routines from './RoutineChat';
const counters = vi.hoisted(() => ({ markdown: 0 }));
vi.mock('react-markdown', async original => {
  const actual = await original<typeof import('react-markdown')>();
  return { ...actual, default: (props: Parameters<typeof actual.default>[0]) => { counters.markdown++; return actual.default(props); } };
});
vi.mock('./SpecialistImprovements', () => ({ SpecialistImprovements: () => null }));

it('typing does not rebuild the timeline or enter the Markdown parser; persisted text still updates', async () => {
  const detail: CompanionDetail = { companion: { id: 'perf', name: 'Ada', provider: 'local', status: 'ready', instructions: '', error: null, createdAt: '' }, runs: [], activity: [], messages: Array.from({ length: 50 }, (_, n) => ({ id: `m-${n}`, runId: `r-${n}`, role: 'assistant', content: `## Response ${n}\n\n- item\n- **bold**\n\n~~~ts\nconst value = ${n};\n~~~`, createdAt: new Date(n * 1000).toISOString() })) };
  const props = { accountId: 'test', detail, onRefresh: vi.fn(async () => {}), onUnauthorized: vi.fn(), onOpenCompanion: vi.fn() };
  const timeline = vi.spyOn(routines, 'withRoutineActivity');
  const { rerender } = render(<Chat {...props}/>);
  await act(async () => {});
  const parsed = counters.markdown, rendered = timeline.mock.calls.length;
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Message Ada' }), 'A mobile draft with twenty keystrokes');
  expect(screen.getByRole('textbox', { name: 'Message Ada' })).toHaveValue('A mobile draft with twenty keystrokes');
  expect(counters.markdown - parsed).toBe(0);
  expect(timeline.mock.calls.length - rendered).toBe(0);
  rerender(<Chat {...props} detail={{ ...detail, messages: detail.messages.map((message, n) => n === 49 ? { ...message, content: 'Persisted update' } : message) }}/>);
  await waitFor(() => expect(screen.getByText('Persisted update')).toBeVisible());
  expect(counters.markdown - parsed).toBe(1);
});

it('shows active routine executions even when their historical marker is outside the page', async () => {
  const run={id:'old-routine',source:'routine',routineName:'Daily check',status:'running' as const,lane:'background' as const,createdAt:'2025-01-01T00:00:00Z',error:null,hasPublishedMessage:false};
  const chat={entries:[],messages:[],runs:[],questions:[],files:[],specialists:[],beforeCursor:null,afterCursor:null,nextCursor:null};
  const detail:CompanionDetail={companion:{id:'active',name:'Ada',provider:'local',status:'ready',instructions:'',error:null,createdAt:''},messages:[],runs:[run],activity:[],chat,live:{runs:[run],questions:[]}};
  render(<Chat accountId="test" detail={detail} onRefresh={async()=>{}} onUnauthorized={()=>{}} onOpenCompanion={()=>{}}/>);
  expect(await screen.findByRole('button',{name:'View Daily check: Running'})).toBeInTheDocument();
});

it('keeps an answered off-page question visibly in the conversation after refresh', async () => {
  const chat={entries:[],messages:[],runs:[],questions:[],files:[],specialists:[],beforeCursor:null,afterCursor:null,nextCursor:null};
  const question={id:'old-question',runId:'old',question:'Keep going?',options:[],answer:null,createdAt:'2025-01-01T00:00:00.000001Z',runStatus:'needs_input',cursor:'question-cursor'};
  const detail:CompanionDetail={companion:{id:'question-chat',name:'Ada',provider:'local',status:'ready',instructions:'',error:null,createdAt:''},messages:[],runs:[],activity:[],chat,live:{runs:[],questions:[question]}};
  const props={accountId:'test',onRefresh:async()=>{},onUnauthorized:()=>{},onOpenCompanion:()=>{}};
  vi.spyOn(api,'getChatPage').mockResolvedValue({...chat,questions:[{...question,answer:'Yes, continue',runStatus:'running'}]});
  const {rerender}=render(<Chat {...props} detail={detail}/>);
  expect(await screen.findByRole('region',{name:'Waiting for your answer'})).toBeVisible();
  rerender(<Chat {...props} detail={{...detail,live:{runs:[],questions:[]}}}/>);
  expect(await screen.findByRole('region',{name:'Answered question'})).toBeVisible();
  expect(screen.getByText('Yes, continue')).toBeVisible();
});

it('keeps completed application activity beside a persisted assistant explanation', async () => {
  const run={id:'plugin-run',status:'succeeded' as const,error:null,createdAt:'2026-09-10T12:00:00Z',pluginCallVersion:2,pluginCalls:[{requestId:'request-1',runId:'plugin-run',toolCallId:'tool-1',connectionId:'connection-1',tool:'linear.create_issue',attempt:1,phase:'call' as const,status:'succeeded' as const,outcome:'confirmed' as const,startedAt:100,deadlineAt:200,updatedAt:180}]};
  const message={id:'answer',runId:run.id,role:'assistant' as const,content:'I created the issue.',createdAt:'2026-09-10T12:00:01Z'};
  const detail:CompanionDetail={companion:{id:'plugin-chat',name:'Ada',provider:'local',status:'ready',instructions:'',error:null,createdAt:''},messages:[message],runs:[run],activity:[]};
  render(<Chat accountId="test" detail={detail} onRefresh={async()=>{}} onUnauthorized={()=>{}} onOpenCompanion={()=>{}}/>);
  expect(await screen.findByText('I created the issue.')).toBeVisible();
  expect(screen.getByRole('region',{name:'Application activity'})).toHaveTextContent('linear.create_issueCompleted');
});

it('reloads a terminal plugin error beside an incomplete progress message', async () => {
  const run={id:'timeout-run',status:'failed' as const,error:'PLUGIN_RESPONSE_TIMEOUT',createdAt:'2026-09-10T12:00:00Z',pluginCallVersion:3,pluginCalls:[{requestId:'request-timeout',runId:'timeout-run',toolCallId:'tool-timeout',connectionId:'connection-1',tool:'get_session',attempt:2,phase:'call' as const,status:'failed' as const,outcome:'unknown' as const,code:'PLUGIN_TIMEOUT' as const,startedAt:100,deadlineAt:200,updatedAt:200}]};
  const message={id:'progress',runId:run.id,role:'assistant' as const,content:'I am checking the session.',complete:false,createdAt:'2026-09-10T12:00:01Z'};
  const detail:CompanionDetail={companion:{id:'timeout-chat',name:'Ada',provider:'local',status:'ready',instructions:'',error:null,createdAt:''},messages:[message],runs:[run],activity:[]};
  render(<Chat accountId="test" detail={detail} onRefresh={async()=>{}} onUnauthorized={()=>{}} onOpenCompanion={()=>{}}/>);
  expect(await screen.findByText('I am checking the session.')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('could not finish its response');
  expect(screen.getByRole('region',{name:'Application activity'})).toHaveTextContent('Requires verification');
});
