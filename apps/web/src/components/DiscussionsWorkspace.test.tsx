import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscussionsWorkspace } from "./DiscussionsWorkspace";

const user = { id: "user-1", email: "stan@example.com", name: "Stan" };
const ada = { id: "ada", name: "Ada", instructions: "Research", provider: "box" as const, status: "ready" as const, error: null, createdAt: "2026-09-11T09:00:00.000Z", avatar: { shape: 1, color: 2, face: 0 } };
const june = { ...ada, id: "june", name: "June", instructions: "Write" };
const discussion = { id: "discussion-1", title: "Launch", folderId: null, directCompanionId: null, archivedAt: null, createdAt: "2026-09-11T09:00:00.000Z", updatedAt: "2026-09-11T09:00:00.000Z" };
const snapshot = {
  discussion,
  participants: [{ companionId: "ada", removedAt: null, companion: ada }],
  messages: [], tasks: [], centralRuns: [], proposals: [], beforeCursor: null,
};

function response(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })); }

function setupFetch(custom?: (path: string, options?: RequestInit) => Promise<Response> | undefined) {
  const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    const result = custom?.(path, options); if (result) return result;
    if (path === "/api/discussions") return response({ discussions: [discussion], folders: [] });
    if (path === "/api/discussions/discussion-1") return response(snapshot);
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock); return fetchMock;
}

function renderWorkspace() {
  return render(<DiscussionsWorkspace user={user} companions={[ada, june]} initialDiscussionId="discussion-1" legacyCompanionId={null} onUnauthorized={vi.fn()} onCreateCompanion={vi.fn()} onApplications={vi.fn()} onAccount={vi.fn()}/>);
}

describe("discussions workspace", () => {
  beforeEach(() => { window.history.replaceState({}, "", "/discussions/discussion-1"); localStorage.clear(); sessionStorage.clear(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("persists an explicit companion recipient and sends it with a stable request id", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    setupFetch((path, options) => {
      if (path.endsWith("/messages") && options?.method === "POST") { bodies.push(JSON.parse(String(options.body))); return response({ runId: "run-1", discussionId: discussion.id, companionId: "june" }); }
      return undefined;
    });
    const actor = userEvent.setup(); renderWorkspace();
    const recipient = await screen.findByRole("combobox", { name: "Message recipient" });
    await actor.selectOptions(recipient, "june");
    expect(localStorage.getItem("companions.build:discussion-target:user-1:discussion-1")).toBe("june");
    const composer = screen.getByRole("textbox", { name: "Message June" });
    await actor.type(composer, "Draft the announcement");
    await actor.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/), content: "Draft the announcement", targetCompanionId: "june", attachmentCount: 0 });
  });

  it("selects an @ recipient by keyboard without sending and keeps the thread beside the workbench", async () => {
    const existing = { id: "existing", sequence: "1", role: "assistant" as const, content: "Existing context", companionId: null, runId: "run-existing", createdAt: discussion.createdAt, complete: true, files: [] };
    const fetchMock = setupFetch(path => path === "/api/discussions/discussion-1" ? response({ ...snapshot, messages: [existing] }) : undefined);
    const actor = userEvent.setup();
    renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Central" });
    await actor.type(composer, "Ask @Ad");
    const suggestions = screen.getByRole("listbox", { name: "Companion suggestions" });
    expect(composer).toHaveAttribute("aria-controls", suggestions.id);
    expect(document.getElementById(composer.getAttribute("aria-activedescendant")!)).toHaveAttribute("aria-selected", "true");
    await actor.keyboard("{Enter}");
    expect(composer).toHaveValue("Ask @Ada ");
    expect(screen.getByRole("textbox", { name: "Message Ada" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    await actor.click(screen.getByRole("button", { name: "Ada" }));
    expect(await screen.findByRole("heading", { name: "Ada" })).toBeInTheDocument();
    expect(screen.getByText("Existing context")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Ada" })).toBeInTheDocument();
  });

  it("preserves composing text and dismisses mentions without altering the draft", async () => {
    const fetchMock = setupFetch(); renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Central" });
    fireEvent.change(composer, { target: { value: "@Ad" } });
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(composer).toHaveValue("@Ad");
    expect(screen.getByRole("combobox", { name: "Message recipient" })).toHaveValue("");
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(composer).toHaveValue("@Ad");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("shows persisted companion files without changing the recipient or losing the draft", async () => {
    const file = { id: "file-1", name: "design.png", url: "/files/design.png", mimeType: "image/png", size: 123 };
    setupFetch(path => path === "/api/discussions/discussion-1" ? response({ ...snapshot, tasks: [{ id: "task-1", companionId: "ada", status: "succeeded", content: "Design", resultText: "Design ready", previewText: null, error: null, createdAt: discussion.createdAt, finishedAt: discussion.createdAt, files: [file], questions: [] }] }) : undefined);
    const actor = userEvent.setup(); renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Central" });
    await actor.type(composer, "Keep this draft");
    await actor.click(screen.getByRole("button", { name: "Ada" }));
    await actor.click(screen.getByRole("button", { name: /Files.*1/ }));
    const links = screen.getAllByRole("link", { name: "design.png" });
    expect(links.at(-1)).toHaveAttribute("href", "/files/design.png");
    expect(screen.getByRole("combobox", { name: "Message recipient" })).toHaveValue("");
    await actor.click(screen.getByRole("button", { name: "Close workbench" }));
    expect(composer).toHaveValue("Keep this draft");
  });

  it("opens later and removed participant workspaces from the mobile picker", async () => {
    const third = { ...ada, id: "third", name: "Third" };
    const removed = { ...ada, id: "removed", name: "Previous" };
    setupFetch(path => path === "/api/discussions/discussion-1" ? response({ ...snapshot, participants: [snapshot.participants[0], { companionId: june.id, companion: june, removedAt: null }, { companionId: third.id, companion: third, removedAt: null }, { companionId: removed.id, companion: removed, removedAt: discussion.createdAt }] }) : undefined);
    const actor = userEvent.setup(); renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Central" });
    await actor.type(composer, "A draft for Central");
    await actor.click(screen.getByLabelText("Choose discussion companion"));
    await actor.click(screen.getByRole("button", { name: "View Third workspace" }));
    expect(screen.getByRole("heading", { name: "Third" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Message recipient" })).toHaveValue("");
    await actor.click(screen.getByLabelText("Choose discussion companion"));
    await actor.click(screen.getByRole("button", { name: "View Previous workspace" }));
    expect(screen.getByRole("heading", { name: "Previous" })).toBeInTheDocument();
    expect(composer).toHaveValue("A draft for Central");
  });

  it("moves the active mention descendant while focus stays in the composer", async () => {
    setupFetch(); renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Central" });
    const actor = userEvent.setup(); await actor.type(composer, "@");
    const first = composer.getAttribute("aria-activedescendant");
    await actor.keyboard("{ArrowDown}");
    expect(composer).toHaveFocus();
    expect(composer.getAttribute("aria-activedescendant")).not.toBe(first);
    expect(document.getElementById(composer.getAttribute("aria-activedescendant")!)).toHaveTextContent("June");
  });

  it("loads older messages before the current snapshot without duplicating the page", async () => {
    const old = { id: "old", sequence: 4, role: "assistant", content: "Earlier", companionId: null, runId: "run-old", createdAt: "2026-09-11T08:00:00.000Z", complete: true, files: [] };
    const current = { ...old, id: "current", sequence: 55, content: "Current" };
    setupFetch((path) => {
      if (path === "/api/discussions/discussion-1") return response({ ...snapshot, messages: [current], beforeCursor: "55" });
      if (path === "/api/discussions/discussion-1?before=55") return response({ ...snapshot, messages: [old], beforeCursor: null });
      return undefined;
    });
    const actor = userEvent.setup(); renderWorkspace();
    expect(await screen.findByText("Current")).toBeInTheDocument();
    await actor.click(screen.getByRole("button", { name: /Load earlier messages/ }));
    expect(await screen.findByText("Earlier")).toBeInTheDocument();
    expect(screen.getAllByText("Current")).toHaveLength(1);
  });

  it("keeps stop chat and stop companion as separate admissions", async () => {
    const calls: string[] = [];
    setupFetch((path, options) => {
      if (path === "/api/discussions/discussion-1") return response({ ...snapshot, centralRuns: [{ id: "central-1", status: "running", previewText: "Planning", error: null, createdAt: discussion.createdAt, finishedAt: null }], tasks: [{ id: "task-1", companionId: "ada", status: "running", content: "Research", previewText: null, resultText: null, error: null, createdAt: discussion.createdAt, finishedAt: null, questions: [], files: [] }] });
      if (options?.method === "POST" && path.endsWith("/cancel")) { calls.push(path); return response({ ok: true }); }
      return undefined;
    });
    const actor = userEvent.setup(); renderWorkspace();
    await actor.click(await screen.findByRole("button", { name: "Stop chat" }));
    await actor.click(screen.getByRole("button", { name: "Stop Ada" }));
    expect(calls).toContain("/api/discussions/discussion-1/cancel");
    expect(calls).toContain("/api/discussions/discussion-1/participants/ada/cancel");
  });

  it("accepts dropped attachments and preserves their client ids when a send is retried", async () => {
    const uploadIds: string[] = []; let attempts = 0;
    setupFetch((path, options) => {
      if (path.endsWith("/messages") && options?.method === "POST") { attempts++; return attempts === 1 ? response({ error: "uncertain" }, 503) : response({ runId: "run-2", discussionId: discussion.id, companionId: null }); }
      if (path.endsWith("/files") && options?.method === "POST") { uploadIds.push(String((options.body as FormData).get("clientFileId"))); return response({ file: {} }); }
      return undefined;
    });
    const actor = userEvent.setup(); const { container } = renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Central" });
    const form = container.querySelector(".discussion-composer")!;
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    fireEvent.drop(form, { dataTransfer: { files: [file] } });
    await actor.type(composer, "Read this");
    await actor.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("uncertain");
    await actor.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(uploadIds).toHaveLength(1));
    await waitFor(() => expect(sessionStorage.getItem("companions.build:discussion-draft:user-1:discussion-1")).toBeNull());
    expect(uploadIds[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reattaches every saved file id at its immutable original position",async()=>{
    sessionStorage.setItem("companions.build:discussion-draft:user-1:discussion-1",JSON.stringify({attempted:true,content:"Retry files",targetCompanionId:null,clientMessageId:"11111111-1111-4111-8111-111111111111",files:[
      {id:"file-a",name:"same.txt",size:1,position:0},{id:"file-b",name:"same.txt",size:1,position:1},{id:"file-c",name:"last.txt",size:1,position:2},
    ]}));
    const uploads:Array<[string,string]>=[];
    setupFetch((path,options)=>{
      if(path.endsWith("/messages")&&options?.method==="POST")return response({runId:"run-files",discussionId:discussion.id,companionId:null});
      if(path.endsWith("/files")&&options?.method==="POST"){const body=options.body as FormData;uploads.push([String(body.get("clientFileId")),String(body.get("position"))]);return response({file:{}});}
      return undefined;
    });
    const actor=userEvent.setup(),{container}=renderWorkspace();await screen.findByRole("textbox",{name:"Message Central"});
    fireEvent.drop(container.querySelector(".discussion-composer")!,{dataTransfer:{files:[new File(["x"],"last.txt"),new File(["a"],"same.txt"),new File(["b"],"same.txt")]}});
    await actor.click(screen.getByRole("button",{name:"Send message"}));
    await waitFor(()=>expect(uploads).toEqual([["file-a","0"],["file-b","1"],["file-c","2"]]));
  });
});

it('retains messages displaced by polling and orders large decimal sequences exactly',async()=>{
 let poll:(()=>void)|undefined;
 vi.spyOn(window,'setInterval').mockImplementation(((callback:TimerHandler,delay?:number)=>{if(delay===2500)poll=callback as ()=>void;return 42;}) as typeof window.setInterval);
 const message=(id:string,sequence:string)=>({id,sequence,role:'assistant' as const,content:id,companionId:null,runId:id,createdAt:discussion.createdAt,complete:true,files:[]});
 let snapshots=0;
 const fetchMock=setupFetch(path=>{
  if(path==='/api/discussions/discussion-1'){snapshots++;return response({...snapshot,messages:snapshots===1?[message('Current A','9007199254740993'),message('Current B','9007199254740994')]:[message('Current B','9007199254740994'),message('Newest','9007199254740995')],beforeCursor:'9007199254740993'});}
  if(path.endsWith('?before=9007199254740993'))return response({...snapshot,messages:[message('Older','9007199254740992')],beforeCursor:'9007199254740992'});
  if(path.endsWith('?before=9007199254740992'))return response({...snapshot,messages:[message('Oldest','1')],beforeCursor:null});
 });
 const actor=userEvent.setup(),view=renderWorkspace();await screen.findByText('Current A');
 await actor.click(screen.getByRole('button',{name:/Load earlier/}));await screen.findByText('Older');
 poll?.();await waitFor(()=>expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/discussions/discussion-1').length).toBeGreaterThan(1));
 expect(screen.getByText('Current A')).toBeInTheDocument();expect(await screen.findByText('Newest')).toBeInTheDocument();
 expect([...view.container.querySelectorAll<HTMLElement>('.discussion-message')].map(node=>node.dataset.sequence)).toEqual(['9007199254740992','9007199254740993','9007199254740994','9007199254740995']);
 await actor.click(screen.getByRole('button',{name:/Load earlier/}));await screen.findByText('Oldest');
 expect(screen.queryByRole('button',{name:/Load earlier/})).not.toBeInTheDocument();
 cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();
});

it('shows a failed central turn and keeps companion work available in its own tab',async()=>{
 setupFetch(path=>path==='/api/discussions/discussion-1'?response({...snapshot,centralRuns:[{id:'failure',status:'interrupted',error:'Send a new message to continue.',previewText:null,createdAt:discussion.createdAt,finishedAt:discussion.createdAt}]}):undefined);
 const actor=userEvent.setup();renderWorkspace();
 expect(await screen.findByText('Send a new message to continue.')).toBeInTheDocument();
 await actor.click(screen.getByRole('button',{name:'Ada'}));
 expect(await screen.findByRole('heading',{name:'Ada'})).toBeInTheDocument();
 expect(screen.getByRole('textbox',{name:'Message Central'})).toBeInTheDocument();
 cleanup();vi.unstubAllGlobals();
});
