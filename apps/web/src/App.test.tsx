import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

beforeEach(() => window.sessionStorage.clear());

const config = { localAvailable: true, boxAvailable: true, model: "scripted/test" };
const me = { user: { id: "user-1", email: "stan@example.com", name: "Stan" } };
const companion = {
  id: "ada",
  name: "Ada",
  instructions: "Research customer questions.",
  provider: "box" as const,
  status: "preparing" as const,
  error: null,
  createdAt: "2026-09-06T12:00:00.000Z",
  avatar: { shape: 1, color: 2, face: 0 },
};

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readonly close = vi.fn();
  constructor(readonly url: string) { super(); FakeEventSource.instances.push(this); }
  emit(type: "invalidate" | "resync" | "unauthorized") { this.dispatchEvent(new Event(type)); }
}

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

describe("first Companion flow", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    FakeEventSource.instances = [];
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["/about", "Your AI companions. Give them something to do."],
    ["/privacy", "Privacy Policy"],
    ["/terms", "Terms of Use"],
  ])("serves %s publicly without an authentication request", (path, heading) => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", path);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<App />);
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(9_000));
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a deleted companion from navigation and returns home", async () => {
    window.history.replaceState({}, "", "/companions/ada");
    const ready = {...companion,status:"ready"};
    let deleted = false;
    const fetchMock=vi.fn((input:RequestInfo|URL,options?:RequestInit)=>{
      const path=String(input);
      if(path==="/api/me") return response(me);
      if(path==="/api/config") return response(config);
      if(path==="/api/companions") return response({companions:deleted?[{...ready,id:"june",name:"June"}]:[ready,{...ready,id:"june",name:"June"}]});
      if(path==="/api/companions/ada" && options?.method==="DELETE") {deleted=true;return response({deleted:true,companionIds:["ada"]},202);}
      if(path==="/api/companions/ada") return response({companion:ready,messages:[],runs:[],activity:[]});
      if(path==="/api/plugins") return response({catalog:[],accounts:[]});
      if(path==="/api/companions/ada/plugins") return response({accounts:[]});
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch",fetchMock);
    const user=userEvent.setup();render(<App/>);
    await user.click(await screen.findByRole("button",{name:"Settings"}));
    await user.click(screen.getByRole("button",{name:"Delete…"}));
    await user.click(screen.getByRole("button",{name:"Delete companion"}));
    expect(await screen.findByRole("heading",{name:"Your companions."})).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("textbox",{name:"Message Ada"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:/Ada, Companion/})).not.toBeInTheDocument();
    expect(screen.getAllByRole("button",{name:/June, Companion/}).length).toBeGreaterThan(0);
  });

  it("refreshes Team from the Companion event stream while it stays open", async () => {
    window.history.replaceState({}, "", "/companions/ada?view=team");
    const template={id:"writer",name:"Writer",instructions:"Write the update",revision:1,avatar:{shape:0,color:0,face:0},sourceCompanionId:null,hasSnapshot:false};
    let authorized=false;
    vi.stubGlobal("EventSource",FakeEventSource);
    vi.stubGlobal("fetch",vi.fn((input:RequestInfo|URL)=>{
      const path=String(input);
      if(path==="/api/me")return response(me);
      if(path==="/api/config")return response(config);
      if(path==="/api/companions")return response({companions:[companion]});
      if(path==="/api/companions/ada")return response({companion,messages:[],runs:[],activity:[]});
      if(path==="/api/templates")return response({templates:[template]});
      if(path==="/api/companions/ada/templates")return response({templates:authorized?[{templateId:template.id,name:template.name,revision:1,maxChildren:2}]:[]});
      if(path==="/api/companions/ada/replicas")return response({replicas:[]});
      throw Error(`Unexpected request: ${path}`);
    }));
    render(<App/>);
    await screen.findByRole("button",{name:"Add specialist"});
    expect(screen.queryByText("Write the update")).not.toBeInTheDocument();
    authorized=true;
    act(()=>FakeEventSource.instances[0].emit("invalidate"));
    expect(await screen.findByText("Write the update", {selector:".team-person p"})).toBeInTheDocument();
    expect(window.location.search).toBe("?view=team");
  });

  it.each([200, 401])("ignores a late %s detail response after switching Companions", async (status) => {
    window.history.replaceState({}, "", "/companions/ada");
    const other = {...companion, id:"other",name:"June",status:"ready" as const};
    let hold = false;
    let release: ((response: Response) => void) | undefined;
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn((input:RequestInfo|URL) => {
      const path=String(input);
      if(path==="/api/me")return response(me);
      if(path==="/api/config")return response(config);
      if(path==="/api/companions")return response({companions:[companion,other]});
      if(path==="/api/companions/other")return response({companion:other,messages:[],runs:[],activity:[]});
      if(path==="/api/companions/ada"){
        if(hold){hold=false;return new Promise<Response>(resolve=>{release=resolve;});}
        return response({companion,messages:[],runs:[],activity:[]});
      }
      throw Error(`Unexpected request: ${path}`);
    }));
    const user=userEvent.setup();render(<App/>);
    await screen.findByRole("textbox",{name:"Message Ada"});
    hold=true;
    act(()=>FakeEventSource.instances[0].emit("invalidate"));
    await waitFor(()=>expect(release).toBeDefined());
    await user.click(screen.getByRole("button",{name:/June, Companion/}));
    await screen.findByRole("textbox",{name:"Message June"});
    await act(async()=>{release!(new Response(JSON.stringify(status===200?{companion,messages:[],runs:[],activity:[]}:{error:"Expired old request"}),{status}));});
    expect(screen.getByRole("textbox",{name:"Message June"})).toBeInTheDocument();
    expect(screen.queryByRole("textbox",{name:"Email"})).not.toBeInTheDocument();
  });

  it("refreshes durable chat snapshots after coalesced events and closes revoked streams", async () => {
    window.history.replaceState({}, "", "/companions/ada");
    const ready = { ...companion, status: "ready" as const };
    let detailRequests = 0;
    let holdRefresh = false;
    let recovered = false;
    let releaseRefresh: (() => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response(config);
      if (path === "/api/companions") return response({ companions: [ready] });
      if (path === "/api/companions/ada") {
        detailRequests++;
        if (holdRefresh) { holdRefresh = false; return new Promise<Response>(resolve => { releaseRefresh = () => resolve(new Response(JSON.stringify({ companion: ready, messages: [], runs: [], activity: [] }), { headers: { "content-type": "application/json" } })); }); }
        return response({ companion: ready, messages: recovered ? [{ id: "persisted", role: "assistant", content: "Recovered after reconnect", createdAt: companion.createdAt, runId: "run-persisted" }] : [], runs: [], activity: [] });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<App />);
    expect(await screen.findByRole("textbox", { name: "Message Ada" })).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/companions/ada/events");

    const baselineRequests = detailRequests;
    holdRefresh = true;
    FakeEventSource.instances[0].emit("invalidate");
    FakeEventSource.instances[0].emit("invalidate");
    FakeEventSource.instances[0].emit("resync");
    await waitFor(() => expect(detailRequests).toBe(baselineRequests + 1));
    recovered = true;
    releaseRefresh?.();
    await waitFor(() => expect(detailRequests).toBe(baselineRequests + 2));
    expect(await screen.findByText("Recovered after reconnect")).toBeInTheDocument();

    FakeEventSource.instances[0].emit("unauthorized");
    expect(await screen.findByRole("heading", { name: /Your Companions, ready when you are/ })).toBeInTheDocument();
    expect(FakeEventSource.instances[0].close).toHaveBeenCalled();
  });

  it("creates a named Box Companion and opens its durable chat", async () => {
    let created = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/plugins") return response({catalog:[],accounts:[]});
      if (path === "/api/templates") return response({templates:[]});
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response(config);
      if (path === "/api/companions" && options?.method === "POST") {
        created = true;
        return response({ companion });
      }
      if (path === "/api/companions") return response({ companions: created ? [companion] : [] });
      if (path === "/api/companions/ada") return response({ companion, messages: [], runs: [], activity: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Create your first Companion" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Role"), "Research customer questions.");
    await user.click(screen.getByText(/^Advanced:/));
    await user.click(screen.getByText("Persistent cloud computer"));
    await user.click(screen.getByRole("button", { name: "Create companion" }));

    expect(await screen.findByRole("heading", { name: "A little less on your mind." })).toBeInTheDocument();
    expect(screen.getByText(/Messages will wait safely/)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/companions/ada");
    await user.click(screen.getByRole("button", { name: "Plan my day" }));
    expect(screen.getByRole("textbox", { name: "Message Ada" })).toHaveValue("Plan my day");
    expect(screen.getByRole("textbox", { name: "Message Ada" })).toHaveFocus();
    expect(fetchMock.mock.calls.some(([path, options]) => String(path).endsWith("/messages") && options?.method === "POST")).toBe(false);

    const createCall = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(createCall?.[1]?.body as string)).toEqual({
      clientCreationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      prepare: false,
      name: "Ada",
      instructions: "Research customer questions.",
      provider: "box",
      avatar: { shape: 1, color: 2, face: 0 },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/companions/ada",
      expect.objectContaining({ credentials: "same-origin" }),
    ));
  });

  it("reuses one creation id when the response is lost and the user retries",async()=>{
    const bodies:Array<Record<string,unknown>>=[];let attempts=0,persisted=false;
    const fetchMock=vi.fn((input:RequestInfo|URL,options?:RequestInit)=>{
      const path=String(input);
      if (path === "/api/plugins") return response({catalog:[],accounts:[]});
      if(path==="/api/me")return response(me);
      if(path==="/api/config")return response(config);
      if(path==="/api/templates")return response({templates:[]});
      if(path==="/api/companions"&&options?.method==="POST"){
        bodies.push(JSON.parse(String(options.body)));attempts++;
        if(attempts===1)return Promise.reject(new Error("Response lost"));
        persisted=true;return response({companion});
      }
      if(path==="/api/companions")return response({companions:persisted?[companion]:[]});
      if(path==="/api/companions/ada")return response({companion,messages:[],runs:[],activity:[]});
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch",fetchMock);const user=userEvent.setup();render(<App/>);
    await user.type(await screen.findByLabelText("Name"),"Ada");await user.type(screen.getByLabelText("Role"),"Research customer questions.");
    await user.click(screen.getByRole("button",{name:"Create companion"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Response lost");
    await user.click(screen.getByRole("button",{name:"Resume setup"}));
    expect(await screen.findByRole("heading",{name:"A little less on your mind."})).toBeInTheDocument();
    expect(bodies).toHaveLength(2);expect(bodies[0].clientCreationId).toMatch(/^[0-9a-f-]{36}$/);expect(bodies[1].clientCreationId).toBe(bodies[0].clientCreationId);
  });

  it("shows a recoverable error when initial configuration fails", async () => {
    let unavailable = true;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/plugins") return response({catalog:[],accounts:[]});
      if (path === "/api/templates") return response({templates:[]});
      if (path === "/api/me") return response(me);
      if (path === "/api/config" && unavailable) return Promise.reject(new Error("Service unavailable"));
      if (path === "/api/config") return response(config);
      if (path === "/api/companions") return response({ companions: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Couldn’t load companions.build" })).toBeInTheDocument();
    expect(screen.getByText("Service unavailable")).toBeInTheDocument();

    unavailable = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Create your first Companion" })).toBeInTheDocument();
  });

  it("presents an archived persistent Companion as sleeping", async () => {
    const sleeping = { ...companion, status: "archived" as const };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response(config);
      if (path === "/api/companions") return response({ companions: [sleeping] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(await screen.findByRole("button", { name: /Ada, Companion · Sleeping/ })).toBeInTheDocument();
  });

  it("keeps send available during active work and clears drafts when switching Companions", async () => {
    window.history.replaceState({}, "", "/companions/ada");
    const browserCompanion = {
      ...companion,
      id: "browser",
      name: "Browser",
      provider: "local" as const,
      status: "ready" as const,
    };
    const adaReady = { ...companion, status: "ready" as const };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response(config);
      if (path === "/api/companions") return response({ companions: [adaReady, browserCompanion] });
      if (path === "/api/companions/ada") {
        return response({
          companion: adaReady,
          messages: [],
          runs: [{ id: "run-active", status: "running", error: null, createdAt: companion.createdAt }, { id: "review", lane: "background", status: "succeeded", resultText: "Reviewed the specialist's report.", error: null, createdAt: companion.createdAt }],
          files: [{ id: "report", runId: "review", kind: "agent_output", name: "report.md", mimeType: "text/markdown", size: 24, url: "/api/companions/ada/files/report" }],
          activity: [],
        });
      }
      if (path === "/api/companions/browser") {
        return response({ companion: browserCompanion, messages: [], runs: [], activity: [] });
      }
      if(path==="/api/companions/ada/tasks?limit=20")return response({tasks:[{id:"review",title:"Review the report",status:"succeeded",lane:"background",source:"delegation",createdAt:companion.createdAt,finishedAt:companion.createdAt}],nextCursor:null});
      if(path==="/api/companions/ada/tasks/review")return response({task:{id:"review",title:"Review the report",content:"Review the report",status:"succeeded",lane:"background",source:"delegation",createdAt:companion.createdAt,finishedAt:companion.createdAt,resultText:"Reviewed the specialist's report.",error:null,cancelRequested:false,publishToChat:false},files:[{id:"report",runId:"review",kind:"agent_output",name:"report.md",mimeType:"text/markdown",size:24,url:"/api/companions/ada/files/report"}]});
      if (path === "/api/plugins") return response({ accounts: [], catalog: [] });
      if (path === "/api/companions/ada/plugins") return response({ accounts: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    const adaComposer = await screen.findByRole("textbox", { name: "Message Ada" });
    await user.type(adaComposer, "Queue this next");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.queryByRole("complementary", { name: "Activity" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByRole("region", { name: "Activity" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", {name:/Review the report/}));
    expect(window.location.search).toBe("?view=activity");
    expect(await screen.findByRole("link", { name: "report.md" })).toHaveAttribute("href", "/api/companions/ada/files/report");
    await user.click(screen.getByRole("button", { name: "Discussion" }));
    expect(screen.getByRole("textbox", { name: "Message Ada" })).toHaveValue("Queue this next");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("region", { name: "Companion settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Ada");
    await user.click(screen.getByRole("button", { name: "Discussion" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(window.location.search).toBe("?view=settings");
    expect(screen.getByRole("region", { name: "Applications" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Browser, Companion · Ready/ }));
    const browserComposer = await screen.findByRole("textbox", { name: "Message Browser" });
    expect(browserComposer).toHaveValue("");
  });

  it("guards unsaved settings before leaving for another Companion", async () => {
    window.history.replaceState({}, "", "/companions/ada");
    const browser = { ...companion, id:"browser", name:"Browser", status:"ready" as const };
    vi.stubGlobal("fetch", vi.fn((input:RequestInfo|URL) => {
      const path=String(input);
      if(path==="/api/me") return response(me);
      if(path==="/api/config") return response(config);
      if(path==="/api/companions") return response({companions:[companion,browser]});
      if(path==="/api/companions/ada") return response({companion,messages:[],runs:[],activity:[]});
      if(path==="/api/companions/browser") return response({companion:browser,messages:[],runs:[],activity:[]});
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user=userEvent.setup(); render(<App/>);
    await user.click(await screen.findByRole("button",{name:"Settings"}));
    await user.type(screen.getByLabelText("Role")," Keep this draft.");
    await user.click(screen.getByRole("button",{name:/Browser, Companion/}));
    expect(screen.getByRole("heading",{name:"Keep your changes?"})).toBeInTheDocument();
    expect(window.location.pathname).toBe("/companions/ada");
    await user.click(screen.getByRole("button",{name:"Keep editing"}));
    expect(screen.getByLabelText("Role")).toHaveValue("Research customer questions. Keep this draft.");
    await user.click(screen.getByRole("button",{name:/Browser, Companion/}));
    await user.click(screen.getByRole("button",{name:"Discard changes"}));
    expect(await screen.findByRole("textbox",{name:"Message Browser"})).toBeInTheDocument();
  });

  it("guards an unsaved settings draft when browser history leaves the Companion", async () => {
    const browser = { ...companion, id:"browser", name:"Browser", status:"ready" as const };
    window.history.replaceState({}, "", "/companions/browser");
    window.history.pushState({}, "", "/companions/ada");
    vi.stubGlobal("fetch", vi.fn((input:RequestInfo|URL) => {
      const path=String(input);
      if(path==="/api/me") return response(me);
      if(path==="/api/config") return response(config);
      if(path==="/api/companions") return response({companions:[companion,browser]});
      if(path==="/api/companions/ada") return response({companion,messages:[],runs:[],activity:[]});
      if(path==="/api/companions/browser") return response({companion:browser,messages:[],runs:[],activity:[]});
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user=userEvent.setup(); render(<App/>);
    await user.click(await screen.findByRole("button",{name:"Settings"}));
    await user.type(screen.getByLabelText("Role"), " Keep this draft.");

    act(() => window.history.back());
    expect(await screen.findByRole("textbox",{name:"Message Ada"})).toBeInTheDocument();
    expect(window.location.search).toBe("");
    act(() => window.history.back());
    expect(await screen.findByRole("heading",{name:"Keep your changes?"})).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/companions/ada"));
    expect(window.location.search).toBe("");
    await user.click(screen.getByRole("button",{name:"Keep editing"}));
    expect(screen.getByLabelText("Role")).toHaveValue("Research customer questions. Keep this draft.");

    act(() => window.history.back());
    await user.click(await screen.findByRole("button",{name:"Discard changes"}));
    expect(await screen.findByRole("textbox",{name:"Message Browser"})).toBeInTheDocument();
  });

  it("reloads authoritative application selection and reports mutation failures", async () => {
    window.history.replaceState({}, "", "/companions/ada?view=applications");
    const accounts=[
      {id:"github",serverId:"github",label:"Work GitHub",provider:"github",healthStatus:"ok",healthCode:null,checkedAt:null},
      {id:"linear",serverId:"linear",label:"Work Linear",provider:"linear",healthStatus:"ok",healthCode:null,checkedAt:null},
    ];
    let selected=false; let attempts=0; let rejectFirst!:(cause:Error)=>void;
    vi.stubGlobal("fetch",vi.fn((input:RequestInfo|URL,options?:RequestInit)=>{
      const path=String(input);
      if(path==="/api/me") return response(me);
      if(path==="/api/config") return response(config);
      if(path==="/api/companions") return response({companions:[companion]});
      if(path==="/api/companions/ada") return response({companion,messages:[],runs:[],activity:[]});
      if(path==="/api/plugins") return response({accounts,catalog:[]});
      if(path==="/api/companions/ada/plugins"&&!options?.method) return response({accounts:selected?[accounts[0]]:[]});
      if(path==="/api/companions/ada/plugins/github"&&options?.method==="PUT") {
        attempts+=1;
        if(attempts===1) return new Promise<Response>((_resolve,reject)=>{rejectFirst=reject;});
        selected=true; return response({ok:true});
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user=userEvent.setup(); render(<App/>);
    const github=await screen.findByRole("checkbox",{name:/Work GitHub/});
    const linear=screen.getByRole("checkbox",{name:/Work Linear/});
    fireEvent.click(github);
    fireEvent.click(github);
    await waitFor(()=>expect(github).toBeDisabled()); expect(linear).toBeDisabled();
    rejectFirst(new Error("Selection unavailable."));
    expect(await screen.findByRole("alert")).toHaveTextContent("Selection unavailable.");
    expect(github).not.toBeChecked();
    await user.click(github);
    await waitFor(()=>expect(github).toBeChecked());
    expect(attempts).toBe(2);
  });

  it("links a temporary specialist beneath the task that created it without adding it to Team", async () => {
    window.history.replaceState({}, "", "/companions/ada");
    const ready = { ...companion, status: "ready" as const };
    const specialist = { ...ready, id: "specialist", name: "Researcher", temporary: true, parentId: "ada", retiredAt: companion.createdAt };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response(config);
      if (path === "/api/companions") return response({ companions: [ready] });
      if (path === "/api/companions/ada") return response({
        companion: ready,
        messages: [{ id: "message-parent", role: "user", content: "Compare the vendors", createdAt: companion.createdAt, runId: "run-parent" }],
        runs: [
          { id: "run-parent", status: "succeeded", error: null, createdAt: companion.createdAt },
          { id: "run-background", lane: "background", status: "running", error: null, createdAt: companion.createdAt },
        ],
        specialists: [
          { delegationId: "delegation-1", parentRunId: "run-parent", childRunId: "run-child", companion: { id: specialist.id, name: specialist.name, avatar: specialist.avatar, status: specialist.status, retiredAt: specialist.retiredAt } },
          { delegationId: "delegation-2", parentRunId: "run-background", childRunId: "run-analyst", companion: { id: "analyst", name: "Analyst", avatar: specialist.avatar, status: "preparing", retiredAt: null } },
        ],
        activity: [],
      });
      if(path==="/api/companions/ada/tasks?limit=20")return response({tasks:[{id:"run-background",title:"Review vendors",status:"running",lane:"background",source:"delegation",createdAt:companion.createdAt,finishedAt:null}],nextCursor:null});
      if(path==="/api/companions/ada/tasks/run-background")return response({task:{id:"run-background",title:"Review vendors",content:"Review vendors",status:"running",lane:"background",source:"delegation",createdAt:companion.createdAt,finishedAt:null,resultText:null,error:null,cancelRequested:false,publishToChat:false},files:[]});
      if (path === "/api/companions/specialist") return response({ companion: specialist, messages: [{ id: "child-result", role: "assistant", content: "Vendor landscape complete.", createdAt: companion.createdAt, runId: "run-child", files: [{ id: "child-file", runId: "run-child", kind: "agent_output", name: "vendors.md", mimeType: "text/markdown", size: 12, url: "/api/companions/specialist/files/child-file" }] }], runs: [], specialists: [], activity: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); render(<App />);

    expect(await screen.findByText("Compare the vendors")).toBeInTheDocument();
    const specialistLink = screen.getByRole("button", { name: "Open Researcher's chat" });
    expect(specialistLink).toHaveTextContent("Researcher");
    expect(specialistLink).toHaveTextContent("Finished");
    expect(screen.getAllByRole("img", { name: "Ada, Companion" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Researcher.*Sleeping/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Analyst's chat" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Activity" }));
    await user.click(await screen.findByRole("button", {name:/Review vendors/}));
    expect(await screen.findByRole("button", { name: "Open Analyst's discussion" })).toHaveTextContent("Preparing");
    expect(screen.queryByRole("button", { name: "Open Researcher's chat" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discussion" }));

    await user.click(specialistLink);
    expect(await screen.findByText("Vendor landscape complete.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "vendors.md" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Researcher" }).parentElement).toHaveTextContent("Finished");
    expect(screen.queryByRole("textbox", { name: "Message Researcher" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desktop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Activity" })).toHaveLength(1);
    expect(window.location.pathname).toBe("/companions/specialist");
  });

  it("keeps a normally archived permanent Companion wakeable from chat", async () => {
    window.history.replaceState({}, "", "/companions/ada");
    const archived = { ...companion, status: "archived" as const, retiredAt: null, temporary: false };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response(config);
      if (path === "/api/companions") return response({ companions: [archived] });
      if (path === "/api/companions/ada") return response({ companion: archived, messages: [], runs: [], specialists: [], activity: [] });
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(<App />);

    expect(await screen.findByRole("textbox", { name: "Message Ada" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ada, Companion.*Sleeping/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("region", { name: "Companion settings" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open desktop" }));
    expect(screen.getByRole("button", { name: /Open desktop/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings for Ada" })).not.toBeInTheDocument();
  });

  it("drops files through the durable upload path and preserves the draft for an exact retry", async () => {
    window.history.replaceState({}, "", "/companions/ada");
    const ready = { ...companion, status: "ready" as const };
    const admissions: Array<{ clientMessageId: string }> = [];
    const fileIds: string[] = []; let uploadAttempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response(config);
      if (path === "/api/templates") return response({ templates: [] });
      if (path === "/api/companions") return response({ companions: [ready] });
      if (path === "/api/companions/ada" && !options?.method) return response({ companion: ready, messages: [], runs: [], activity: [] });
      if (path === "/api/companions/ada/messages") { admissions.push(JSON.parse(String(options?.body))); return response({ runId: "run-files" }, 202); }
      if (path === "/api/companions/ada/runs/run-files/files") {
        uploadAttempts++; const form = options?.body as FormData; fileIds.push(String(form.get("clientFileId")));
        return uploadAttempts === 1 ? response({ error: "File storage is temporarily unavailable." }, 503) : response({ file: { id: "file-1" } }, 201);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Message Ada" });
    await user.type(composer, "Review the brief");
    const form = composer.closest("form")!;
    const file = new File(["brief"], "brief.txt", { type: "text/plain", lastModified: 7 });
    fireEvent.dragEnter(form, { dataTransfer: { files: [file], types: ["Files"] } });
    expect(screen.getByText("Drop files here")).toBeInTheDocument();
    fireEvent.drop(form, { dataTransfer: { files: [file], types: ["Files"] } });
    expect(screen.queryByText("Drop files here")).not.toBeInTheDocument();
    expect(screen.getByText("brief.txt")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("File storage is temporarily unavailable.");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(composer).toHaveValue("Review the brief");
    expect(screen.getByText("brief.txt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(composer).toHaveValue(""));
    expect(admissions).toHaveLength(2);
    expect(admissions[1].clientMessageId).toBe(admissions[0].clientMessageId);
    expect(fileIds[1]).toBe(fileIds[0]);
  });

  it("rejects an oversized drop without changing the draft or attachments", async () => {
    window.history.replaceState({}, "", "/companions/ada");
    const ready = { ...companion, status: "ready" as const };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response(config);
      if (path === "/api/templates") return response({ templates: [] });
      if (path === "/api/companions") return response({ companions: [ready] });
      if (path === "/api/companions/ada") return response({ companion: ready, messages: [], runs: [], activity: [] });
      throw new Error(`Unexpected request: ${path}`);
    }));
    const user = userEvent.setup(); render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Message Ada" }); await user.type(composer, "Keep this draft");
    const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.pdf", { type: "application/pdf" });
    fireEvent.drop(composer.closest("form")!, { dataTransfer: { files: [oversized], types: ["Files"] } });
    expect(screen.getByRole("alert")).toHaveTextContent("Each file must be between 1 byte and 10 MB.");
    expect(composer).toHaveValue("Keep this draft");
    expect(screen.queryByText("large.pdf")).not.toBeInTheDocument();
  });

  it("requests a Better Auth magic link and offers the local Mailpit inbox", async () => {
    window.history.replaceState({}, "", "/login");
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me") return response({ error: "Authentication required" }, 401);
      if (path === "/api/auth/sign-in/magic-link" && options?.method === "POST") return response({ status: true });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Email"), "alex@example.com");
    await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open local inbox" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-in/magic-link", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ email: "alex@example.com", callbackURL: "/" }),
    }));
  });

  it("opens the real private-beta login from the public landing page", async () => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/me") return response({ error: "Authentication required" }, 401);
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Your AI companions. Give them something to do." })).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /Log in to private beta/ })[0]);
    expect(window.location.pathname).toBe("/login");
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  });

  it("completes OAuth in a popup, refreshes owned connections, and disables unavailable providers",async()=>{
    window.history.replaceState({},"","/connections");
    const account={id:"account-1",serverId:"app.linear/linear",label:"Default",provider:"linear"};let completed=false;
    const fetchMock=vi.fn((input:RequestInfo|URL,options?:RequestInit)=>{
      const path=String(input);
      if(path==="/api/me")return response(me);
      if(path==="/api/config")return response(config);
      if(path==="/api/companions")return response({companions:[]});
      if(path==="/api/plugins/connect"&&options?.method==="POST")return response({url:"https://oauth.example/authorize"});
      if(path==="/api/plugins/account-1"&&options?.method==="DELETE"){completed=false;return response({ok:true});}
      if(path==="/api/plugins")return response({catalog:[
        {id:"app.linear/linear",name:"Linear",provider:"linear",available:true},
        {id:"io.github.github/github-mcp-server",name:"GitHub",provider:"github",available:false},
      ],accounts:completed?[account]:[]});
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch",fetchMock);
    const popup={closed:false,location:{href:""},close:vi.fn()};vi.spyOn(window,"open").mockReturnValue(popup as unknown as Window);
    const user=userEvent.setup();render(<App/>);
    await user.click(await screen.findByRole("button",{name:"Connect"}));
    await waitFor(()=>expect(popup.location.href).toBe("https://oauth.example/authorize"));
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/connect",expect.objectContaining({method:"POST",body:JSON.stringify({serverId:"app.linear/linear",label:""})}));
    expect(screen.getByRole("button",{name:"Unavailable"})).toBeDisabled();
    completed=true;window.dispatchEvent(new MessageEvent("message",{origin:window.location.origin,source:popup as unknown as Window,data:{type:"companions:plugin-oauth",status:"connected"}}));
    expect(await screen.findByText("Connection added.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Linear" })).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    await user.click(await screen.findByRole("button",{name:"Manage Default"}));
    await user.click(screen.getByRole("button",{name:"Disconnect"}));
    await user.click(screen.getByRole("button",{name:"Confirm disconnect Default"}));
    expect(await screen.findByText("Connection removed.")).toBeInTheDocument();
    await waitFor(()=>expect(screen.queryByRole("button",{name:"Manage Default"})).not.toBeInTheDocument());
  });

  it("asks for a name before adding another provider account and renames the first account",async()=>{
    window.history.replaceState({},"","/connections");
    let account={id:"linear-default",serverId:"app.linear/linear",label:"Default",provider:"linear",healthStatus:"unchecked",healthCode:null,checkedAt:null};
    const bodies:unknown[]=[];
    const fetchMock=vi.fn((input:RequestInfo|URL,options?:RequestInit)=>{
      const path=String(input);
      if(path==="/api/me")return response(me);
      if(path==="/api/config")return response(config);
      if(path==="/api/companions")return response({companions:[]});
      if(path==="/api/plugins")return response({catalog:[{id:"app.linear/linear",name:"Linear",provider:"linear",available:true}],accounts:[{...account,usedBy:[{id:"nova",name:"Nova",avatar:{shape:1,color:2,face:0}}]}]});
      if(path==="/api/plugins/connect"&&options?.method==="POST"){bodies.push(JSON.parse(String(options.body)));return response({url:"https://oauth.example/authorize"});}
      if(path==="/api/plugins/linear-default"&&options?.method==="PATCH"){const {label}=JSON.parse(String(options.body));account={...account,label};return response({account});}
      throw Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch",fetchMock);
    const popup={closed:false,location:{href:""},close:vi.fn()};vi.spyOn(window,"open").mockReturnValue(popup as unknown as Window);
    const user=userEvent.setup();render(<App/>);
    await user.click(await screen.findByRole("button",{name:"Add account"}));
    expect(screen.getByRole("textbox",{name:"Account name"})).toHaveFocus();
    expect(bodies).toHaveLength(0);
    await user.click(screen.getByRole("button",{name:"Cancel"}));
    expect(screen.queryByRole("textbox",{name:"Account name"})).not.toBeInTheDocument();
    expect(bodies).toHaveLength(0);
    await user.click(screen.getByRole("button",{name:"Add account"}));
    await user.type(screen.getByRole("textbox",{name:"Account name"}),"Client workspace");
    await user.click(screen.getByRole("button",{name:"Connect account"}));
    expect(bodies).toEqual([{serverId:"app.linear/linear",label:"Client workspace"}]);
    window.dispatchEvent(new MessageEvent("message",{origin:window.location.origin,source:popup as unknown as Window,data:{type:"companions:plugin-oauth",status:"cancelled"}}));
    expect(await screen.findByText("Connection cancelled.")).toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"Manage Default"}));
    await user.click(screen.getByRole("button",{name:"Rename account"}));
    const rename=screen.getByRole("textbox",{name:"Account name"});
    await user.clear(rename);await user.type(rename,"Personal");
    await user.click(screen.getByRole("button",{name:"Save name"}));
    expect(await screen.findByText("Personal saved.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Linear" })).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
    expect(screen.getByRole("link",{name:"Open Nova"})).toHaveAttribute("href","/companions/nova");
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/linear-default",expect.objectContaining({method:"PATCH",body:JSON.stringify({label:"Personal"})}));
  });

  it("checks connection health, shows safe persisted states, and reuses OAuth for recovery",async()=>{
    window.history.replaceState({},"","/connections");
    const checkedAt="2026-09-07T12:00:00.000Z";
    const accounts=[
      {id:"linear-account",serverId:"app.linear/linear",label:"Linear work",provider:"linear",healthStatus:"unchecked",healthCode:null,checkedAt:null},
      {id:"github-account",serverId:"io.github.github/github-mcp-server",label:"GitHub client",provider:"github",healthStatus:"error",healthCode:"authorization_required",checkedAt},
      {id:"custom-account",serverId:null,label:"Local tools",provider:"custom",healthStatus:"requires_agent",healthCode:"agent_check_required",checkedAt},
    ];
    const fetchMock=vi.fn((input:RequestInfo|URL,options?:RequestInit)=>{
      const path=String(input);
      if(path==="/api/me")return response(me);
      if(path==="/api/config")return response(config);
      if(path==="/api/companions")return response({companions:[]});
      if(path==="/api/plugins")return response({catalog:[
        {id:"app.linear/linear",name:"Linear",provider:"linear",available:true},
        {id:"io.github.github/github-mcp-server",name:"GitHub",provider:"github",available:true},
      ],accounts});
      if(path==="/api/plugins/accounts/linear-account/check"&&options?.method==="POST")return response({account:{id:"linear-account",healthStatus:"ok",healthCode:null,checkedAt}});
      if(path==="/api/plugins/connect"&&options?.method==="POST")return response({url:"https://oauth.example/reconnect"});
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch",fetchMock);
    const popup={closed:false,location:{href:""},close:vi.fn()};vi.spyOn(window,"open").mockReturnValue(popup as unknown as Window);
    const user=userEvent.setup();render(<App/>);
    expect(await screen.findByText("Authorization needed",{exact:false})).toBeInTheDocument();
    expect(screen.getByText("Checked inside a Companion when used")).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Check Local tools"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Check connection"})).not.toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"Manage Linear work"}));
    await user.click(screen.getByRole("button",{name:"Check connection"}));
    expect(await screen.findByText(/^Linear work: Connection ready/)).toBeInTheDocument();
    expect(screen.getByText(/^Connection ready/).textContent).toContain(" · ");
    expect(screen.getByText("Linear work")).toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Manage Linear work"})).toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"Reconnect"}));
    await waitFor(()=>expect(popup.location.href).toBe("https://oauth.example/reconnect"));
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/connect",expect.objectContaining({method:"POST",body:JSON.stringify({serverId:"io.github.github/github-mcp-server",label:"GitHub client"})}));
  });

  it("adds HTTP and stdio MCP servers with write-only secret values", async () => {
    window.history.replaceState({}, "", "/connections");
    const bodies: unknown[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response(config);
      if (path === "/api/companions") return response({ companions: [] });
      if (path === "/api/plugins") return response({ catalog: [], accounts: [] });
      if (path === "/api/templates") return response({ templates: [] });
      if (path === "/api/plugins/custom" && options?.method === "POST") { bodies.push(JSON.parse(String(options.body))); return response({ id: crypto.randomUUID() }, 201); }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); render(<App />);

    await user.click(await screen.findByRole("button", { name: "Custom MCP server" }));
    await user.type(screen.getByLabelText("Name"), "Private API");
    await user.type(screen.getByLabelText("Server URL"), "https://mcp.example/tools");
    await user.click(screen.getByText("Request headers"));
    await user.click(screen.getByRole("button", { name: "Add header" }));
    await user.type(screen.getByLabelText("Header 1 name"), "Authorization");
    const headerSecret = screen.getByLabelText("Header 1 secret value");
    expect(headerSecret).toHaveAttribute("type", "password");
    await user.type(headerSecret, "Bearer private-value");
    await user.click(screen.getByRole("button", { name: "Add server" }));

    await user.click(await screen.findByRole("button", { name: "Custom MCP server" }));
    await user.type(screen.getByLabelText("Name"), "Local tools");
    await user.selectOptions(screen.getByLabelText("Transport"), "stdio");
    await user.type(screen.getByLabelText("Command"), "/usr/local/bin/tools-mcp");
    await user.type(screen.getByLabelText(/Arguments/), "--workspace{enter}/home/agent/workspace");
    await user.click(screen.getByText("Environment variables"));
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    await user.type(screen.getByLabelText("Variable 1 name"), "API_TOKEN");
    await user.type(screen.getByLabelText("Variable 1 secret value"), "stdio-private-value");
    await user.click(screen.getByRole("button", { name: "Add server" }));

    expect(bodies).toEqual([
      { label: "Private API", transport: "http", url: "https://mcp.example/tools", headers: { Authorization: "Bearer private-value" } },
      { label: "Local tools", transport: "stdio", command: "/usr/local/bin/tools-mcp", args: ["--workspace", "/home/agent/workspace"], env: { API_TOKEN: "stdio-private-value" } },
    ]);
    expect(screen.queryByDisplayValue("Bearer private-value")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("stdio-private-value")).not.toBeInTheDocument();
  });

  it("prefills and pins a selected template when creating a Companion", async () => {
    const template = { id: "template-1", name: "Research lead", instructions: "Investigate the market", avatar: { shape: 3, color: 4, face: 2 }, revision: 7, sourceCompanionId: null, hasSnapshot: true };
    let body: Record<string, unknown> | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/plugins") return response({catalog:[],accounts:[]});
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response(config);
      if (path === "/api/templates") return response({ templates: [template] });
      if (path === "/api/companions" && options?.method === "POST") { body = JSON.parse(String(options.body)); return response({ companion }); }
      if (path === "/api/companions") return response({ companions: [] });
      if (path === "/api/companions/ada") return response({ companion, messages: [], runs: [], activity: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByText(/^Advanced:/));
    await user.selectOptions(await screen.findByLabelText("Start from"), "template-1");
    expect(screen.getByLabelText("Name")).toHaveValue("Research lead");
    expect(screen.getByLabelText("Role")).toHaveValue("Investigate the market");
    expect(screen.getByRole("radio", { name: /Local/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Persistent cloud computer/ })).toBeChecked();
    await user.clear(screen.getByLabelText("Name")); await user.type(screen.getByLabelText("Name"), "Client researcher");
    await user.click(screen.getByRole("button", { name: "Create companion" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ name: "Client researcher", instructions: "Investigate the market", provider: "box", templateId: "template-1", templateRevision: 7, avatar: template.avatar });
  });

  it.each([
    ["cancelled","Connection cancelled."],
    ["error","Connection could not be completed. Try again."],
  ])("handles a safe %s OAuth callback result",async(status,message)=>{
    window.history.replaceState({},"",`/connections?connection=${status}`);
    vi.stubGlobal("fetch",vi.fn((input:RequestInfo|URL)=>{
      const path=String(input);if(path==="/api/me")return response(me);if(path==="/api/config")return response(config);if(path==="/api/companions")return response({companions:[]});if(path==="/api/plugins")return response({catalog:[],accounts:[]});throw new Error(`Unexpected request: ${path}`);
    }));
    render(<App/>);expect(await screen.findByText(message)).toBeInTheDocument();expect(window.location.search).toBe("");
  });
});


it("preserves the configured default model when editing only a Companion identity",async()=>{
 window.history.replaceState({},"","/companions/ada");
 const fetchMock=vi.fn((input:RequestInfo|URL,options?:RequestInit)=>{
  const path=String(input);
  if(path==="/api/me")return response(me);
  if(path==="/api/config")return response({...config,models:[{id:"different-model",name:"Another model"}]});
  if(path==="/api/companions")return response({companions:[companion]});
  if(path==="/api/companions/ada")return response(options?.method==="PATCH"?{companion}:{companion:{...companion,modelId:null},messages:[],runs:[],activity:[]});
  throw new Error(`Unexpected request: ${path}`);
 });
 vi.stubGlobal("fetch",fetchMock);const user=userEvent.setup();render(<App/>);
 await user.click(await screen.findByRole("button",{name:"Settings"}));
 expect(screen.getByLabelText("Model")).toHaveValue("");
 await user.clear(screen.getByLabelText("Name"));await user.type(screen.getByLabelText("Name"),"Ada renamed");
 await user.click(screen.getByRole("button",{name:"Discussion"}));
 await user.click(screen.getByRole("button",{name:"Settings"}));
 expect(screen.getByLabelText("Name")).toHaveValue("Ada renamed");
 await user.click(screen.getByRole("button",{name:"Save changes"}));
 await waitFor(()=>expect(fetchMock.mock.calls.some(([,options])=>options?.method==="PATCH")).toBe(true));
 const update=fetchMock.mock.calls.find(([,options])=>options?.method==="PATCH");
 expect(JSON.parse(update![1]!.body as string)).toEqual({name:"Ada renamed"});
});


it("opens automations directly, preserves the chat draft, and restores sections from history", async () => {
  window.history.replaceState({}, "", "/companions/ada");
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/me") return response(me);
    if (path === "/api/config") return response(config);
    if (path === "/api/companions") return response({ companions: [companion] });
    if (path === "/api/companions/ada") return response({ companion, messages: [], runs: [], activity: [] });
    if (path.endsWith("/routines")) return response({ routines: [] });
    if (path.endsWith("/triggers")) return response({ triggers: [] });
    if (path === "/api/plugins") return response({ accounts: [], catalog: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup(); render(<App />);
  await user.type(await screen.findByRole("textbox", { name: "Message Ada" }), "Keep this thought");
  await user.click(screen.getByRole("button", { name: "Automations" }));
  expect(window.location.search).toBe("?view=automations");
  expect(await screen.findByRole("button", { name: "New routine" })).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Message Ada" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New trigger" })).toBeInTheDocument();
  window.history.replaceState({}, "", "/companions/ada?view=automations");
  fireEvent.popState(window);
  expect(await screen.findByRole("button", { name: "New routine" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Discussion" }));
  expect(screen.getByRole("textbox", { name: "Message Ada" })).toHaveValue("Keep this thought");
  await user.click(screen.getByRole("button", { name: /^Ada, Companion ·/ }));
  expect(await screen.findByRole("textbox", { name: "Message Ada" })).toHaveValue("Keep this thought");
  expect(fetchMock.mock.calls.every(([path]) => !String(path).endsWith("/prepare"))).toBe(true);
});

// The disclosure uses ordinary buttons, so Tab follows the browser's native order.
it("operates connection actions by keyboard and closes on Escape, outside focus and pointer", async () => {
  const { ConnectionActions } = await import("./components/ConnectionActions");
  const check = vi.fn(), rename = vi.fn(async()=>true), disconnect = vi.fn();
  const user = userEvent.setup();
  render(<><ConnectionActions label="Work account" providerName="Linear" busy={false} onCheck={check} onRename={rename} onDisconnect={disconnect}/><button>Outside</button></>);
  const manage = screen.getByRole("button", { name: "Manage Work account" });
  manage.focus();
  await user.keyboard("{Enter}");
  expect(manage).toHaveAttribute("aria-expanded", "true");
  act(() => screen.getByRole("button", { name: "Check connection" }).focus());
  expect(screen.getByRole("button", { name: "Check connection" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(manage).toHaveFocus();
  expect(manage).toHaveAttribute("aria-expanded", "false");
  await user.click(manage);
  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(disconnect).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Keep connected" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(manage).toHaveFocus();
  await user.click(manage);
  expect(screen.queryByRole("button", { name: "Confirm disconnect Work account" })).not.toBeInTheDocument();
  act(() => screen.getByRole("button", { name: "Outside" }).focus());
  expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
  expect(manage).toHaveAttribute("aria-expanded", "false");
  await user.click(manage);
  fireEvent.pointerDown(document.body);
  expect(manage).toHaveAttribute("aria-expanded", "false");
  expect(check).not.toHaveBeenCalled();
  expect(disconnect).not.toHaveBeenCalled();
});

it("opens the shared libraries from the rail without losing unsaved settings", async () => {
  window.history.replaceState({}, "", "/companions/ada?view=settings");
  const profile={id:"writer",name:"Writer",instructions:"Write updates",revision:1,avatar:companion.avatar,sourceCompanionId:null,hasSnapshot:false};
  vi.stubGlobal("fetch",vi.fn((input:RequestInfo|URL)=>{
    const path=String(input);
    if(path==="/api/me")return response(me);
    if(path==="/api/config")return response(config);
    if(path==="/api/companions")return response({companions:[companion]});
    if(path==="/api/companions/ada")return response({companion,messages:[],runs:[],activity:[]});
    if(path==="/api/plugins")return response({catalog:[],accounts:[]});
    if(path==="/api/companions/ada/plugins")return response({accounts:[]});
    if(path==="/api/templates")return response({templates:[profile]});
    throw new Error(`Unexpected request ${path}`);
  }));
  const user=userEvent.setup();render(<App/>);
  await user.type(await screen.findByLabelText("Name")," draft");
  await user.click(screen.getByRole("button",{name:"Specialists"}));
  expect(await screen.findByRole("heading",{name:"Keep your changes?"})).toBeInTheDocument();
  expect(window.location.pathname).toBe("/companions/ada");
  await user.click(screen.getByRole("button",{name:"Keep editing"}));
  expect(screen.getByLabelText("Name")).toHaveValue("Ada draft");
  await user.click(screen.getByRole("button",{name:"Specialists"}));
  await user.click(screen.getByRole("button",{name:"Discard changes"}));
  expect(await screen.findByRole("heading",{name:"Specialists"})).toBeInTheDocument();
  expect(window.location.pathname).toBe("/specialists");
  expect(await screen.findByText("Writer")).toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:"Apps"}));
  expect(await screen.findByRole("heading",{name:"Apps"})).toBeInTheDocument();
  expect(window.location.pathname).toBe("/connections");
  vi.unstubAllGlobals();
});

it("keeps creation on screen until selected accounts finish saving", async () => {
  window.history.replaceState({}, "", "/new");
  const account={id:"work",serverId:"linear",provider:"linear",label:"Work workspace",healthStatus:"unchecked",healthCode:null,checkedAt:null};
  let releaseGrant!:()=>void;
  let created=false;
  vi.stubGlobal("fetch",vi.fn((input:RequestInfo|URL,options?:RequestInit)=>{
    const path=String(input);
    if(path==="/api/me")return response(me);
    if(path==="/api/config")return response(config);
    if(path==="/api/templates")return response({templates:[]});
    if(path==="/api/plugins")return response({catalog:[],accounts:[account]});
    if(path==="/api/companions"&&options?.method==="POST"){created=true;return response({companion});}
    if(path==="/api/companions")return response({companions:created?[companion]:[]});
    if(path==="/api/companions/ada")return response({companion,messages:[],runs:[],activity:[]});
    if(path==="/api/companions/ada/plugins/work")return new Promise<Response>(resolve=>{releaseGrant=()=>resolve(new Response(JSON.stringify({ok:true})));});
    throw new Error(`Unexpected request ${path}`);
  }));
  const user=userEvent.setup();render(<App/>);
  await user.type(await screen.findByLabelText("Name"),"Ada");
  await user.type(screen.getByLabelText("Role"),"Research customer questions.");
  await user.click(await screen.findByRole("checkbox",{name:"Work workspace"}));
  await user.click(screen.getByRole("button",{name:"Create companion"}));
  await waitFor(()=>expect(releaseGrant).toBeTypeOf("function"));
  await user.click(screen.getByRole("button",{name:"Apps"}));
  expect(window.location.pathname).toBe("/new");
  act(()=>{window.history.pushState({},"","/connections");window.dispatchEvent(new PopStateEvent("popstate"));});
  expect(window.location.pathname).toBe("/new");
  expect(screen.getByLabelText("Name")).toBeDisabled();
  await act(async()=>releaseGrant());
  expect(await screen.findByRole("textbox",{name:"Message Ada"})).toBeInTheDocument();
  expect(window.location.pathname).toBe("/companions/ada");
  vi.unstubAllGlobals();
});
