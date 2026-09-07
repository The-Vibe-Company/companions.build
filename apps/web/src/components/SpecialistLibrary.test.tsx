import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpecialistLibrary } from "./SpecialistLibrary";

const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const researcher = { id: "t1", name: "Researcher", instructions: "Investigate reliable sources", avatar: { shape: 0, color: 4, face: 0 }, revision: 2, sourceCompanionId: null, hasSnapshot: false };
const earlier = { revision: 1, name: "Research partner", instructions: "Find primary sources", avatar: { shape: 1, color: 6, face: 1 }, snapshotName: null, sourceCompanionId: null, createdAt: "2026-01-01T00:00:00.000Z" };

beforeEach(() => vi.unstubAllGlobals());

describe("SpecialistLibrary", () => {
  it("opens a persisted draft companion for configuration", async () => {
    const onOpenDraft = vi.fn();
    const draft = { templateId: "t1", companionId: "draft-companion", generation: 2, name: "Researcher", instructions: researcher.instructions, initScript: "", status: "editing", lastTest: null, publication: null };
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates") return response({ templates: [{ ...researcher, hasPublished: false, draftCompanionId: "draft-companion" }] });
      if (path === "/api/templates/t1/draft" && options?.method === "POST") return response({ draft });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SpecialistLibrary onOpenDraft={onOpenDraft} />);

    expect(await screen.findByText("Draft", { selector: ".specialist-library__version" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Configure" }));
    await waitFor(() => expect(onOpenDraft).toHaveBeenCalledWith("draft-companion", "t1"));
    const posted = JSON.parse(String((fetchMock.mock.calls.find(([path, options]) => String(path) === "/api/templates/t1/draft" && (options as RequestInit)?.method === "POST")?.[1] as RequestInit).body));
    expect(posted.commandId).toEqual(expect.any(String));
  });

  it("creates a private draft and opens its chat", async () => {
    const onOpenDraft = vi.fn();
    const draft = { templateId: "new-template", companionId: "new-draft", generation: 1, name: "Analyst", instructions: "Analyze product data", initScript: "", status: "editing", lastTest: null, publication: null };
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates" && options?.method === "POST") return response({ draft });
      if (path === "/api/templates") return response({ templates: [] });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SpecialistLibrary onOpenDraft={onOpenDraft} />);
    await screen.findByText("No specialists yet");
    await user.click(screen.getByRole("button", { name: "New specialist" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Analyst");
    await user.type(screen.getByRole("textbox", { name: "Role" }), "Analyze product data");
    await user.click(screen.getByRole("button", { name: "Create specialist" }));

    await waitFor(() => expect(onOpenDraft).toHaveBeenCalledWith("new-draft", "new-template"));
    const posted = JSON.parse(String((fetchMock.mock.calls.find(([path, options]) => String(path) === "/api/templates" && (options as RequestInit)?.method === "POST")?.[1] as RequestInit).body));
    expect(posted).toMatchObject({ draft: true, name: "Analyst", instructions: "Analyze product data", commandId: expect.any(String) });
  });

  it("edits a profile with its current revision and exposes real provider access semantics", async () => {
    let current = researcher;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates" && !options?.method) return response({ templates: [current] });
      if (path === "/api/templates/t1/revisions") return response({ revisions: [{ ...current, snapshotName: null, createdAt: "2026-02-01T00:00:00.000Z" }, earlier] });
      if (path === "/api/templates/t1" && options?.method === "PATCH") {
        const body = JSON.parse(String(options.body));
        current = { ...current, name: body.name, instructions: body.instructions, avatar: body.avatar, revision: 3 };
        return response({ id: current.id, revision: current.revision });
      }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SpecialistLibrary />);

    const edit = await screen.findByRole("button", { name: "Edit" });
    edit.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("Configure the specialist’s own accounts in its draft. A coordinator can override them for its team.")).toBeInTheDocument();
    expect(screen.queryByText(/works with/i)).not.toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Evidence researcher");
    await user.clear(screen.getByRole("textbox", { name: "Role" }));
    await user.type(screen.getByRole("textbox", { name: "Role" }), "Check primary sources first");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Profile saved.");
    expect(fetchMock).toHaveBeenCalledWith("/api/templates/t1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "Evidence researcher", instructions: "Check primary sources first", avatar: researcher.avatar, expectedRevision: 2 }),
    }));
    expect(screen.getByText("Evidence researcher", { selector: ".specialist-library__summary strong" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("prepare") || String(path).includes("replicas"))).toBe(false);
  });

  it("restores an earlier version against the current revision", async () => {
    let current = researcher;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates" && !options?.method) return response({ templates: [current] });
      if (path === "/api/templates/t1/revisions") return response({ revisions: [{ ...current, snapshotName: null, createdAt: "2026-02-01T00:00:00.000Z" }, earlier] });
      if (path === "/api/templates/t1/rollback" && options?.method === "POST") {
        current = { ...current, name: earlier.name, instructions: earlier.instructions, avatar: earlier.avatar, revision: 3 };
        return response({ id: current.id, revision: current.revision });
      }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SpecialistLibrary />);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Version 2 · history" }));
    await screen.findByRole("option", { name: "Version 1 · Research partner" });
    await user.click(screen.getByRole("button", { name: "Restore" }));

    expect(await screen.findByText("Research partner", { selector: ".specialist-library__summary strong" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/templates/t1/rollback", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ targetRevision: 1, expectedRevision: 2 }),
    }));
    expect(screen.getByRole("textbox", { name: "Role" })).toHaveValue("Find primary sources");
  });

  it("keeps a draft visible when a revision-safe save fails", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates") return response({ templates: [researcher] });
      if (path === "/api/templates/t1/revisions") return response({ revisions: [{ ...researcher, snapshotName: null, createdAt: "2026-02-01T00:00:00.000Z" }] });
      if (path === "/api/templates/t1" && options?.method === "PATCH") return response({ error: "This profile changed elsewhere. Reload and try again." }, 409);
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SpecialistLibrary />);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const role = screen.getByRole("textbox", { name: "Role" });
    await user.clear(role);
    await user.type(role, "Draft that must survive");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This profile changed elsewhere. Reload and try again.");
    expect(role).toHaveValue("Draft that must survive");
  });

  it("keeps the editor baseline when a passive refresh discovers a newer revision", async () => {
    const versionOne = { ...researcher, revision: 1 };
    let current = versionOne;
    let submittedRevision: number | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates" && !options?.method) return response({ templates: [current] });
      if (path === "/api/templates/t1/revisions") return response({ revisions: [{ ...versionOne, snapshotName: null, createdAt: "2026-02-01T00:00:00.000Z" }] });
      if (path === "/api/templates/t1" && options?.method === "PATCH") {
        submittedRevision = JSON.parse(String(options.body)).expectedRevision;
        return response({ error: "This profile changed elsewhere. Reload and try again." }, 409);
      }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const view = render(<SpecialistLibrary refreshVersion={0} />);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const role = screen.getByRole("textbox", { name: "Role" });
    await user.clear(role);
    await user.type(role, "My unsaved version one draft");
    current = { ...versionOne, name: "Changed elsewhere", instructions: "Concurrent edit", revision: 2 };
    view.rerender(<SpecialistLibrary refreshVersion={1} />);

    expect(await screen.findByText("Changed elsewhere", { selector: ".specialist-library__summary strong" })).toBeInTheDocument();
    expect(role).toHaveValue("My unsaved version one draft");
    expect(screen.getByRole("button", { name: "Version 1 · history" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This profile changed elsewhere. Reload and try again.");
    expect(submittedRevision).toBe(1);
    expect(role).toHaveValue("My unsaved version one draft");
  });

  it("refreshes after an ambiguous create instead of posting a duplicate", async () => {
    let createAttempted = false;
    const created = { ...researcher, id: "created", name: "Analyst", instructions: "Analyze product data", revision: 1 };
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates" && options?.method === "POST") { createAttempted = true; return Promise.reject(new TypeError("network connection lost")); }
      if (path === "/api/templates") return response({ templates: createAttempted ? [created] : [] });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onMenu = vi.fn();
    render(<SpecialistLibrary onMenu={onMenu} />);

    const menu = await screen.findByRole("button", { name: "Open navigation" });
    menu.focus();
    await user.keyboard("{Enter}");
    expect(onMenu).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "New specialist" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Analyst");
    await user.type(screen.getByRole("textbox", { name: "Role" }), "Analyze product data");
    await user.click(screen.getByRole("button", { name: "Create specialist" }));

    expect(await screen.findByText(/couldn’t confirm whether this specialist was created/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create specialist" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh specialists" }));

    expect(await screen.findByText("Analyst", { selector: ".specialist-library__summary strong" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([path, options]) => String(path) === "/api/templates" && (options as RequestInit | undefined)?.method === "POST")).toHaveLength(1);
  });
});
