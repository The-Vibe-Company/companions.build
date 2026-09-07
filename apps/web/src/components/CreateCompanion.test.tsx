import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, workspaceApi, type AgentTemplate, type Companion, type PluginAccount } from "@/api";
import { CreateCompanion } from "./CreateCompanion";

const companion: Companion = {
  id: "companion-1", name: "Ada", instructions: "Research the market", provider: "box", status: "new",
  error: null, createdAt: "2026-09-07T08:00:00.000Z", avatar: { shape: 1, color: 2, face: 0 },
};
const accounts: PluginAccount[] = [
  { id: "linear-work", serverId: "linear", label: "Work workspace", provider: "linear", healthStatus: "ok", healthCode: null, checkedAt: null },
  { id: "linear-personal", serverId: "linear", label: "Personal workspace", provider: "linear", healthStatus: "ok", healthCode: null, checkedAt: null },
  { id: "github-work", serverId: "github", label: "the-vibe-company", provider: "github", healthStatus: "ok", healthCode: null, checkedAt: null },
];
const templates: AgentTemplate[] = [
  { id: "researcher", name: "Researcher", instructions: "Find reliable evidence", avatar: { shape: 3, color: 5, face: 2 }, revision: 4, sourceCompanionId: null, hasSnapshot: false },
  { id: "writer", name: "Writer", instructions: "Write a concise brief", avatar: { shape: 6, color: 7, face: 1 }, revision: 2, sourceCompanionId: null, hasSnapshot: false },
];
const config = { localAvailable: true, boxAvailable: true, model: "test" };

function mockSetup() {
  vi.spyOn(workspaceApi, "templates").mockResolvedValue({ templates });
  vi.spyOn(workspaceApi, "plugins").mockResolvedValue({
    accounts,
    catalog: [
      { id: "linear", name: "Linear", provider: "linear", available: true },
      { id: "github", name: "GitHub", provider: "github", available: true },
    ],
  });
}

async function enterBasics(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { name: "Linear" });
  await user.type(screen.getByLabelText("Name"), "Ada");
  await user.type(screen.getByLabelText("Purpose"), "Research the market");
}

beforeEach(() => { window.sessionStorage.clear(); mockSetup(); });
afterEach(() => vi.restoreAllMocks());

describe("CreateCompanion", () => {
  it("shows live identity controls and groups real account and specialist choices", async () => {
    vi.spyOn(api, "createCompanion");
    const user = userEvent.setup();
    render(<CreateCompanion config={config} onCreated={vi.fn()}/>);
    await enterBasics(user);

    expect(screen.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Companion preview")).getByText("Research the market")).toBeInTheDocument();
    expect(screen.getByText("0 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Color 6" }));
    await user.click(screen.getByRole("button", { name: "Shape 4" }));
    await user.click(screen.getByRole("button", { name: "Face 3" }));
    await user.click(screen.getByRole("checkbox", { name: "Work workspace" }));
    await user.click(screen.getByRole("checkbox", { name: /Researcher/ }));

    expect(screen.getByRole("button", { name: "Color 6" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("checkbox", { name: "Work workspace" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Researcher/ })).toBeChecked();
    expect(screen.getAllByText("1 selected")).toHaveLength(2);
  });

  it("resumes unfinished grants after failure without recreating or repeating completed grants", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const create = vi.spyOn(api, "createCompanion").mockResolvedValue({ companion });
    const grantAccount = vi.spyOn(workspaceApi, "selectPlugin")
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("Personal workspace could not be granted."))
      .mockResolvedValueOnce({ ok: true });
    const grantSpecialist = vi.spyOn(workspaceApi, "setTemplatePermission").mockResolvedValue({ templateId: "researcher", maxChildren: 2 });
    render(<CreateCompanion config={config} onCreated={onCreated}/>);
    await enterBasics(user);
    await user.click(screen.getByRole("checkbox", { name: "Work workspace" }));
    await user.click(screen.getByRole("checkbox", { name: "Personal workspace" }));
    await user.click(screen.getByRole("checkbox", { name: /Researcher/ }));
    await user.click(screen.getByRole("button", { name: "Create companion" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Personal workspace could not be granted.");
    expect(create).toHaveBeenCalledOnce();
    expect(grantAccount).toHaveBeenNthCalledWith(1, "companion-1", "linear-work");
    expect(grantAccount).toHaveBeenNthCalledWith(2, "companion-1", "linear-personal");
    expect(grantSpecialist).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Resume setup" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(companion));
    expect(create).toHaveBeenCalledOnce();
    expect(grantAccount).toHaveBeenCalledTimes(3);
    expect(grantAccount.mock.calls.filter(([, id]) => id === "linear-work")).toHaveLength(1);
    expect(grantSpecialist).toHaveBeenCalledWith("companion-1", "researcher", 2);
  });

  it("retries an uncertain create with the same frozen request and only opens after acknowledgement", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const create = vi.spyOn(api, "createCompanion")
      .mockRejectedValueOnce(new Error("The response was lost."))
      .mockResolvedValueOnce({ companion });
    vi.spyOn(workspaceApi, "selectPlugin").mockResolvedValue({ ok: true });
    vi.spyOn(workspaceApi, "setTemplatePermission").mockResolvedValue({ templateId: "researcher", maxChildren: 2 });
    render(<CreateCompanion config={config} onCreated={onCreated}/>);
    await enterBasics(user);
    await user.click(screen.getByRole("button", { name: "Create companion" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The response was lost.");
    expect(onCreated).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Resume setup" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(companion));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
    expect(create.mock.calls[0][0]).toMatchObject({ name: "Ada", instructions: "Research the market", provider: "box", prepare: false });
    expect(create.mock.calls[0][0].clientCreationId).toBeTruthy();
  });

  it("pins the chosen starting profile and creates without preparing a computer", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createCompanion").mockResolvedValue({ companion });
    const grantAccount = vi.spyOn(workspaceApi, "selectPlugin");
    const grantSpecialist = vi.spyOn(workspaceApi, "setTemplatePermission");
    const onCreated = vi.fn();
    render(<CreateCompanion config={config} onCreated={onCreated}/>);
    await screen.findByRole("heading", { name: "Linear" });
    await user.click(screen.getByText("Advanced", { exact: false }));
    await user.selectOptions(screen.getByLabelText("Start from"), "researcher");
    expect(screen.getByLabelText("Name")).toHaveValue("Researcher");
    await user.click(screen.getByRole("button", { name: "Create companion" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(companion));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "Researcher", templateId: "researcher", templateRevision: 4, prepare: false,
    }));
    expect(grantAccount).not.toHaveBeenCalled();
    expect(grantSpecialist).not.toHaveBeenCalled();
  });

  it("can open an already-created companion when an optional grant cannot finish", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    vi.spyOn(api, "createCompanion").mockResolvedValue({ companion });
    vi.spyOn(workspaceApi, "selectPlugin").mockRejectedValue(new Error("This account is no longer connected."));
    render(<CreateCompanion config={config} onCreated={onCreated}/>);
    await enterBasics(user);
    await user.click(screen.getByRole("checkbox", { name: "Work workspace" }));
    await user.click(screen.getByRole("button", { name: "Create companion" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This account is no longer connected.");

    await user.click(screen.getByRole("button", { name: "Open companion and finish later" }));
    expect(onCreated).toHaveBeenCalledWith(companion);
  });

  it("resumes the same frozen creation ID after remount for the same owner", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createCompanion")
      .mockRejectedValueOnce(new Error("Connection lost."))
      .mockResolvedValueOnce({ companion });
    const first = render(<CreateCompanion config={config} ownerId="owner-1" onCreated={vi.fn()}/>);
    await enterBasics(user);
    await user.click(screen.getByRole("button", { name: "Create companion" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost.");
    first.unmount();

    const onCreated = vi.fn();
    render(<CreateCompanion config={config} ownerId="owner-1" onCreated={onCreated}/>);
    await screen.findByRole("heading", { name: "Linear" });
    expect(screen.getByLabelText("Name")).toHaveValue("Ada");
    expect(screen.getByLabelText("Name")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Resume setup" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(companion));
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
  });

  it("does not navigate when creation resolves after the component unmounts", async () => {
    let resolveCreate!: (value: { companion: Companion }) => void;
    vi.spyOn(api, "createCompanion").mockReturnValue(new Promise(resolve => { resolveCreate = resolve; }));
    const onCreated = vi.fn();
    const user = userEvent.setup();
    const view = render(<CreateCompanion config={config} ownerId="owner-1" onCreated={onCreated}/>);
    await enterBasics(user);
    await user.click(screen.getByRole("button", { name: "Create companion" }));
    view.unmount();
    resolveCreate({ companion });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("releases navigation after a definite activation rejection and retries the exact request", async () => {
    const user = userEvent.setup();
    const onSetupLockedChange = vi.fn();
    const create = vi.spyOn(api, "createCompanion")
      .mockRejectedValueOnce(new ApiError("Activate your account to create a companion.", 402))
      .mockResolvedValueOnce({ companion });
    const onCreated = vi.fn();
    render(<CreateCompanion config={config} ownerId="owner-1" onCreated={onCreated} onSetupLockedChange={onSetupLockedChange}/>);
    await enterBasics(user);
    await user.click(screen.getByRole("button", { name: "Create companion" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Activate your account");
    expect(screen.getByText(/leave this page to resolve the account issue/i)).toBeInTheDocument();
    expect(onSetupLockedChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByLabelText("Name")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Resume setup" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(companion));
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
  });

  it("keeps creation unavailable when setup choices fail and loads them on retry", async () => {
    vi.restoreAllMocks();
    vi.spyOn(workspaceApi, "templates").mockRejectedValueOnce(new Error("Profiles are unavailable.")).mockResolvedValue({ templates });
    vi.spyOn(workspaceApi, "plugins").mockResolvedValue({ accounts: [], catalog: [] });
    const user = userEvent.setup();
    render(<CreateCompanion config={config} onCreated={vi.fn()}/>);

    expect(await screen.findByRole("alert")).toHaveTextContent("Profiles are unavailable.");
    expect(screen.getByRole("button", { name: "Create companion" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("checkbox", { name: /Researcher/ })).toBeInTheDocument();
    expect(workspaceApi.templates).toHaveBeenCalledTimes(2);
  });
});
