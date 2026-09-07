import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Companion, type TaskDetail, type TaskSummary } from "@/api";
import { TaskActivity } from "./TaskActivity";

const companion: Companion = {
  id: "ada", name: "Ada", instructions: "Research", provider: "box", status: "ready", error: null,
  createdAt: "2026-09-07T10:00:00.000Z", retiredAt: null,
};
const running: TaskSummary = { id:"task-1", status:"running", lane:"main", source:"chat", createdAt:"2026-09-07T12:00:00.000Z", finishedAt:null, title:"Review the launch brief" };
const detail: TaskDetail = { ...running, content:"Review **launch.md**", resultText:null, error:null, startedAt:"2026-09-07T12:00:02.000Z", preparedAt:"2026-09-07T12:00:01.000Z", cancelRequested:false, publishToChat:true };

afterEach(() => vi.restoreAllMocks());

describe("TaskActivity", () => {
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
});
