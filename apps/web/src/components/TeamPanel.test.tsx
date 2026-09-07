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

    expect(await screen.findByText("Investigate sources")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add specialist" }));
    await user.click(screen.getByRole("button", { name: "Add to team" }));

    expect(await screen.findByText("Turn findings into clear prose")).toBeInTheDocument();
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

    expect(await screen.findByText("Analyze product data")).toBeInTheDocument();
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
});
