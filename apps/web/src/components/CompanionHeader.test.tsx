import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { workspaceApi, type CompanionDetail } from '@/api';
import { CompanionHeader } from './CompanionHeader';
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

it('signals unread updates from another Companion in mobile navigation',()=>{
 const retired={...detail,companion:{...detail.companion,retiredAt:'2026-09-09T12:00:00Z'}};
 const props={detail:retired,section:'chat' as const,refreshVersion:0,onSection:vi.fn(),onMenu:vi.fn(),notificationCounts:{unread:0,needsInput:0}};
 const view=render(<CompanionHeader {...props} navigationNeedsAttention/>);
 expect(screen.getByRole('button',{name:'Open navigation, notifications need attention'})).toHaveClass('mobile-menu--attention');
 view.rerender(<CompanionHeader {...props} navigationNeedsAttention={false}/>);
 expect(screen.getByRole('button',{name:'Open navigation'})).not.toHaveClass('mobile-menu--attention');
 view.rerender(<CompanionHeader {...props} notificationCounts={{unread:1,needsInput:0}}/>);
 expect(screen.getByRole('button',{name:'Open navigation, notifications need attention'})).toHaveClass('mobile-menu--attention');
});
