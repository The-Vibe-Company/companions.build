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
  await user.type(screen.getByLabelText("Role"), "Research the market");
}

beforeEach(() => { window.sessionStorage.clear(); mockSetup(); vi.spyOn(workspaceApi, "prepare").mockResolvedValue({}); });
afterEach(() => vi.restoreAllMocks());

describe("CreateCompanion", () => {
  it.each(["future-v2", { invalid: "profile" }])("preserves an unsupported saved creation without crashing or silently retyping it", async profileId => {
    const create = vi.spyOn(api, "createCompanion");
    const intent = { request: { clientCreationId: "kept-creation-id", name: "Ada", instructions: "Saved mission", provider: "box", profileId }, accountIds: [], specialistIds: [], completedAccountIds: [], completedSpecialistIds: [] };
    window.sessionStorage.setItem("companions.create.pending.owner", JSON.stringify(intent));
    render(<CreateCompanion config={config} ownerId="owner" onCreated={vi.fn()}/>);
    expect(await screen.findByRole("alert")).toHaveTextContent("type unavailable in this app version");
    expect(screen.getByLabelText("Companion type")).toHaveDisplayValue("Unavailable Companion type");
    expect(screen.getByRole("button", { name: "Resume setup" })).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
    expect(JSON.parse(window.sessionStorage.getItem("companions.create.pending.owner")!)).toEqual(intent);
  });
  it("freezes an explicit Design type with the creation intent and retries the same profile", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createCompanion").mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({ companion: { ...companion, profileId: "design-v2" } });
    render(<CreateCompanion config={config} onCreated={vi.fn()}/>);
    await enterBasics(user);
    await user.selectOptions(screen.getByLabelText("Companion type"), "design-v2");
    await user.click(screen.getByRole("button", { name: "Create companion" }));
    await screen.findByText("Connection lost");
    expect(screen.getByLabelText("Companion type")).toBeDisabled();
    expect(create.mock.calls[0][0].profileId).toBe("design-v2");
    await user.click(screen.getByRole("button", { name: "Resume setup" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][0]).toEqual(create.mock.calls[0][0]);
  });
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
    await user.click(screen.getByText("More colors & expressions"));
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
    expect(create.mock.calls[0][0]).toMatchObject({ name: "Ada", instructions: "Research the market", provider: "box", prepare: true });
    expect(create.mock.calls[0][0].clientCreationId).toBeTruthy();
    expect(workspaceApi.prepare).not.toHaveBeenCalled();
  });

  it("pins the chosen starting profile and immediately requests computer preparation", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createCompanion").mockResolvedValue({ companion });
    const grantAccount = vi.spyOn(workspaceApi, "selectPlugin");
    const grantSpecialist = vi.spyOn(workspaceApi, "setTemplatePermission");
    const onCreated = vi.fn();
    render(<CreateCompanion config={config} onCreated={onCreated}/>);
    await screen.findByRole("heading", { name: "Linear" });
    await user.click(screen.getByText("Starting profile"));
    await user.selectOptions(screen.getByLabelText("Start from"), "researcher");
    expect(screen.getByLabelText("Name")).toHaveValue("Researcher");
    await user.click(screen.getByRole("button", { name: "Create companion" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(companion));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "Researcher", templateId: "researcher", templateRevision: 4, prepare: true,
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

  it("sends a randomized avatar in the creation request when no template or session is restored", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createCompanion").mockResolvedValue({ companion });
    render(<CreateCompanion config={config} onCreated={vi.fn()}/>);
    await enterBasics(user);
    await user.click(screen.getByRole("button", { name: "Create companion" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const sent = create.mock.calls[0][0].avatar!;
    expect(sent.shape).toBeGreaterThanOrEqual(0);
    expect(sent.shape).toBeLessThanOrEqual(7);
    expect(sent.color).toBeGreaterThanOrEqual(0);
    expect(sent.color).toBeLessThanOrEqual(10);
    expect(sent.face).toBeGreaterThanOrEqual(0);
    expect(sent.face).toBeLessThanOrEqual(4);
  });

  it("overrides random avatar with the chosen template avatar", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createCompanion").mockResolvedValue({ companion });
    render(<CreateCompanion config={config} onCreated={vi.fn()}/>);
    await screen.findByRole("heading", { name: "Linear" });
    await user.click(screen.getByText("Starting profile"));
    await user.selectOptions(screen.getByLabelText("Start from"), "researcher");
    await user.click(screen.getByRole("button", { name: "Create companion" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].avatar).toEqual({ shape: 3, color: 5, face: 2 });
  });

  it("keeps the same avatar across retries so uncertain create retries produce the same logo", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createCompanion")
      .mockRejectedValueOnce(new Error("Lost."))
      .mockResolvedValueOnce({ companion });
    render(<CreateCompanion config={config} onCreated={vi.fn()}/>);
    await enterBasics(user);
    await user.click(screen.getByRole("button", { name: "Create companion" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Lost.");
    await user.click(screen.getByRole("button", { name: "Resume setup" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0][0].avatar).toEqual(create.mock.calls[1][0].avatar);
  });
});


it.each(['box','local'] as const)('uses the configured %s provider without a runtime picker',async(provider)=>{
 const create=vi.spyOn(api,'createCompanion').mockResolvedValue({companion:{...companion,provider}});
 const user=userEvent.setup();
 render(<CreateCompanion config={{...config,defaultProvider:provider,localAvailable:provider==='local'}} onCreated={vi.fn()}/>);
 await enterBasics(user);
 expect(screen.queryByRole('radio',{name:/Local/})).not.toBeInTheDocument();
 expect(screen.queryByRole('radio',{name:/Box/})).not.toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'Create companion'}));
 await waitFor(()=>expect(create).toHaveBeenCalledWith(expect.objectContaining({provider, prepare: true})));
});

it("resumes legacy lazy creation unchanged and persists preparation across grant retries and remount", async () => {
  const request = { clientCreationId: crypto.randomUUID(), name: "Ada", instructions: "Research the market", provider: "box" as const, prepare: false };
  window.sessionStorage.setItem("companions.create.pending.owner-1", JSON.stringify({
    request, accountIds: ["linear-work"], specialistIds: [], completedAccountIds: [], completedSpecialistIds: [],
  }));
  const create = vi.spyOn(api, "createCompanion").mockResolvedValue({ companion });
  vi.spyOn(api, "getCompanion").mockResolvedValue({ companion, messages: [], runs: [], activity: [] });
  const prepare = vi.mocked(workspaceApi.prepare).mockRejectedValueOnce(new Error("Preparation response lost.")).mockResolvedValue({});
  const grant = vi.spyOn(workspaceApi, "selectPlugin").mockRejectedValueOnce(new Error("Grant failed.")).mockResolvedValue({ ok: true });
  const user = userEvent.setup();
  const first = render(<CreateCompanion config={config} ownerId="owner-1" onCreated={vi.fn()}/>);
  await screen.findByRole("heading", { name: "Linear" });
  await user.click(screen.getByRole("button", { name: "Resume setup" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Preparation response lost.");
  expect(create).toHaveBeenCalledExactlyOnceWith(request);
  expect(grant).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Resume setup" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Grant failed.");
  expect(prepare.mock.calls).toEqual([[companion.id], [companion.id]]);
  first.unmount();
  const onCreated = vi.fn();
  render(<CreateCompanion config={config} ownerId="owner-1" onCreated={onCreated}/>);
  await screen.findByRole("heading", { name: "Linear" });
  await user.click(screen.getByRole("button", { name: "Resume setup" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(companion));
  expect(create).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledTimes(2);
});
