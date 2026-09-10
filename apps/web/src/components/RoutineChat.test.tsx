import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChatMessage, type Run, type TaskDetail } from "@/api";
import { RoutineActivityRow, RoutineRunSheet, withRoutineActivity, type ChatTimelineItem } from "./RoutineChat";

afterEach(() => vi.unstubAllGlobals());
const run = (id: string, minute: number, extra: Partial<Run> = {}): Run => ({ id, source: "routine", lane: "background", routineId: "routine-1", routineName: "Bonjour 5 min", status: "succeeded", error: null, publishToChat: false, createdAt: `2026-09-09T10:${String(minute).padStart(2, "0")}:00Z`, ...extra });
const entry = (id: string, minute: number): ChatTimelineItem => ({ id, createdAt: run(id, minute).createdAt, message: null, content: "Conversation entry" });
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const task = (run: Run, extra: Partial<TaskDetail> = {}): TaskDetail => ({ ...run, lane: "background", source: "routine", title: "Say hello", content: "Say hello to Stan", resultText: `Result for ${run.id}`, startedAt: run.createdAt, finishedAt: run.createdAt, preparedAt: null, cancelRequested: false, publishToChat: false, ...extra });

describe("routine conversation activity", () => {
  it("groups only consecutive silent successes, keeping failures, running tasks and conversation boundaries visible", () => {
    const runs = [run("a", 0), run("b", 5), run("c", 10), run("d", 15, { status: "failed" }), run("e", 20), run("f", 25, { status: "running" }), run("g", 30)];
    const timeline = withRoutineActivity([entry("chat", 7)], { runs, messages: [] });
    expect(timeline.map(item => item.routineRuns?.map(run => run.id) ?? item.id)).toEqual([["a", "b"], "chat", ["c"], ["d"], ["e"], ["f"], ["g"]]);
  });

  it("does not group across routine identities, renamed routines, days or questions", () => {
    const runs = [run("a", 0), run("b", 5, { routineId: "other" }), run("c", 10), run("d", 15, { routineName: "Renamed" }), run("e", 20, { routineName: "Renamed", createdAt: "2026-09-10T10:20:00Z" }), run("f", 25, { routineName: "Renamed", createdAt: "2026-09-10T10:25:00Z" })];
    const timeline = withRoutineActivity([], { runs, messages: [], questions: [{ id: "q", runId: "f", question: "Help?", options: [], answer: "Yes" }] });
    expect(timeline).toHaveLength(6);
  });

  it("replaces a marker only when the real persisted assistant message is available", () => {
    const published = run("a", 0, { publishToChat: true });
    expect(withRoutineActivity([], { runs: [published], messages: [] })).toHaveLength(1);
    const message: ChatMessage = { id: "message", runId: "a", role: "assistant", content: "Hello!", createdAt: run("a", 1).createdAt };
    const timeline = withRoutineActivity([{ id: message.id, createdAt: message.createdAt, message, content: null }], { runs: [published], messages: [message] });
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.message?.content).toBe("Hello!");
  });

  it("keeps unidentified legacy manual runs separate", () => {
    expect(withRoutineActivity([], { runs: [run("a", 0, { routineId: null }), run("b", 5, { routineId: null })], messages: [] })).toHaveLength(2);
  });

  it("opens a grouped trace with all its execution IDs", async () => {
    const onOpen = vi.fn();
    render(<RoutineActivityRow runs={[run("a", 0), run("b", 5)]} onOpen={onOpen}/>);
    await userEvent.setup().click(screen.getByRole("button", { name: "View Bonjour 5 min: 2 runs without a message" }));
    expect(onOpen).toHaveBeenCalledWith(["a", "b"]);
  });
});

describe("routine execution drawer", () => {
  it("loads a selected execution on demand, shows persisted details, opens its routine and restores focus", async () => {
    const a = run("a", 0); const b = run("b", 5);
    const fetchMock = vi.fn(() => response({ task: task(b), files: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const onOpenRoutine = vi.fn(); const onClose = vi.fn();
    const view = render(<RoutineRunSheet companionId="c1" runs={[a, b]} onClose={onClose} onOpenRoutine={onOpenRoutine}/>);
    expect(fetchMock).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /Completed · No message/ })[0]!);
    expect(await screen.findByText("Result for b")).toBeVisible();
    expect(screen.getByText("Say hello to Stan")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith("/api/companions/c1/tasks/b", expect.anything());
    await user.click(screen.getByRole("button", { name: "Open routine" }));
    expect(onOpenRoutine).toHaveBeenCalledWith("routine-1");
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalled();
    view.unmount(); expect(opener).toHaveFocus(); opener.remove();
  });

  it("ignores a stale detail response when another execution is selected", async () => {
    const a = run("a", 0); const b = run("b", 5);
    let resolveFirst!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn((path: string) => path.endsWith("/b") ? new Promise<Response>(resolve => { resolveFirst = resolve; }) : response({ task: task(a), files: [] })));
    render(<RoutineRunSheet companionId="c1" runs={[a, b]} onClose={() => {}}/>);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /Completed · No message/ })[0]!);
    await user.click(screen.getByRole("button", { name: "All 2 executions" }));
    await user.click(screen.getAllByRole("button", { name: /Completed · No message/ })[1]!);
    expect(await screen.findByText("Result for a")).toBeVisible();
    await act(async () => resolveFirst(await response({ task: task(b), files: [] })));
    expect(screen.queryByText("Result for b")).not.toBeInTheDocument();
  });

  it("refreshes on persisted status changes and exposes errors with an explicit retry", async () => {
    const active = run("a", 0, { status: "running" });
    const fetchMock = vi.fn().mockImplementationOnce(() => response({ error: "Unavailable" }, 503)).mockImplementationOnce(() => response({ task: task(active, { resultText: null, finishedAt: null }), files: [] })).mockImplementationOnce(() => response({ task: task(run("a", 0)), files: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<RoutineRunSheet companionId="c1" runs={[active]} onClose={() => {}}/>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Running")).toBeVisible();
    view.rerender(<RoutineRunSheet companionId="c1" runs={[run("a", 0)]} onClose={() => {}}/>);
    expect(await screen.findByText("Result for a")).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });
});

it("uses global metadata and never groups across a missing page", () => {
  const runs = [run('a', 1), run('b', 2), run('c', 3, {hasQuestion:true}), run('d', 4, {hasPublishedMessage:true})];
  const timeline = withRoutineActivity([], {runs,messages:[]}, undefined, new Set(['routine-b']));
  expect(timeline.map(item => item.routineRuns?.map(run => run.id))).toEqual([['a'],['b'],['c']]);
});
