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
    render(<TeamPanel companion={companion} onOpenCompanion={vi.fn()} />);

    expect(await screen.findByText("Investigate sources", { selector: ".team-person p" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add specialist" }));
    await user.click(screen.getByRole("button", { name: "Add to team" }));

    expect(await screen.findByText("Turn findings into clear prose", { selector: ".team-person p" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/companions/c1/templates/t2", expect.objectContaining({ method: "PUT", body: JSON.stringify({ maxChildren: 2 }) }));
    expect(fetchMock.mock.calls.some(([path, options]) => String(path) === "/api/companions/c1/replicas" && (options as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("retries only the permission when a newly created profile could not be added", async () => {
    let permissionAttempts = 0;
    let authorized: Array<{ templateId: string; maxChildren: number; name: string; revision: number }> = [];
    const created = { ...writer, id: "created-profile", name: "Analyst", instructions: "Analyze product data" };
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates" && options?.method === "POST") return response({ id: created.id, revision: 1 }, 201);
      if (path === "/api/templates") return response({ templates: authorized.length ? [created] : [] });
      if (path === "/api/companions/c1/templates" && !options?.method) return response({ templates: authorized });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      if (path === `/api/companions/c1/templates/${created.id}` && options?.method === "PUT") {
        permissionAttempts += 1;
        if (permissionAttempts === 1) return response({ error: "Permission could not be saved." }, 503);
        authorized = [{ templateId: created.id, maxChildren: 2, name: created.name, revision: 1 }];
        return response(authorized[0]);
      }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TeamPanel companion={companion} onOpenCompanion={vi.fn()} />);

    await screen.findByText(/does not have any specialists/);
    await user.click(screen.getByRole("button", { name: "Add specialist" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Analyst");
    await user.type(screen.getByRole("textbox", { name: "Role" }), "Analyze product data");
    await user.click(screen.getByRole("button", { name: "Create and add" }));

    expect(await screen.findByText("Permission could not be saved.")).toBeInTheDocument();
    expect(screen.getByText(/was created/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry adding" }));

    expect(await screen.findByText("Analyze product data", { selector: ".team-person p" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([path, options]) => String(path) === "/api/templates" && (options as RequestInit | undefined)?.method === "POST")).toHaveLength(1);
    expect(permissionAttempts).toBe(2);
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
    render(<TeamPanel companion={companion} onOpenCompanion={vi.fn()} />);

    await user.click(await screen.findByText("Profile settings"));
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
    render(<TeamPanel companion={companion} onOpenCompanion={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Assign a task" }));
    await user.type(screen.getByRole("textbox", { name: "What should Researcher do?" }), "Check the market");
    await user.click(screen.getByRole("button", { name: "Start task" }));
    expect(await screen.findByText("Launch response was lost.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start task" }));

    await waitFor(() => expect(commandIds).toHaveLength(2));
    expect(commandIds[1]).toBe(commandIds[0]);
  });

  it("refreshes persisted profiles after an ambiguous create response before offering another create", async () => {
    let createAttempted = false;
    const created = { ...writer, id: "created-profile", name: "Analyst", instructions: "Analyze product data" };
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates" && options?.method === "POST") { createAttempted = true; return Promise.reject(new TypeError("network connection lost")); }
      if (path === "/api/templates") return response({ templates: createAttempted ? [created] : [] });
      if (path === "/api/companions/c1/templates") return response({ templates: [] });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TeamPanel companion={companion} onOpenCompanion={vi.fn()} />);

    await screen.findByText(/does not have any specialists/);
    await user.click(screen.getByRole("button", { name: "Add specialist" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Analyst");
    await user.click(screen.getByRole("button", { name: "Create and add" }));
    expect(await screen.findByText(/couldn't confirm/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create and add" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh profiles" }));
    expect(await screen.findByText("Analyze product data")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([path, options]) => String(path) === "/api/templates" && (options as RequestInit | undefined)?.method === "POST")).toHaveLength(1);
  });

  it("saves shared profile edits against the revision that was displayed", async () => {
    let current = researcher;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates/t1" && options?.method === "PATCH") {
        const body = JSON.parse(String(options.body));
        current = { ...current, ...body, revision: 3 };
        return response({ id: "t1", revision: 3 });
      }
      if (path === "/api/templates") return response({ templates: [current] });
      if (path === "/api/companions/c1/templates") return response({ templates: [{ templateId: "t1", maxChildren: 2, name: current.name, revision: current.revision }] });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      if (path === "/api/templates/t1/revisions") return response({ revisions: [{ ...researcher, createdAt: new Date().toISOString(), snapshotName: null }] });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TeamPanel companion={companion} onOpenCompanion={vi.fn()} />);

    await user.click(await screen.findByText("Profile settings"));
    const name = screen.getByRole("textbox", { name: "Profile name" });
    const role = screen.getByRole("textbox", { name: "Profile role" });
    await user.clear(name); await user.type(name, "Lead researcher");
    await user.clear(role); await user.type(role, "Verify primary sources");
    await user.click(screen.getByRole("button", { name: "Shape 2" }));
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(await screen.findByText("Profile saved.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/templates/t1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "Lead researcher", instructions: "Verify primary sources", avatar: { shape: 1, color: 4, face: 0 }, expectedRevision: 2 }),
    }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => String(path) === "/api/templates/t1/revisions")).toHaveLength(2));
    expect(name).toHaveAttribute("maxlength", "80");
    expect(role).toHaveAttribute("maxlength", "20000");
  });

  it("keeps the edited profile draft when saving conflicts", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates") return response({ templates: [researcher] });
      if (path === "/api/companions/c1/templates") return response({ templates: [{ templateId: "t1", maxChildren: 2, name: researcher.name, revision: researcher.revision }] });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      if (path === "/api/templates/t1/revisions") return response({ revisions: [] });
      if (path === "/api/templates/t1" && options?.method === "PATCH") return response({ error: "Template missing or changed." }, 409);
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TeamPanel companion={companion} onOpenCompanion={vi.fn()} />);

    await user.click(await screen.findByText("Profile settings"));
    const name = screen.getByRole("textbox", { name: "Profile name" });
    const role = screen.getByRole("textbox", { name: "Profile role" });
    await user.clear(name); await user.type(name, "Research lead");
    await user.clear(role); await user.type(role, "Keep this detailed draft");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(await screen.findByText("Template missing or changed.")).toBeInTheDocument();
    expect(name).toHaveValue("Research lead");
    expect(role).toHaveValue("Keep this detailed draft");
  });

  it("offers a retry when version history fails to load", async () => {
    let historyAttempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/templates") return response({ templates: [researcher] });
      if (path === "/api/companions/c1/templates") return response({ templates: [{ templateId: "t1", maxChildren: 2, name: researcher.name, revision: researcher.revision }] });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      if (path === "/api/templates/t1/revisions") { historyAttempts += 1; return historyAttempts === 1 ? response({ error: "History unavailable." }, 503) : response({ revisions: [{ ...researcher, createdAt: new Date().toISOString(), snapshotName: null }] }); }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TeamPanel companion={companion} onOpenCompanion={vi.fn()} />);

    await user.click(await screen.findByText("Profile settings"));
    expect(await screen.findByText("History unavailable.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry history" }));
    expect(await screen.findByText("Version 2 is the only saved version.")).toBeInTheDocument();
    expect(historyAttempts).toBe(2);
  });

  it("syncs the editor and reloads history after restoring a profile", async () => {
    const earlier = { ...researcher, name: "Archive researcher", instructions: "Review the archive", avatar: { shape: 2, color: 5, face: 3 }, revision: 1 };
    let current = researcher;
    let historyLoads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates") return response({ templates: [current] });
      if (path === "/api/companions/c1/templates") return response({ templates: [{ templateId: "t1", maxChildren: 2, name: current.name, revision: current.revision }] });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      if (path === "/api/templates/t1/revisions") { historyLoads += 1; return response({ revisions: [{ ...current, createdAt: new Date().toISOString(), snapshotName: null }, { ...earlier, createdAt: new Date().toISOString(), snapshotName: null }] }); }
      if (path === "/api/templates/t1/rollback" && options?.method === "POST") { current = { ...earlier, revision: 3 }; return response({ id: "t1", revision: 3 }); }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TeamPanel companion={companion} onOpenCompanion={vi.fn()} />);

    await user.click(await screen.findByText("Profile settings"));
    await user.click(await screen.findByRole("button", { name: "Restore" }));

    expect(await screen.findByRole("textbox", { name: "Profile name" })).toHaveValue("Archive researcher");
    expect(screen.getByRole("textbox", { name: "Profile role" })).toHaveValue("Review the archive");
    expect(screen.getByRole("button", { name: "Shape 3" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(historyLoads).toBe(2));
  });
});
