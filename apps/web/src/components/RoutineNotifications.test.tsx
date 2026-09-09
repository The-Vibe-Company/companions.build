import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RoutineNotification } from "@/api";
import { groupRoutineNotifications, RoutineNotifications } from "./RoutineNotifications";

afterEach(()=>vi.unstubAllGlobals());
const response=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}}));
const notification=(id:string,kind:RoutineNotification["kind"],extra:Partial<RoutineNotification>={}):RoutineNotification=>({id,runId:`run-${id}`,kind,routineId:"routine-1",routineName:"Morning brief",createdAt:`2026-09-09T10:0${id}:00Z`,groupDate:"2026-09-09",readAt:null,questionId:null,text:`Update ${id}`,runStatus:kind==="question"?"needs_input":"failed",actionable:kind==="question",...extra});

it("groups same-routine failures by the persisted routine date even when separated",()=>{
  const groups=groupRoutineNotifications([notification("1","failure"),notification("2","result"),notification("3","failure")]);
  expect(groups.map(group=>group.items.map(item=>item.id))).toEqual([["1","3"],["2"]]);
});

it("reads only an opened notification, loads its execution, and answers its actionable question",async()=>{
  const item=notification("1","question",{text:"Choose color",questionId:"q1",question:{id:"q1",runId:"run-1",question:"Which color?",options:["Blue"],answer:null,runStatus:"needs_input",createdAt:"2026-09-09T10:01:00Z"}});
  const fetchMock=vi.fn((input:RequestInfo|URL,options?:RequestInit)=>{
    const path=String(input);
    if(path.includes("/notifications?") )return response({notifications:[item],nextCursor:null});
    if(path.endsWith("/notifications/1/read"))return response({read:true});
    if(path.endsWith("/tasks/run-1"))return response({task:{...item,title:"Morning brief",content:"Brief me",resultText:null,error:null,lane:"background",source:"routine",startedAt:item.createdAt,finishedAt:null,preparedAt:item.createdAt,cancelRequested:false,publishToChat:false},files:[]});
    if(path.endsWith("/questions/q1/answer")&&options?.method==="POST")return response({answered:true});
    throw Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch",fetchMock);
  const user=userEvent.setup();
  render(<RoutineNotifications companionId="ada" companionName="Ada" open refreshVersion={0} onOpen={()=>{}} onClose={()=>{}} onChanged={()=>{}}/>);
  await user.click(await screen.findByText("Choose color"));
  await user.click(await screen.findByRole("button",{name:"Blue"}));
  await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith("/api/companions/ada/notifications/1/read",expect.objectContaining({method:"POST"})));
  expect(fetchMock).toHaveBeenCalledWith("/api/companions/ada/tasks/run-1",expect.anything());
  expect(fetchMock).toHaveBeenCalledWith("/api/companions/ada/questions/q1/answer",expect.objectContaining({body:JSON.stringify({answer:"Blue"})}));
});

it("retries an initial notification failure",async()=>{
  const item=notification("1","result",{runStatus:"succeeded"});
  let attempts=0;
  vi.stubGlobal("fetch",vi.fn((input:RequestInfo|URL)=>{
    if(!String(input).includes("/notifications?"))throw Error(`Unexpected request ${input}`);
    attempts+=1;
    return attempts===1?response({error:"Temporarily unavailable"},503):response({notifications:[item],nextCursor:null});
  }));
  const user=userEvent.setup();
  render(<RoutineNotifications companionId="ada" companionName="Ada" open refreshVersion={0} onOpen={()=>{}} onClose={()=>{}} onChanged={()=>{}}/>);
  await user.click(await screen.findByRole("button",{name:"Try again"}));
  expect(await screen.findByText("Update 1")).toBeVisible();
  expect(attempts).toBe(2);
});

it("reconciles read, answered, and cancelled state across every loaded page",async()=>{
  const firstPage=Array.from({length:20},(_,index)=>notification(`new-${index}`,"result",{createdAt:`2026-09-10T10:${String(index).padStart(2,"0")}:00Z`,runStatus:"succeeded"}));
  const answered=notification("old-answer","question",{createdAt:"2026-09-09T08:00:00Z",text:"Older answer",questionId:"answer-q",question:{id:"answer-q",runId:"run-old-answer",question:"Pick one",options:["Blue"],answer:null,runStatus:"needs_input",createdAt:"2026-09-09T08:00:00Z"}});
  const cancelled=notification("old-cancel","question",{createdAt:"2026-09-09T07:00:00Z",text:"Older cancelled",questionId:"cancel-q",question:{id:"cancel-q",runId:"run-old-cancel",question:"Still needed?",options:["Yes"],answer:null,runStatus:"needs_input",createdAt:"2026-09-09T07:00:00Z"}});
  const older=[answered,cancelled];
  const fetchMock=vi.fn((input:RequestInfo|URL,options?:RequestInit)=>{
    const path=String(input);
    if(path.includes("cursor=older"))return response({notifications:older,nextCursor:null});
    if(path.includes("/notifications?"))return response({notifications:firstPage,nextCursor:"older"});
    if(path.endsWith("/notifications/old-answer/read")){answered.readAt="2026-09-10T12:00:00Z";return response({read:true});}
    if(path.endsWith("/notifications/old-cancel/read")){cancelled.readAt="2026-09-10T12:00:00Z";return response({read:true});}
    if(path.endsWith("/questions/answer-q/answer")&&options?.method==="POST"){answered.question!.answer="Blue";answered.question!.runStatus="succeeded";answered.actionable=false;answered.runStatus="succeeded";return response({answered:true});}
    if(path.includes("/tasks/"))return response({task:{id:path.split("/").at(-1),status:"needs_input",lane:"background",source:"routine",createdAt:"2026-09-09T07:00:00Z",finishedAt:null,title:"Routine",content:"Work",resultText:null,error:null,startedAt:null,preparedAt:null,cancelRequested:false,publishToChat:false},files:[]});
    throw Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch",fetchMock);
  const user=userEvent.setup();
  const view=render(<RoutineNotifications companionId="ada" companionName="Ada" open refreshVersion={0} onOpen={()=>{}} onClose={()=>{}} onChanged={()=>{}}/>);
  await user.click(await screen.findByRole("button",{name:"Load older"}));
  await user.click(await screen.findByText("Older answer"));
  await user.click(await screen.findByRole("button",{name:"Blue"}));
  expect(await screen.findByRole("region",{name:"Answered question"})).toHaveTextContent("Blue");
  expect(screen.getByText("Older answer").closest("article")).not.toHaveClass("notification-entry--unread");
  await user.click(screen.getByText("Older cancelled"));
  cancelled.actionable=false;cancelled.runStatus="cancelled";cancelled.question!.runStatus="cancelled";
  view.rerender(<RoutineNotifications companionId="ada" companionName="Ada" open refreshVersion={1} onOpen={()=>{}} onClose={()=>{}} onChanged={()=>{}}/>);
  expect(await screen.findByRole("region",{name:"Closed question"})).toHaveTextContent("Still needed?");
  expect(screen.getByText("Update new-19")).toBeVisible();
});
