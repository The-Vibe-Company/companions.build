import { useEffect, useRef, useState } from "react";
import { Bell, Clock3, Menu } from "lucide-react";
import { isActiveRun, workspaceApi, type AgentTemplate, type CompanionDetail } from "@/api";
import { CompanionAvatar } from "./CompanionAvatar";
import { Button } from "./ui/button";
import "./CompanionHeader.css";

export type CompanionSection = "chat" | "team" | "automations" | "activity" | "applications" | "computer" | "settings";
type Summary = { team: { count:number; avatars:AgentTemplate[] } | null; automations: { count:number; next:string|null } | null };

export function CompanionHeader({ detail, section, refreshVersion, onSection, onMenu, notificationCounts, navigationNeedsAttention, onNotifications = () => {} }: {
  detail:CompanionDetail; section:CompanionSection; refreshVersion:number;
  onSection:(section:CompanionSection)=>void; onMenu:()=>void;
  navigationNeedsAttention?:boolean; notificationCounts?:{unread:number;needsInput:number}; onNotifications?:()=>void;
}) {
  const [storedSummary,setSummary]=useState<Summary & {companionId:string}>({companionId:detail.companion.id,team:null,automations:null});
  const summary=storedSummary.companionId===detail.companion.id?storedSummary:{team:null,automations:null};
  const navigation=useRef<HTMLElement>(null);
  const companion=detail.companion;
  const finished=Boolean(companion.retiredAt);
  useEffect(()=>{
    let current=true;
    if(finished)return;
    void Promise.allSettled([
      workspaceApi.companionTemplates(companion.id),workspaceApi.templates(),
      workspaceApi.routines(companion.id),workspaceApi.triggers(companion.id),
    ]).then(([permissions,profiles,routines,triggers])=>{
      if(!current)return;
      const allowed=permissions.status==="fulfilled"?permissions.value.templates.filter(item=>item.maxChildren>0):null;
      const enabledRoutines=routines.status==="fulfilled"?routines.value.routines.filter(item=>item.enabled):null;
      const enabledTriggers=triggers.status==="fulfilled"?triggers.value.triggers.filter(item=>item.enabled):null;
      setSummary({
        companionId:companion.id,
        team:allowed?{count:allowed.length,avatars:profiles.status==="fulfilled"?allowed.flatMap(permission=>profiles.value.templates.filter(template=>template.id===permission.templateId)).slice(0,4):[]}:null,
        automations:enabledRoutines&&enabledTriggers?{count:enabledRoutines.length+enabledTriggers.length,next:enabledRoutines.map(item=>item.nextFireAt).filter((date):date is string=>Boolean(date)&&Number.isFinite(Date.parse(date!))&&Date.parse(date!)>Date.now()).sort((a,b)=>Date.parse(a)-Date.parse(b))[0]??null}:null,
      });
    });
    return()=>{current=false;};
  },[companion.id,finished,refreshVersion]);
  useEffect(()=>{
    const reveal=()=>navigation.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({block:"nearest",inline:"nearest"});
    reveal();window.addEventListener("resize",reveal);return()=>window.removeEventListener("resize",reveal);
  },[section]);
  const run=detail.runs.find(item=>isActiveRun(item.status));
  const activity=finished?"Finished":detail.questions?.some(question=>question.answer==null&&(!question.runStatus||['running','needs_input','preparing'].includes(question.runStatus)))||run?.status==="needs_input"?"Needs you":run?.status==="running"?`${companion.name} · working`:run?.status==="preparing"?"Preparing":run?"Queued":"Idle";
  const next=summary.automations?.next?new Intl.DateTimeFormat(undefined,{weekday:"short",hour:"numeric",minute:"2-digit"}).format(new Date(summary.automations.next)):null;
  const needsAttention=navigationNeedsAttention ?? Boolean(notificationCounts?.needsInput || notificationCounts?.unread);
  return <header className="companion-header">
    <Button className={`mobile-menu${needsAttention ? " mobile-menu--attention" : ""}`} variant="ghost" size="icon" onClick={onMenu} aria-label={needsAttention ? "Open navigation, notifications need attention" : "Open navigation"}><Menu/></Button>
    <button className="companion-header-identity" aria-label="Discussion" aria-current={section==="chat"?"page":undefined} title="Back to discussion" onClick={()=>onSection("chat")}>
      <h1>{companion.name}</h1><span>{finished?"Finished specialist":companion.instructions}</span>
    </button>
    <nav ref={navigation} className="companion-header-links" aria-label="Companion sections">
      {!finished&&<>
        <button className="companion-info-pill companion-info-pill--team" aria-label="Team" aria-current={section==="team"?"page":undefined} onClick={()=>onSection("team")}>
          {Boolean(summary.team?.avatars.length)&&<span className="header-team-avatars" aria-hidden="true">{summary.team!.avatars.map(template=><CompanionAvatar key={template.id} name={template.name} avatar={template.avatar} size={24}/>)}</span>}
          <strong>Team</strong>{summary.team&&<span className="header-pill-detail">{summary.team.count}</span>}
        </button>
        <button className="companion-info-pill" aria-label="Automations" aria-current={section==="automations"?"page":undefined} onClick={()=>onSection("automations")}>
          <Clock3/><strong>Automations</strong>{summary.automations&&<span className="header-pill-detail" title={`${summary.automations.count} enabled automations`}>{summary.automations.count}{next&&` · next ${next}`}</span>}
        </button>
      </>}
      <button className={`companion-info-pill companion-notifications${notificationCounts?.needsInput ? " companion-notifications--attention" : ""}`} aria-label={`Notifications${notificationCounts?.unread ? `, ${notificationCounts.unread} unread` : ""}${notificationCounts?.needsInput ? `, ${notificationCounts.needsInput} need your input` : ""}`} onClick={onNotifications}><Bell/><strong>Notifications</strong>{Boolean(notificationCounts?.unread) && <span className="header-pill-detail">{notificationCounts!.unread}</span>}</button>
      {Boolean(notificationCounts?.needsInput) && <button className="companion-needs-you" onClick={onNotifications}>Needs you · {notificationCounts!.needsInput}</button>}
      <button className="companion-info-pill" aria-label="Activity" aria-current={section==="activity"?"page":undefined} onClick={()=>onSection("activity")}>
        <span aria-hidden="true" className={`header-activity-dot${activity==="Needs you"?" header-activity-dot--attention":run?.status==="running"?" header-activity-dot--working":""}`}/><strong>Activity</strong><span className="header-pill-detail">{activity}</span>
      </button>
      {!finished&&<button className="companion-header-settings" title="Settings" aria-label="Settings" aria-current={section==="settings"||section==="applications"||section==="computer"?"page":undefined} onClick={()=>onSection("settings")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>}
    </nav>
  </header>;
}
