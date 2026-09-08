import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Companion } from "@/api";
import { TeamPanel } from "./TeamPanel";

const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const companion: Companion = { id: "c1", name: "Ada", instructions: "Build and maintain my application", provider: "box", status: "ready", error: null, createdAt: new Date().toISOString(), avatar: { shape: 1, color: 7, face: 1 } };
const researcher = { id: "t1", name: "Researcher", instructions: "Investigate sources", avatar: { shape: 0, color: 4, face: 0 }, revision: 2, sourceCompanionId: null, hasSnapshot: false };
const writer = { id: "t2", name: "Writer", instructions: "Turn findings into clear prose", avatar: { shape: 6, color: 5, face: 2 }, revision: 1, sourceCompanionId: null, hasSnapshot: false };

beforeEach(() => vi.unstubAllGlobals());

describe("TeamPanel", () => {
  it("persists an account override for one specialist on one team", async () => {
    let connections = [{ slot: "github", required: true, defaultAccountId: "gh-default", overridden: false, accountId: "gh-default", label: "personal", provider: "github" }];
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates") return response({ templates: [researcher] });
      if (path === "/api/companions/c1/templates") return response({ templates: [{ templateId: "t1", maxChildren: 2, name: "Researcher", revision: 2 }] });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      if (path === "/api/templates/t1/revisions") return response({ revisions: [{ ...researcher, snapshotName: null, createdAt: new Date().toISOString() }] });
      if (path === "/api/companions/c1/plugins") return response({ accounts: [{ id: "gh-work", serverId: "github", provider: "github", label: "Acme work", healthStatus: "ok", healthCode: null, checkedAt: null }] });
      if (path === "/api/companions/c1/specialists/t1/connections" && !options?.method) return response({ connections });
      if (path === "/api/companions/c1/specialists/t1/connections" && options?.method === "PATCH") {
        const body = JSON.parse(String(options.body));
        connections = [{ ...connections[0], overridden: true, accountId: body.accountId, label: "Acme work" }];
        return response({ connections });
      }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={vi.fn()} />);
    await user.click(await screen.findByText("Team settings"));
    const account = await screen.findByRole("combobox", { name: "github account" });
    expect(account).toHaveValue("__default__");
    await user.selectOptions(account, "gh-work");
    await waitFor(() => expect(account).toHaveValue("gh-work"));
    expect(fetchMock).toHaveBeenCalledWith("/api/companions/c1/specialists/t1/connections", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ slot: "github", accountId: "gh-work" }) }));
  });

  it("refreshes external permission and replica changes while mounted", async () => {
    let authorized = [{ templateId: "t1", maxChildren: 2, name: "Researcher", revision: 2 }];
    let replicas: Companion[] = [];
    const child = { ...companion, id: "child", name: "Market researcher", parentId: companion.id };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/templates") return response({ templates: [researcher, writer] });
      if (path === "/api/companions/c1/templates") return response({ templates: authorized });
      if (path === "/api/companions/c1/replicas") return response({ replicas });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={vi.fn()} refreshVersion={0} />);

    expect(await screen.findByText("Investigate sources", { selector: ".team-person p" })).toBeInTheDocument();
    authorized = [...authorized, { templateId: "t2", maxChildren: 2, name: "Writer", revision: 1 }];
    replicas = [child];
    view.rerender(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={vi.fn()} refreshVersion={1} />);

    expect(await screen.findByText("Turn findings into clear prose", { selector: ".team-person p" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Market researcher's work" })).toBeInTheDocument();
  });

  it("keeps a mutation error and retry state through a passive refresh", async () => {
    let templateLoads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates") { templateLoads += 1; return response({ templates: [writer] }); }
      if (path === "/api/companions/c1/templates" && !options?.method) return response({ templates: [] });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      if (path === "/api/companions/c1/templates/t2" && options?.method === "PUT") return response({ error: "Permission could not be saved." }, 503);
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onOpenCompanion = vi.fn();
    const view = render(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={onOpenCompanion} refreshVersion={0} />);
    const user = userEvent.setup();

    await screen.findByText(/does not have any specialists/);
    await user.click(screen.getByRole("button", { name: "Add specialist" }));
    await user.click(screen.getByRole("button", { name: "Add to team" }));
    expect(await screen.findByText("Permission could not be saved.")).toBeInTheDocument();

    view.rerender(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={onOpenCompanion} refreshVersion={1} />);
    await waitFor(() => expect(templateLoads).toBe(2));
    expect(screen.getByText("Permission could not be saved.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to team" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Writer/ })).toBeChecked();
  });

  it("coalesces burst invalidations and preserves a new-profile draft", async () => {
    let templateLoads = 0;
    let templates: Array<typeof researcher> = [];
    let authorized: Array<{ templateId: string; maxChildren: number; name: string; revision: number }> = [];
    let replicas: Companion[] = [];
    let releaseRefresh!: (value: Response) => void;
    const heldRefresh = new Promise<Response>(resolve => { releaseRefresh = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/templates") {
        templateLoads += 1;
        if (templateLoads === 2) return heldRefresh;
        return response({ templates });
      }
      if (path === "/api/companions/c1/templates") return response({ templates: authorized });
      if (path === "/api/companions/c1/replicas") return response({ replicas });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={vi.fn()} refreshVersion={0} />);
    const user = userEvent.setup();

    await screen.findByText(/does not have any specialists/);
    await user.click(screen.getByRole("button", { name: "Add specialist" }));
    await user.type(screen.getByRole("textbox", { name: "Specialist brief" }), "Keep this role while refreshing");
    view.rerender(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={vi.fn()} refreshVersion={1} />);
    await waitFor(() => expect(templateLoads).toBe(2));

    templates = [researcher];
    authorized = [{ templateId: "t1", maxChildren: 2, name: "Researcher", revision: 2 }];
    replicas = [{ ...companion, id: "child", name: "Research child", parentId: companion.id }];
    view.rerender(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={vi.fn()} refreshVersion={2} />);
    view.rerender(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={vi.fn()} refreshVersion={3} />);
    releaseRefresh(new Response(JSON.stringify({ templates: [] }), { status: 200, headers: { "content-type": "application/json" } }));

    await waitFor(() => expect(templateLoads).toBe(3));
    expect(screen.getByRole("textbox", { name: "Specialist brief" })).toHaveValue("Keep this role while refreshing");
    await user.click(screen.getByRole("button", { name: "Close new specialist" }));
    expect(await screen.findByText("Investigate sources", { selector: ".team-person p" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Research child's work" })).toBeInTheDocument();
  });

  it("ignores an older passive snapshot that finishes after a mutation reload", async () => {
    let authorized: Array<{ templateId: string; maxChildren: number; name: string; revision: number }> = [];
    let templateLoads = 0;
    let releaseRefresh!: (value: Response) => void;
    const heldRefresh = new Promise<Response>(resolve => { releaseRefresh = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates") {
        templateLoads += 1;
        return templateLoads === 2 ? heldRefresh : response({ templates: [writer] });
      }
      if (path === "/api/companions/c1/templates" && !options?.method) return response({ templates: authorized });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      if (path === "/api/companions/c1/templates/t2" && options?.method === "PUT") {
        authorized = [{ templateId: "t2", maxChildren: 2, name: "Writer", revision: 1 }];
        return response(authorized[0]);
      }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={vi.fn()} refreshVersion={0} />);
    const user = userEvent.setup();

    await screen.findByText(/does not have any specialists/);
    view.rerender(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={vi.fn()} refreshVersion={1} />);
    await waitFor(() => expect(templateLoads).toBe(2));
    await user.click(screen.getByRole("button", { name: "Add specialist" }));
    await user.click(screen.getByRole("button", { name: "Add to team" }));
    expect(await screen.findByText("Turn findings into clear prose", { selector: ".team-person p" })).toBeInTheDocument();

    releaseRefresh(new Response(JSON.stringify({ templates: [writer] }), { status: 200, headers: { "content-type": "application/json" } }));
    await waitFor(() => expect(templateLoads).toBe(3));
    expect(screen.getByText("Turn findings into clear prose", { selector: ".team-person p" })).toBeInTheDocument();
  });

  it("adds an existing profile to the team without launching work", async () => {
    let authorized = [{ templateId: "t1", maxChildren: 2, name: "Researcher", revision: 2 }];
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates") return response({ templates: [researcher, writer] });
      if (path === "/api/companions/c1/templates" && !options?.method) return response({ templates: authorized });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      if (path === "/api/companions/c1/templates/t2" && options?.method === "PUT") { authorized = [...authorized, { templateId: "t2", maxChildren: 2, name: "Writer", revision: 1 }]; return response(authorized.at(-1)); }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={vi.fn()} />);

    expect(await screen.findByText("Investigate sources", { selector: ".team-person p" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add specialist" }));
    await user.click(screen.getByRole("button", { name: "Add to team" }));

    expect(await screen.findByText("Turn findings into clear prose", { selector: ".team-person p" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/companions/c1/templates/t2", expect.objectContaining({ method: "PUT", body: JSON.stringify({ maxChildren: 2 }) }));
    expect(fetchMock.mock.calls.some(([path, options]) => String(path) === "/api/companions/c1/replicas" && (options as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("uses a zero limit to remove authorization without deleting the profile", async () => {
    let permission = { templateId: "t1", maxChildren: 2, name: "Researcher", revision: 2 };
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates") return response({ templates: [researcher] });
      if (path === "/api/companions/c1/templates" && !options?.method) return response({ templates: [permission] });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      if (path === "/api/templates/t1/revisions") return response({ revisions: [{ ...researcher, createdAt: new Date().toISOString(), snapshotName: null }] });
      if (path === "/api/companions/c1/templates/t1" && options?.method === "PUT") { permission = { ...permission, maxChildren: 0 }; return response(permission); }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={vi.fn()} />);

    await user.click(await screen.findByText("Team settings"));
    await user.click(screen.getByRole("button", { name: "Remove from team" }));
    await waitFor(() => expect(screen.queryByText("Investigate sources")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/companions/c1/templates/t1", expect.objectContaining({ method: "PUT", body: JSON.stringify({ maxChildren: 0 }) }));
    expect(fetchMock.mock.calls.some(([path, options]) => String(path) === "/api/templates/t1" && (options as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });

  it("reuses the task command id when a manual launch is retried", async () => {
    const commandIds: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates") return response({ templates: [researcher] });
      if (path === "/api/companions/c1/templates") return response({ templates: [{ templateId: "t1", maxChildren: 2, name: "Researcher", revision: 2 }] });
      if (path === "/api/companions/c1/replicas" && options?.method === "POST") {
        commandIds.push(JSON.parse(String(options.body)).clientCommandId);
        return commandIds.length === 1 ? response({ error: "Launch response was lost." }, 503) : response({ companionId: "child", runId: "run" }, 202);
      }
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TeamPanel onOpenDraft={vi.fn()} companion={companion} onOpenCompanion={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Assign a task" }));
    await user.type(screen.getByRole("textbox", { name: "What should Researcher do?" }), "Check the market");
    await user.click(screen.getByRole("button", { name: "Start task" }));
    expect(await screen.findByText("Launch response was lost.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start task" }));

    await waitFor(() => expect(commandIds).toHaveLength(2));
    expect(commandIds[1]).toBe(commandIds[0]);
  });

});


it("opens the specialist configuration chat instead of editing a published profile inline", async () => {
  const onOpenDraft = vi.fn();
  let attempts = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    if (path === "/api/templates") return response({ templates: [researcher] });
    if (path === "/api/companions/c1/templates") return response({ templates: [{ templateId: "t1", maxChildren: 2, name: "Researcher", revision: 2 }] });
    if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
    if (path === "/api/templates/t1/draft" && options?.method === "POST") {
      if (++attempts === 1) return response({ error: "Environment temporarily unavailable" }, 503);
      return response({ draft: { companionId: "draft-1", templateId: "t1" } });
    }
    throw new Error(`Unexpected ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TeamPanel companion={companion} onOpenCompanion={vi.fn()} onOpenDraft={onOpenDraft}/>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Configure" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Environment temporarily unavailable");
  expect(onOpenDraft).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Configure" }));
  await waitFor(() => expect(onOpenDraft).toHaveBeenCalledWith("draft-1", "t1"));
  expect(screen.queryByText("Profile settings")).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Profile name" })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
});

it("creates a private draft and waits for its computer before opening chat without granting unpublished work", async () => {
  const onOpenDraft = vi.fn();
  const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    if (path === "/api/templates" && options?.method === "POST") return response({ draft: { companionId: "draft-1", templateId: "t1" } });
    if (path === "/api/templates") return response({ templates: [] });
    if (path === "/api/companions/c1/templates") return response({ templates: [] });
    if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
    if (path === "/api/companions/draft-1") return response({ companion: { ...companion, id: "draft-1", status: "ready" } });
    throw new Error(`Unexpected ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TeamPanel companion={companion} onOpenCompanion={vi.fn()} onOpenDraft={onOpenDraft}/>);
  const user = userEvent.setup();
  await screen.findByText(/does not have any specialists/);
  await user.click(screen.getByRole("button", { name: "Add specialist" }));
  await user.type(screen.getByRole("textbox", { name: "Specialist brief" }), "Prepare GitHub and Linear");
  await user.click(screen.getByRole("button", { name: "Create specialist" }));
  await waitFor(() => expect(onOpenDraft).toHaveBeenCalledWith("draft-1", "t1"));
  expect(fetchMock).toHaveBeenCalledWith("/api/templates", expect.objectContaining({ method: "POST", body: expect.stringContaining('"draft":true') }));
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
});
