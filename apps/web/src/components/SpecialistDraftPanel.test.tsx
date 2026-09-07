import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpecialistDraftPanel } from "./SpecialistDraftPanel";

const response = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
const baseDraft = { templateId: "template-1", companionId: "draft-1", generation: 3, name: "Developer", instructions: "Work on the selected repositories", initScript: "bun install", status: "editing", lastTest: null, publication: null };

beforeEach(() => vi.unstubAllGlobals());

describe("SpecialistDraftPanel", () => {
  it("uses persisted configuration, account, test assessment, and publication states", async () => {
    let draft: any = baseDraft;
    const bodies: Array<{ path: string; body: any }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      if (body) bodies.push({ path, body });
      if (path === "/api/templates/template-1/draft" && !options?.method) return response({ draft });
      if (path === "/api/plugins") return response({ catalog: [{ id: "github", name: "GitHub", provider: "github", available: true }], accounts: [{ id: "gh-1", serverId: "github", provider: "github", label: "acme", healthStatus: "ok", healthCode: null, checkedAt: null }] });
      if (path === "/api/companions/draft-1/plugins") return response({ accounts: [] });
      if (path === "/api/companions/draft-1/plugins/gh-1" && options?.method === "PUT") return response({ ok: true });
      if (path === "/api/templates/template-1/draft" && options?.method === "PATCH") {
        draft = { ...draft, generation: 4, name: body.name, instructions: body.instructions, initScript: body.initScript };
        return response({ draft });
      }
      if (path === "/api/templates/template-1/draft/test" && options?.method === "POST") {
        draft = { ...draft, status: "editing", lastTest: { id: "test-1", generation: 4, status: "succeeded", createdAt: "2026-09-07T20:00:00.000Z", assessment: null } };
        return response({ draft });
      }
      if (path === "/api/templates/template-1/draft/test/test-1/assessment" && options?.method === "POST") {
        draft = { ...draft, lastTest: { ...draft.lastTest, assessment: body.assessment } };
        return response({ draft });
      }
      if (path === "/api/templates/template-1/draft/publish" && options?.method === "POST") {
        draft = { ...draft, status: "publishing", publication: { id: "publication-1", status: "preparing", generation: 4 } };
        return response({ draft });
      }
      throw new Error(`Unexpected ${path} ${options?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SpecialistDraftPanel templateId="template-1" companionId="draft-1" onClose={vi.fn()} onConnections={vi.fn()} />);

    expect(await screen.findByRole("textbox", { name: "Instructions" })).toHaveValue("Work on the selected repositories");
    await screen.findByText("GitHub");
    await user.click(screen.getByRole("checkbox", { name: "acme" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/companions/draft-1/plugins/gh-1", expect.objectContaining({ method: "PUT" })));

    const script = screen.getByRole("textbox", { name: /Initialization script/ });
    await user.clear(script); await user.type(script, "bun install --frozen-lockfile");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent("Configuration saved.");
    expect(bodies.find(item => item.path === "/api/templates/template-1/draft" && item.body.expectedGeneration)?.body).toMatchObject({ expectedGeneration: 3, initScript: "bun install --frozen-lockfile" });

    await user.type(screen.getByRole("textbox", { name: "Test brief" }), "Open a small pull request");
    await user.click(screen.getByRole("button", { name: "Test mission" }));
    expect(await screen.findByText("Test finished")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Satisfactory" }));
    await waitFor(() => expect(bodies.some(item => item.path.endsWith("/assessment") && item.body.assessment === "satisfactory")).toBe(true));

    await user.click(screen.getByRole("checkbox", { name: /I reviewed the shared content/ }));
    await user.click(screen.getByRole("button", { name: "Publish version" }));
    await waitFor(() => expect(bodies.some(item => item.path.endsWith("/publish") && item.body.contentReviewed === true && item.body.expectedGeneration === 4)).toBe(true));
    expect(await screen.findByText(/Publication preparing/)).toBeInTheDocument();
  });
});


describe("draft operation controls", () => {
  it.each(["running", "failed"])("opens the %s test transcript", async status => {
    const onOpenCompanion = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/draft")) return response({ draft: { ...baseDraft, lastTest: { id: "test", status, companionId: "test-copy", generation: 3 } } });
      return response({ accounts: [], catalog: [] });
    }));
    render(<SpecialistDraftPanel templateId="template-1" companionId="draft-1" onClose={vi.fn()} onOpenCompanion={onOpenCompanion}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Open test chat" }));
    expect(onOpenCompanion).toHaveBeenCalledWith("test-copy");
  });

  it.each(["testing", "publishing"])("locks configuration until persisted %s finishes", async status => {
    let draft = { ...baseDraft, status };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).endsWith("/draft") ? response({ draft }) : response({ accounts: [], catalog: [] })));
    render(<SpecialistDraftPanel templateId="template-1" companionId="draft-1" onClose={vi.fn()}/>);
    const instructions = await screen.findByRole("textbox", { name: "Instructions" });
    expect(instructions).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test mission" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /I reviewed/ })).toBeDisabled();
    draft = { ...draft, status: "editing" };
    await waitFor(() => expect(instructions).toBeEnabled(), { timeout: 3_000 });
  });
});
