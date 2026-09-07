import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, workspaceApi, type AppConfig, type Companion } from "@/api";
import { CreateTeamWizard } from "./CreateTeamWizard";

const config: AppConfig = { localAvailable: true, boxAvailable: true, model: "test" };
const coordinator: Companion = { id: "c1", name: "Ada", instructions: "Lead product development", provider: "local", status: "ready", error: null, createdAt: "2026-09-07T00:00:00Z", avatar: { shape: 1, color: 2, face: 0 } };
const templates = [
  { id: "research", name: "Researcher", instructions: "Find reliable evidence", avatar: { shape: 0, color: 5, face: 1 }, revision: 1, sourceCompanionId: null, hasSnapshot: false },
  { id: "writer", name: "Writer", instructions: "Turn findings into clear prose", avatar: { shape: 2, color: 7, face: 0 }, revision: 3, sourceCompanionId: null, hasSnapshot: false },
];

beforeEach(() => {
  vi.spyOn(workspaceApi, "templates").mockResolvedValue({ templates });
});

describe("CreateTeamWizard", () => {
  it("adds selected profiles to an existing coordinator without starting work", async () => {
    const permission = vi.spyOn(workspaceApi, "setTemplatePermission").mockResolvedValue({ templateId: "research", maxChildren: 2 });
    const create = vi.spyOn(api, "createCompanion");
    const spawn = vi.spyOn(workspaceApi, "spawnReplica");
    const prepare = vi.spyOn(workspaceApi, "prepare");
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<CreateTeamWizard config={config} companions={[coordinator]} onCreated={onCreated} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("checkbox", { name: /Researcher/ }));
    await user.click(screen.getByRole("button", { name: "Review team" }));
    expect(screen.getByText(/won’t start a task or wake a computer/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create team" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(coordinator));
    expect(permission).toHaveBeenCalledWith("c1", "research", 2);
    expect(create).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("keeps a created coordinator and completed permissions across a partial retry", async () => {
    const created = { ...coordinator, id: "new-coordinator", name: "Maya", instructions: "Keep my app moving" };
    const create = vi.spyOn(api, "createCompanion").mockResolvedValue({ companion: created });
    const permission = vi.spyOn(workspaceApi, "setTemplatePermission")
      .mockResolvedValueOnce({ templateId: "research", maxChildren: 2 })
      .mockRejectedValueOnce(new Error("Writer permission could not be saved"))
      .mockResolvedValueOnce({ templateId: "writer", maxChildren: 2 });
    const spawn = vi.spyOn(workspaceApi, "spawnReplica");
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<CreateTeamWizard config={config} companions={[]} onCreated={onCreated} onCancel={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Maya");
    await user.type(screen.getByRole("textbox", { name: "Purpose" }), "Keep my app moving");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("checkbox", { name: /Researcher/ }));
    await user.click(screen.getByRole("checkbox", { name: /Writer/ }));
    await user.click(screen.getByRole("button", { name: "Review team" }));
    await user.click(screen.getByRole("button", { name: "Create team" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your progress is saved.");
    expect(screen.getByRole("alert")).toHaveTextContent("1 specialist still to add");
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish saving before closing" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(create).toHaveBeenCalledTimes(1);
    expect(permission.mock.calls).toEqual([
      ["new-coordinator", "research", 2],
      ["new-coordinator", "writer", 2],
      ["new-coordinator", "writer", 2],
    ]);
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(create.mock.calls[0][0]))).toMatchObject({ clientCreationId: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "Maya", instructions: "Keep my app moving", provider: "local", prepare: false });
  });

  it("reuses its creation id when the coordinator response is lost", async () => {
    const created = { ...coordinator, id: "new-coordinator", name: "Maya" };
    const create = vi.spyOn(api, "createCompanion").mockRejectedValueOnce(new Error("Response lost")).mockResolvedValueOnce({ companion: created });
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<CreateTeamWizard config={config} companions={[]} onCreated={onCreated} onCancel={vi.fn()} />);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Maya");
    await user.type(screen.getByRole("textbox", { name: "Purpose" }), "Keep my app moving");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Researcher");
    await user.click(screen.getByRole("button", { name: "Review team" }));
    await user.click(screen.getByRole("button", { name: "Create team" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Response lost");
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish saving before closing" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].clientCreationId).toBe(create.mock.calls[0][0].clientCreationId);
  });
});
