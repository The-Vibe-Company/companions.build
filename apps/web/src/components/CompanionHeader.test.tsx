import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { workspaceApi, type CompanionDetail } from '@/api';
import { CompanionHeader } from './CompanionHeader';
import { AVATAR_COLORS, DEFAULT_AVATAR } from './CompanionAvatar';
import { readFileSync } from 'node:fs';
const headerCss=readFileSync('src/components/CompanionHeader.css','utf8');
const detail:CompanionDetail={companion:{id:'ada',name:'Ada',instructions:'Research questions',provider:'box',status:'ready',error:null,createdAt:'2026-09-06T12:00:00Z'},messages:[],runs:[],activity:[]};
afterEach(()=>vi.restoreAllMocks());
it('uses persisted summaries and keeps discussion and settings reachable',async()=>{
 vi.spyOn(workspaceApi,'companionTemplates').mockResolvedValue({templates:[{templateId:'sage',maxChildren:2},{templateId:'disabled',maxChildren:0}]} as never);
 vi.spyOn(workspaceApi,'templates').mockResolvedValue({templates:[{id:'sage',name:'Sage'}]} as never);
 vi.spyOn(workspaceApi,'routines').mockResolvedValue({routines:[{enabled:true,nextFireAt:'2099-09-07T09:00:00Z'},{enabled:false,nextFireAt:null}]} as never);
 vi.spyOn(workspaceApi,'triggers').mockResolvedValue({triggers:[{enabled:true}]} as never);
 const onSection=vi.fn();render(<CompanionHeader detail={detail} section="settings" refreshVersion={0} onSection={onSection} onMenu={vi.fn()}/>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Team'})).toHaveTextContent('Team1'));
 expect(screen.getByRole('button',{name:'Automations'})).toHaveTextContent(/Automations2 · next/);
 expect(screen.getByRole('button',{name:'Activity'})).toHaveTextContent('Idle');
 expect(within(screen.getByRole('navigation')).queryByRole('button',{name:'Discussion'})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Apps'})).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'Discussion'}));expect(onSection).toHaveBeenLastCalledWith('chat');
 await userEvent.click(screen.getByRole('button',{name:'Settings'}));expect(onSection).toHaveBeenLastCalledWith('settings');
});
it('does not invent counts when summary reads fail',async()=>{
 vi.spyOn(workspaceApi,'companionTemplates').mockRejectedValue(new Error('Unavailable'));
 vi.spyOn(workspaceApi,'templates').mockRejectedValue(new Error('Unavailable'));
 vi.spyOn(workspaceApi,'routines').mockRejectedValue(new Error('Unavailable'));
 vi.spyOn(workspaceApi,'triggers').mockRejectedValue(new Error('Unavailable'));
 render(<CompanionHeader detail={detail} section="chat" refreshVersion={0} onSection={vi.fn()} onMenu={vi.fn()}/>);
 await waitFor(()=>expect(workspaceApi.triggers).toHaveBeenCalled());
 expect(screen.getByRole('button',{name:'Team'})).toHaveTextContent(/^Team$/);
 expect(screen.getByRole('button',{name:'Automations'})).toHaveTextContent(/^Automations$/);
});

it('shows persisted update maintenance while keeping saved messages and navigation available',async()=>{
 vi.spyOn(workspaceApi,'companionTemplates').mockResolvedValue({templates:[]});
 vi.spyOn(workspaceApi,'templates').mockResolvedValue({templates:[]});
 vi.spyOn(workspaceApi,'routines').mockResolvedValue({routines:[]});
 vi.spyOn(workspaceApi,'triggers').mockResolvedValue({triggers:[]});
 const onSection=vi.fn();
 const view=render(<CompanionHeader detail={{...detail,companion:{...detail.companion,runtimeUpdateStatus:'updating'}}} section="chat" refreshVersion={0} onSection={onSection} onMenu={vi.fn()}/>);
 expect(screen.getByRole('button',{name:'Activity'})).toHaveTextContent('Updating');
 expect(screen.getByRole('button',{name:'Activity'})).toHaveAttribute('title',expect.stringContaining('messages are saved'));
 await userEvent.click(screen.getByRole('button',{name:'Activity'}));expect(onSection).toHaveBeenCalledWith('activity');
 view.rerender(<CompanionHeader detail={{...detail,companion:{...detail.companion,runtimeUpdateStatus:'current'}}} section="activity" refreshVersion={0} onSection={onSection} onMenu={vi.fn()}/>);
 expect(screen.getByRole('button',{name:'Activity'})).toHaveTextContent('Idle');
});

it('shows the saved avatar and keeps the entire identity keyboard and click accessible',async()=>{
 vi.spyOn(workspaceApi,'companionTemplates').mockResolvedValue({templates:[]});
 vi.spyOn(workspaceApi,'templates').mockResolvedValue({templates:[]});
 vi.spyOn(workspaceApi,'routines').mockResolvedValue({routines:[]});
 vi.spyOn(workspaceApi,'triggers').mockResolvedValue({triggers:[]});
 const onSection=vi.fn(),onMenu=vi.fn(),user=userEvent.setup();
 render(<CompanionHeader detail={{...detail,companion:{...detail.companion,avatar:{shape:2,color:4,face:0}}}} section="settings" refreshVersion={0} onSection={onSection} onMenu={onMenu}/>);
 const identity=screen.getByRole('button',{name:'Discussion'});
 const avatar=within(identity).getByRole('img',{name:'Ada, Companion'});
 expect(avatar).toHaveAttribute('width','32');
 expect(avatar).toHaveAttribute('height','32');
 expect(avatar.querySelector('g')).toHaveAttribute('fill',AVATAR_COLORS[4]);
 expect(avatar.querySelector('rect')).toBeInTheDocument();
 expect(within(identity).getByRole('heading',{name:'Ada'})).toBeInTheDocument();
 expect(within(identity).getByText('Research questions')).toBeInTheDocument();
 await user.click(avatar);
 expect(onSection).toHaveBeenLastCalledWith('chat');
 await user.click(screen.getByRole('button',{name:'Open navigation'}));
 expect(onMenu).toHaveBeenCalledOnce();
 await user.tab();
 expect(identity).toHaveFocus();
 await user.keyboard('{Enter}');
 expect(onSection).toHaveBeenCalledTimes(2);
 await user.keyboard(' ');
 expect(onSection).toHaveBeenCalledTimes(3);
 expect(onSection).toHaveBeenLastCalledWith('chat');
});

it('keeps long identity text contained with a single-line description and room for navigation',()=>{
 vi.spyOn(workspaceApi,'companionTemplates').mockResolvedValue({templates:[]});
 vi.spyOn(workspaceApi,'templates').mockResolvedValue({templates:[]});
 vi.spyOn(workspaceApi,'routines').mockResolvedValue({routines:[]});
 vi.spyOn(workspaceApi,'triggers').mockResolvedValue({triggers:[]});
 // jsdom does not lay out flex boxes; check the applied containment rules.
 const style=document.createElement('style');
 style.textContent=headerCss;
 document.head.append(style);
 try {
  const instructions='A very long description with more research questions. '.repeat(30);
  render(<CompanionHeader detail={{...detail,companion:{...detail.companion,instructions}}} section="chat" refreshVersion={0} onSection={vi.fn()} onMenu={vi.fn()}/>);
  const identity=screen.getByRole('button',{name:'Discussion'});
  const description=within(identity).getByText(instructions.trim());
  expect(within(identity).getByRole('heading',{name:'Ada'})).toBeInTheDocument();
  expect(getComputedStyle(identity).minWidth).toBe('0');
  expect(getComputedStyle(identity).display).toBe('flex');
  expect(getComputedStyle(description.parentElement!).minWidth).toBe('0');
  expect(getComputedStyle(description).whiteSpace).toBe('nowrap');
  expect(getComputedStyle(description).overflow).toBe('hidden');
  expect(getComputedStyle(description).textOverflow).toBe('ellipsis');
  expect(getComputedStyle(screen.getByRole('navigation',{name:'Companion sections'})).flexShrink).toBe('0');
 } finally { style.remove(); }
});

it('uses the fallback avatar and sleeping appearance while preserving finished text',()=>{
 const view=render(<CompanionHeader detail={{...detail,companion:{...detail.companion,avatar:null,status:'archived',retiredAt:'2026-09-07T12:00:00Z'}}} section="chat" refreshVersion={0} onSection={vi.fn()} onMenu={vi.fn()}/>);
 const identity=screen.getByRole('button',{name:'Discussion'});
 const avatar=within(identity).getByRole('img',{name:'Ada, Companion'});
 expect(avatar.querySelector('g')).toHaveAttribute('fill',AVATAR_COLORS[DEFAULT_AVATAR.color]);
 expect(avatar.querySelectorAll('circle')).toHaveLength(0);
 expect(identity).toHaveTextContent('AdaFinished specialist');
 expect(identity).toHaveAttribute('aria-current','page');
 expect(screen.getByRole('button',{name:'Activity'})).toHaveTextContent('Finished');
 expect(screen.queryByRole('button',{name:'Settings'})).not.toBeInTheDocument();
 view.rerender(<CompanionHeader detail={{...detail,companion:{...detail.companion,retiredAt:'2026-09-07T12:00:00Z'}}} section="activity" refreshVersion={0} onSection={vi.fn()} onMenu={vi.fn()}/>);
 expect(within(identity).getByRole('img').querySelectorAll('circle[r="6.5"]')).toHaveLength(2);
 expect(identity).not.toHaveAttribute('aria-current');
});
