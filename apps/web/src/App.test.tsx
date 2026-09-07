import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

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
    await user.type(screen.getByLabelText("Mission"), "Research customer questions.");
    await user.click(screen.getByText("Persistent cloud computer"));
    await user.click(screen.getByRole("button", { name: "Create Companion" }));

    expect(await screen.findByRole("heading", { name: "What should Ada work on?" })).toBeInTheDocument();
    expect(screen.getByText(/Messages will wait safely/)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/companions/ada");

    const createCall = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(createCall?.[1]?.body as string)).toEqual({
      clientCreationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
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
    await user.type(await screen.findByLabelText("Name"),"Ada");await user.type(screen.getByLabelText("Mission"),"Research customer questions.");
    await user.click(screen.getByRole("button",{name:"Create Companion"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Response lost");
    await user.click(screen.getByRole("button",{name:"Create Companion"}));
    expect(await screen.findByRole("heading",{name:"What should Ada work on?"})).toBeInTheDocument();
    expect(bodies).toHaveLength(2);expect(bodies[0].clientCreationId).toMatch(/^[0-9a-f-]{36}$/);expect(bodies[1].clientCreationId).toBe(bodies[0].clientCreationId);
  });

  it("shows a recoverable error when initial configuration fails", async () => {
    let unavailable = true;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
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
    expect(await screen.findByRole("button", { name: /Ada, Companion Ada Sleeping/ })).toBeInTheDocument();
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
    expect(screen.getByRole("complementary", { name: "Activity" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "report.md" })).toHaveAttribute("href", "/api/companions/ada/files/report");
    await user.click(screen.getAllByRole("button", { name: "Close activity" }).at(-1)!);
    await user.click(screen.getByRole("button", { name: "Settings for Ada" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Identity" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getAllByRole("button", { name: "Close settings" }).at(-1)!);

    await user.click(screen.getByRole("button", { name: /Browser Ready/ }));
    const browserComposer = await screen.findByRole("textbox", { name: "Message Browser" });
    expect(browserComposer).toHaveValue("");
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
      if (path === "/api/companions/specialist") return response({ companion: specialist, messages: [], runs: [], specialists: [], activity: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); render(<App />);

    expect(await screen.findByText("Compare the vendors")).toBeInTheDocument();
    const specialistLink = screen.getByRole("button", { name: "Open Researcher's chat" });
    expect(specialistLink).toHaveTextContent("Researcher");
    expect(specialistLink).toHaveTextContent("Sleeping");
    expect(screen.getAllByRole("img", { name: "Ada, Companion" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Researcher.*Sleeping/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Analyst's chat" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByRole("button", { name: "Open Analyst's chat" })).toHaveTextContent("Preparing");
    expect(screen.getAllByRole("button", { name: "Open Researcher's chat" })).toHaveLength(1);
    await user.click(screen.getAllByRole("button", { name: "Close activity" }).at(-1)!);

    await user.click(specialistLink);
    expect(await screen.findByRole("textbox", { name: "Message Researcher" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Researcher" }).parentElement).toHaveTextContent("Sleeping");
    expect(window.location.pathname).toBe("/companions/specialist");
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

  it("completes OAuth in a popup, refreshes owned connections, and disables unavailable providers",async()=>{
    window.history.replaceState({},"","/connections");
    const account={id:"account-1",serverId:"app.linear/linear",label:"Linear",provider:"linear"};let completed=false;
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
    expect(screen.getByRole("button",{name:"Unavailable"})).toBeDisabled();
    completed=true;window.dispatchEvent(new MessageEvent("message",{origin:window.location.origin,source:popup as unknown as Window,data:{type:"companions:plugin-oauth",status:"connected"}}));
    expect(await screen.findByText("Connection added.")).toBeInTheDocument();
    await user.click(await screen.findByRole("button",{name:"Disconnect Linear"}));
    expect(await screen.findByText("Connection removed.")).toBeInTheDocument();
    await waitFor(()=>expect(screen.queryByRole("button",{name:"Disconnect Linear"})).not.toBeInTheDocument());
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
    await user.click(screen.getByRole("button",{name:"Check Linear work"}));
    expect(await screen.findByText("Connection ready",{exact:false})).toBeInTheDocument();
    expect(screen.getByText("Connection ready",{exact:false}).textContent).toContain(" · ");
    expect(screen.getByText("Linear work")).toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Disconnect Linear work"})).toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"Reconnect"}));
    await waitFor(()=>expect(popup.location.href).toBe("https://oauth.example/reconnect"));
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/connect",expect.objectContaining({method:"POST",body:JSON.stringify({serverId:"io.github.github/github-mcp-server",label:"GitHub"})}));
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

    await user.click(await screen.findByRole("button", { name: "Custom MCP" }));
    await user.type(screen.getByLabelText("Name"), "Private API");
    await user.type(screen.getByLabelText("Server URL"), "https://mcp.example/tools");
    await user.click(screen.getByText("Request headers"));
    await user.click(screen.getByRole("button", { name: "Add header" }));
    await user.type(screen.getByLabelText("Header 1 name"), "Authorization");
    const headerSecret = screen.getByLabelText("Header 1 secret value");
    expect(headerSecret).toHaveAttribute("type", "password");
    await user.type(headerSecret, "Bearer private-value");
    await user.click(screen.getByRole("button", { name: "Add server" }));

    await user.click(await screen.findByRole("button", { name: "Custom MCP" }));
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
    await user.selectOptions(await screen.findByLabelText("Start from"), "template-1");
    expect(screen.getByLabelText("Name")).toHaveValue("Research lead");
    expect(screen.getByLabelText("Mission")).toHaveValue("Investigate the market");
    expect(screen.getByRole("radio", { name: /Local/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Persistent cloud computer/ })).toBeChecked();
    await user.clear(screen.getByLabelText("Name")); await user.type(screen.getByLabelText("Name"), "Client researcher");
    await user.click(screen.getByRole("button", { name: "Create Companion" }));
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
 await user.click(await screen.findByRole("button",{name:"Settings for Ada"}));
 expect(screen.getByLabelText("Model")).toHaveValue("");
 await user.clear(screen.getByLabelText("Name"));await user.type(screen.getByLabelText("Name"),"Ada renamed");
 await user.click(screen.getByRole("button",{name:"Save"}));
 await waitFor(()=>expect(fetchMock.mock.calls.some(([,options])=>options?.method==="PATCH")).toBe(true));
 const update=fetchMock.mock.calls.find(([,options])=>options?.method==="PATCH");
 expect(JSON.parse(update![1]!.body as string)).toMatchObject({name:"Ada renamed",modelId:null});
});
