import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Companion, type TaskDetail, type TaskSummary } from "@/api";
import { TaskActivity } from "./TaskActivity";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve=next; reject=fail; });
  return { promise, resolve, reject };
}

const companion: Companion = {
  id: "ada", name: "Ada", instructions: "Research", provider: "box", status: "ready", error: null,
  createdAt: "2026-09-07T10:00:00.000Z", retiredAt: null,
};
const running: TaskSummary = { id:"task-1", status:"running", lane:"main", source:"chat", createdAt:"2026-09-07T12:00:00.000Z", finishedAt:null, title:"Review the launch brief" };
const detail: TaskDetail = { ...running, content:"Review **launch.md**", resultText:null, error:null, startedAt:"2026-09-07T12:00:02.000Z", preparedAt:"2026-09-07T12:00:01.000Z", cancelRequested:false, publishToChat:true };

afterEach(() => vi.restoreAllMocks());

describe("TaskActivity", () => {
  it("loads activity under StrictMode effect replay", async () => {
    vi.spyOn(api,"taskHistory").mockResolvedValue({tasks:[running],nextCursor:null});
    render(<StrictMode><TaskActivity companion={companion} onOpenDiscussion={vi.fn()}/></StrictMode>);
    expect(await screen.findByText("Review the launch brief")).toBeInTheDocument();
    expect(screen.queryByRole("status",{name:"Loading activity"})).not.toBeInTheDocument();
  });

  it("loads older summaries and retries a lazy detail failure", async () => {
    const older: TaskSummary = { ...running, id:"task-older", status:"succeeded", source:"routine", title:"Prepare the weekly notes", createdAt:"2026-09-06T12:00:00.000Z", finishedAt:"2026-09-06T12:03:00.000Z" };
    vi.spyOn(api, "taskHistory")
      .mockResolvedValueOnce({ tasks:[running], nextCursor:"older-cursor" })
      .mockResolvedValueOnce({ tasks:[older], nextCursor:null });
    vi.spyOn(api, "taskDetail")
      .mockRejectedValueOnce(new Error("Task detail is temporarily unavailable."))
      .mockResolvedValueOnce({ task:detail, files:[{ id:"file-1", runId:running.id, kind:"agent_output", name:"launch.md", mimeType:"text/markdown", size:12, url:"/files/launch" }] });
    const user=userEvent.setup();
    const onOpenCompanion=vi.fn();
    render(<TaskActivity companion={companion} onOpenDiscussion={vi.fn()} onOpenCompanion={onOpenCompanion} specialists={[{ delegationId:"delegation-1", parentRunId:"task-1", childRunId:"child-run", companion:{ id:"researcher", name:"Researcher", status:"archived", retiredAt:"2026-09-07T12:04:00.000Z" } }]}/>);

    await user.click(await screen.findByRole("button", { name:/Review the launch brief/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Task detail is temporarily unavailable.");
    await user.click(screen.getByRole("button", { name:"Try again" }));
    expect(await screen.findByRole("heading", { name:"Original request" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name:"launch.md" })).toHaveAttribute("href", "/files/launch");
    await user.click(screen.getByRole("button", { name:"Open Researcher's discussion" }));
    expect(onOpenCompanion).toHaveBeenCalledWith("researcher");
    expect(screen.getByText("Finished")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name:"All activity" }));
    await user.click(screen.getByRole("button", { name:"Load older" }));
    expect(await screen.findByRole("button", { name:/Prepare the weekly notes/ })).toBeInTheDocument();
    expect(api.taskHistory).toHaveBeenLastCalledWith("ada", "older-cursor");
  });

  it("cancels only an active task and sends needs-input work to Discussion", async () => {
    const needsInput: TaskDetail = { ...detail, status:"needs_input", lane:"background", title:"Choose a launch date" };
    const cancelled: TaskDetail = { ...needsInput, status:"cancelled", finishedAt:"2026-09-07T12:04:00.000Z" };
    vi.spyOn(api, "taskHistory").mockResolvedValue({ tasks:[needsInput], nextCursor:null });
    vi.spyOn(api, "taskDetail").mockResolvedValue({ task:needsInput, files:[] });
    const cancel=vi.spyOn(api, "cancelTask").mockResolvedValue({ task:cancelled });
    const onOpenDiscussion=vi.fn(); const user=userEvent.setup();
    render(<TaskActivity companion={companion} onOpenDiscussion={onOpenDiscussion}/>);

    await user.click(await screen.findByRole("button", { name:/Choose a launch date/ }));
    await user.click(await screen.findByRole("button", { name:"Open Discussion" }));
    expect(onOpenDiscussion).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name:"Cancel task" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("ada", "task-1"));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name:"Cancel task" })).not.toBeInTheDocument();
  });

  it("refreshes the selected detail without dropping already loaded older tasks", async () => {
    const older: TaskSummary = { ...running, id:"task-older", status:"succeeded", title:"Older task", finishedAt:"2026-09-06T12:03:00.000Z" };
    const completed: TaskDetail = { ...detail, status:"succeeded", resultText:"## Done\n\nLaunch reviewed.", finishedAt:"2026-09-07T12:05:00.000Z" };
    vi.spyOn(api, "taskHistory")
      .mockResolvedValueOnce({ tasks:[running], nextCursor:"older-cursor" })
      .mockResolvedValueOnce({ tasks:[older], nextCursor:null })
      .mockResolvedValueOnce({ tasks:[{...running,status:"succeeded",finishedAt:completed.finishedAt}], nextCursor:"older-cursor" });
    vi.spyOn(api, "taskDetail").mockResolvedValueOnce({ task:detail, files:[] }).mockResolvedValueOnce({ task:completed, files:[] });
    const view=render(<TaskActivity companion={companion} refreshVersion={0} onOpenDiscussion={vi.fn()}/>); const user=userEvent.setup();

    await screen.findByText("Review the launch brief");
    await user.click(screen.getByRole("button", { name:"Load older" }));
    await screen.findByText("Older task");
    await user.click(screen.getByRole("button", { name:/Review the launch brief/ }));
    await screen.findByRole("heading", { name:"Original request" });
    view.rerender(<TaskActivity companion={companion} refreshVersion={1} onOpenDiscussion={vi.fn()}/>);
    expect(await screen.findByRole("heading", { name:"Done" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name:"All activity" }));
    expect(screen.getByText("Older task")).toBeInTheDocument();
  });

  it("ignores a late detail response after Back and a newer selection", async () => {
    const taskA={...running,id:"task-a",lane:"background" as const,title:"Slow task A"};
    const taskB={...running,id:"task-b",lane:"background" as const,title:"Fast task B"};
    const detailA={...detail,...taskA}; const detailB={...detail,...taskB};
    const slowA=deferred<{task:TaskDetail;files:[]}>();
    const fastB=deferred<{task:TaskDetail;files:[]}>();
    vi.spyOn(api,"taskHistory").mockResolvedValue({tasks:[taskA,taskB],nextCursor:null});
    vi.spyOn(api,"taskDetail").mockImplementation((_companionId,taskId)=>taskId==="task-a"?slowA.promise:fastB.promise);
    const cancel=vi.spyOn(api,"cancelTask").mockResolvedValue({task:{...detailB,status:"cancelled",finishedAt:"2026-09-07T12:08:00.000Z"}});
    const user=userEvent.setup(); render(<TaskActivity companion={companion} onOpenDiscussion={vi.fn()}/>);

    await user.click(await screen.findByRole("button",{name:/Slow task A/}));
    await user.click(screen.getByRole("button",{name:"All activity"}));
    await user.click(screen.getByRole("button",{name:/Fast task B/}));
    fastB.resolve({task:detailB,files:[]});
    expect(await screen.findByRole("heading",{name:"Fast task B"})).toBeInTheDocument();
    slowA.resolve({task:detailA,files:[]});
    await waitFor(()=>expect(screen.getByRole("heading",{name:"Fast task B"})).toBeInTheDocument());
    await user.click(screen.getByRole("button",{name:"Cancel task"}));
    expect(cancel).toHaveBeenCalledWith("ada","task-b");
  });

  it("coalesces burst refreshes and keeps an acknowledged cancellation newer than stale detail", async () => {
    const background={...detail,lane:"background" as const};
    const cancelled={...background,status:"cancelled" as const,finishedAt:"2026-09-07T12:08:00.000Z"};
    const slowPage=deferred<{tasks:TaskSummary[];nextCursor:null}>();
    const slowDetail=deferred<{task:TaskDetail;files:[]}>();
    vi.spyOn(api,"taskHistory")
      .mockResolvedValueOnce({tasks:[background],nextCursor:null})
      .mockImplementationOnce(()=>slowPage.promise)
      .mockResolvedValueOnce({tasks:[cancelled],nextCursor:null});
    vi.spyOn(api,"taskDetail")
      .mockResolvedValueOnce({task:background,files:[]})
      .mockImplementationOnce(()=>slowDetail.promise)
      .mockResolvedValueOnce({task:cancelled,files:[]});
    vi.spyOn(api,"cancelTask").mockResolvedValue({task:cancelled});
    const user=userEvent.setup();
    const view=render(<TaskActivity companion={companion} refreshVersion={0} onOpenDiscussion={vi.fn()}/>);
    await user.click(await screen.findByRole("button",{name:/Review the launch brief/}));
    await screen.findByRole("button",{name:"Cancel task"});

    view.rerender(<TaskActivity companion={companion} refreshVersion={1} onOpenDiscussion={vi.fn()}/>);
    view.rerender(<TaskActivity companion={companion} refreshVersion={2} onOpenDiscussion={vi.fn()}/>);
    await waitFor(()=>expect(api.taskHistory).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button",{name:"Cancel task"}));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    slowPage.resolve({tasks:[background],nextCursor:null}); slowDetail.resolve({task:background,files:[]});
    await waitFor(()=>expect(api.taskHistory).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Cancel task"})).not.toBeInTheDocument();
  });

  it("records a cancellation that finishes after another task is opened", async () => {
    const taskA={...running,id:"task-a",lane:"background" as const,title:"Task A"};
    const taskB={...running,id:"task-b",lane:"background" as const,title:"Task B"};
    const cancelResult=deferred<{task:TaskDetail}>();
    vi.spyOn(api,"taskHistory").mockResolvedValue({tasks:[taskA,taskB],nextCursor:null});
    vi.spyOn(api,"taskDetail").mockImplementation(async (_companionId,taskId)=>({task:{...detail,...(taskId==="task-a"?taskA:taskB)},files:[]}));
    vi.spyOn(api,"cancelTask").mockImplementation(()=>cancelResult.promise);
    const user=userEvent.setup(); render(<TaskActivity companion={companion} onOpenDiscussion={vi.fn()}/>);

    await user.click(await screen.findByRole("button",{name:/Task A/}));
    await user.click(await screen.findByRole("button",{name:"Cancel task"}));
    await user.click(screen.getByRole("button",{name:"All activity"}));
    await user.click(screen.getByRole("button",{name:/Task B/}));
    expect(await screen.findByRole("heading",{name:"Task B"})).toBeInTheDocument();
    cancelResult.resolve({task:{...detail,...taskA,status:"cancelled",finishedAt:"2026-09-07T12:08:00.000Z"}});
    await waitFor(()=>expect(screen.getByRole("heading",{name:"Task B"})).toBeInTheDocument());
    await user.click(screen.getByRole("button",{name:"All activity"}));
    expect(screen.getByRole("button",{name:/Task A/})).toHaveTextContent("Cancelled");
  });

  it("does not let one stale refresh roll an acknowledged cancellation back", async () => {
    const background={...detail,lane:"background" as const};
    const cancelled={...background,status:"cancelled" as const,finishedAt:"2026-09-07T12:08:00.000Z"};
    const stalePage=deferred<{tasks:TaskSummary[];nextCursor:null}>();
    const staleDetail=deferred<{task:TaskDetail;files:[]}>();
    vi.spyOn(api,"taskHistory").mockResolvedValueOnce({tasks:[background],nextCursor:null}).mockImplementationOnce(()=>stalePage.promise);
    vi.spyOn(api,"taskDetail").mockResolvedValueOnce({task:background,files:[]}).mockImplementationOnce(()=>staleDetail.promise);
    vi.spyOn(api,"cancelTask").mockResolvedValue({task:cancelled});
    const user=userEvent.setup(); const view=render(<TaskActivity companion={companion} refreshVersion={0} onOpenDiscussion={vi.fn()}/>);
    await user.click(await screen.findByRole("button",{name:/Review the launch brief/}));
    view.rerender(<TaskActivity companion={companion} refreshVersion={1} onOpenDiscussion={vi.fn()}/>);
    await waitFor(()=>expect(api.taskHistory).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button",{name:"Cancel task"}));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    stalePage.resolve({tasks:[background],nextCursor:null}); staleDetail.resolve({task:background,files:[]});
    await user.click(screen.getByRole("button",{name:"All activity"}));
    await waitFor(()=>expect(screen.getByRole("button",{name:/Review the launch brief/})).toHaveTextContent("Cancelled"));
  });

  it("rejects stale detail from a refresh started during cancellation", async () => {
    const background={...detail,lane:"background" as const};
    const cancelled={...background,status:"cancelled" as const,finishedAt:"2026-09-07T12:08:00.000Z"};
    const cancellation=deferred<{task:TaskDetail}>();
    const stalePage=deferred<{tasks:TaskSummary[];nextCursor:null}>();
    const staleDetail=deferred<{task:TaskDetail;files:[]}>();
    vi.spyOn(api,"taskHistory").mockResolvedValueOnce({tasks:[background],nextCursor:null}).mockImplementationOnce(()=>stalePage.promise);
    vi.spyOn(api,"taskDetail").mockResolvedValueOnce({task:background,files:[]}).mockImplementationOnce(()=>staleDetail.promise);
    vi.spyOn(api,"cancelTask").mockImplementation(()=>cancellation.promise);
    const user=userEvent.setup(); const view=render(<TaskActivity companion={companion} refreshVersion={0} onOpenDiscussion={vi.fn()}/>);
    await user.click(await screen.findByRole("button",{name:/Review the launch brief/}));
    await user.click(await screen.findByRole("button",{name:"Cancel task"}));
    view.rerender(<TaskActivity companion={companion} refreshVersion={1} onOpenDiscussion={vi.fn()}/>);
    await waitFor(()=>expect(api.taskDetail).toHaveBeenCalledTimes(2));
    cancellation.resolve({task:cancelled});
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    await act(async()=>{
      stalePage.resolve({tasks:[background],nextCursor:null}); staleDetail.resolve({task:background,files:[]});
      await Promise.all([stalePage.promise,staleDetail.promise]);
    });
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Cancel task"})).not.toBeInTheDocument();
  });

  it("keeps a successful list refresh when the selected detail refresh fails", async () => {
    const completed={...running,status:"succeeded" as const,finishedAt:"2026-09-07T12:08:00.000Z"};
    vi.spyOn(api,"taskHistory").mockResolvedValueOnce({tasks:[running],nextCursor:null}).mockResolvedValueOnce({tasks:[completed],nextCursor:null});
    vi.spyOn(api,"taskDetail").mockResolvedValueOnce({task:detail,files:[]}).mockRejectedValueOnce(new Error("This task is no longer available."));
    const user=userEvent.setup(); const view=render(<TaskActivity companion={companion} refreshVersion={0} onOpenDiscussion={vi.fn()}/>);
    await user.click(await screen.findByRole("button",{name:/Review the launch brief/}));
    await screen.findByRole("heading",{name:"Original request"});
    view.rerender(<TaskActivity companion={companion} refreshVersion={1} onOpenDiscussion={vi.fn()}/>);
    expect(await screen.findByRole("alert")).toHaveTextContent("This task is no longer available.");
    await user.click(screen.getByRole("button",{name:"All activity"}));
    expect(screen.getByRole("button",{name:/Review the launch brief/})).toHaveTextContent("Succeeded");
  });

  it("serializes pagination with refresh and restarts traversal when a new head has no overlap", async () => {
    const makeTask=(prefix:string,index:number):TaskSummary=>({...running,id:`${prefix}-${index}`,title:`${prefix} task ${index}`,createdAt:new Date(Date.UTC(2026,8,prefix==="New"?8:7,12,index)).toISOString()});
    const first=Array.from({length:20},(_,index)=>makeTask("Old",index));
    const second=Array.from({length:20},(_,index)=>makeTask("Old",index+20));
    const fresh=Array.from({length:20},(_,index)=>makeTask("New",index));
    const gap=Array.from({length:10},(_,index)=>makeTask("New",index+20));
    const olderPage=deferred<{tasks:TaskSummary[];nextCursor:null}>();
    vi.spyOn(api,"taskHistory")
      .mockResolvedValueOnce({tasks:first,nextCursor:"old-page-2"})
      .mockImplementationOnce(()=>olderPage.promise)
      .mockResolvedValueOnce({tasks:fresh,nextCursor:"new-gap"})
      .mockResolvedValueOnce({tasks:gap,nextCursor:"old-head"});
    vi.spyOn(api,"taskDetail");
    const user=userEvent.setup(); const view=render(<TaskActivity companion={companion} refreshVersion={0} onOpenDiscussion={vi.fn()}/>);
    await screen.findByText("Old task 0");
    await user.click(screen.getByRole("button",{name:"Load older"}));
    view.rerender(<TaskActivity companion={companion} refreshVersion={1} onOpenDiscussion={vi.fn()}/>);
    expect(api.taskHistory).toHaveBeenCalledTimes(2);
    olderPage.resolve({tasks:second,nextCursor:null});
    await screen.findByText("Old task 39");
    await waitFor(()=>expect(api.taskHistory).toHaveBeenCalledTimes(3));
    expect(screen.getByText("New task 0")).toBeInTheDocument();
    expect(screen.getByText("Old task 0")).toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"Load older"}));
    expect(await screen.findByText("New task 29")).toBeInTheDocument();
    expect(api.taskHistory).toHaveBeenLastCalledWith("ada","new-gap");
    const newGapRow=screen.getByRole("button",{name:/New task 20/});
    const oldHeadRow=screen.getByRole("button",{name:/Old task 19/});
    expect(newGapRow.compareDocumentPosition(oldHeadRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText("New task 20")).toHaveLength(1);
  });
});
