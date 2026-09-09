import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineSettings, TriggerSettings } from "./AutomationPanels";

const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
beforeEach(() => vi.unstubAllGlobals());

describe("routine operations", () => {
  it("runs a routine explicitly and opens its persisted history", async () => {
    let tested = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/companions/c1/routines") return response({ routines: [{ id: "r1", name: "Morning brief", prompt: "Brief me", cron: "0 9 * * 1-5", timezone: "Europe/Paris", enabled: true }] });
      if (path === "/api/companions/c1/routines/r1/test" && options?.method === "POST") { tested = true; return response({ runId: "run1" }); }
      if (path === "/api/companions/c1/routines/r1/history") return response({ runs: tested ? [{ id: "run1", status: "queued", resultText: null, error: null, scheduledFor: new Date().toISOString(), acceptedAt: new Date().toISOString() }] : [], missed: [] });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<RoutineSettings companionId="c1" />);
    expect(screen.queryByRole("button", { name: "Run Morning brief now" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /^Morning brief/ }));
    await user.click(await screen.findByRole("button", { name: "Run Morning brief now" }));
    expect(await screen.findByText("queued")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/companions/c1/routines/r1/test", expect.objectContaining({ method: "POST" }));
  });
});

describe("trigger operations", () => {
  it("sends provider account and GitHub target while keeping filters collapsed", async () => {
    let created: Record<string, unknown> | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/companions/c1/triggers" && options?.method === "POST") { created = JSON.parse(String(options.body)); return response({ trigger: { id: "t1", ...created, registrationStatus: "registered" } }, 201); }
      if (path === "/api/companions/c1/triggers") return response({ triggers: created ? [{ id: "t1", ...created, registrationStatus: "registered" }] : [] });
      if (path === "/api/plugins") return response({ catalog: [], accounts: [{ id: "a1", serverId: "github", provider: "github", label: "Work GitHub" }] });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TriggerSettings companionId="c1" />);
    await screen.findByText(/A failed build/);
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New trigger" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Main failed");
    await user.selectOptions(screen.getByRole("combobox", { name: "Source" }), "github");
    await user.selectOptions(screen.getByRole("combobox", { name: "Account" }), "a1");
    await user.type(screen.getByRole("textbox", { name: "Repository" }), "acme/web");
    await user.type(screen.getByRole("textbox", { name: "What should happen?" }), "Investigate the failure");
    expect(screen.queryByRole("textbox", { name: "Filter code" })).not.toBeInTheDocument();
    await user.click(screen.getByText("Filter and grouping"));
    await user.click(screen.getByRole("checkbox", { name: "Run only when code accepts the event" }));
    await user.type(screen.getByRole("textbox", { name: "Filter code" }), "return issue.open === true");
    await user.click(screen.getByRole("button", { name: "Add read" }));
    await user.type(screen.getByRole("textbox", { name: "Read 1 name" }), "issue");
    await user.selectOptions(screen.getByRole("combobox", { name: "Read 1 account" }), "a1");
    await user.type(screen.getByRole("textbox", { name: "Read 1 path" }), "acme/web/issues/1");
    await user.click(screen.getByRole("button", { name: "Add trigger" }));
    await waitFor(() => expect(created).toMatchObject({
      providerAccountId: "a1",
      target: { repo: "acme/web", branch: "main", events: ["workflow_run"] },
      mode: "filter",
      filter: "return issue.open === true",
      filterRequests: [{ key: "issue", provider: "github", connectionId: "a1", path: "acme/web/issues/1" }],
    }));
  });

  it("tests an event without enqueueing and shows delivery decisions", async () => {
    const trigger = { id: "t1", name: "Webhook", prompt: "Inspect", source: "generic", mode: "direct", enabled: true, registrationStatus: "manual", url: "http://localhost/api/webhooks/t1" };
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/companions/c1/triggers") return response({ triggers: [trigger] });
      if (path === "/api/plugins") return response({ catalog: [], accounts: [] });
      if (path.endsWith("/deliveries")) return response({ deliveries: [{ id: "d1", eventName: "example", payload: {}, status: "ignored", decision: "ignored", errorCode: null, receivedAt: new Date().toISOString(), decidedAt: new Date().toISOString(), batchId: null, runId: null }] });
      if (path.endsWith("/test") && options?.method === "POST") return response({ decision: "trigger" });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TriggerSettings companionId="c1" />);
    await user.click(await screen.findByRole("button", { name: /^Webhook Webhook/ }));
    expect(await screen.findByText("example · ignored")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test only" })).not.toBeVisible();
    await user.click(screen.getByText("Test an event"));
    await user.click(screen.getByRole("button", { name: "Test only" }));
    expect(await screen.findByText("Would start work")).toBeInTheDocument();
  });
});

describe("progressive automation settings", () => {
  it("opens routine creation only on request and keeps the local draft when closed", async () => {
    vi.stubGlobal("fetch", vi.fn(() => response({ routines: [] })));
    const user = userEvent.setup();
    render(<RoutineSettings companionId="c1" />);
    await screen.findByText(/A morning brief/);
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    const create = screen.getByRole("button", { name: "New routine" });
    expect(create).toHaveAttribute("aria-expanded", "false");
    await user.click(create);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Friday review");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(create).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    await user.click(create);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Friday review");
  });

  it("edits instructions without re-enabling a paused routine or replacing a custom schedule", async () => {
    let routine = { id: "r1", name: "Review", prompt: "Review the work", cron: "15 11 * * 2", timezone: "Europe/Paris", enabled: false };
    let patch: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === "PATCH") { patch = JSON.parse(String(options.body)); routine = { ...routine, ...patch }; return response({ routine }); }
      if (String(input).endsWith("/history")) return response({ runs: [], missed: [] });
      return response({ routines: [routine] });
    }));
    const user = userEvent.setup();
    render(<RoutineSettings companionId="c1" />);
    await user.click(await screen.findByRole("button", { name: /^Review/ }));
    await screen.findByText("No runs yet.");
    await user.click(screen.getByText("Edit routine"));
    await user.clear(screen.getByRole("textbox", { name: "Instructions" }));
    await user.type(screen.getByRole("textbox", { name: "Instructions" }), "Review recent issues");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patch).toEqual({ name: "Review", prompt: "Review recent issues", cron: "15 11 * * 2", timezone: "Europe/Paris", publicationMode: "auto" }));
    expect(screen.getByRole("switch", { name: "Enable Review" })).not.toBeChecked();
  });

  it("shows toggle failures, preserves the saved state and requires a second action to delete", async () => {
    let deleted = false;
    const trigger = { id: "t1", name: "Build failure", prompt: "Inspect", source: "generic", mode: "direct", enabled: true };
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === "PATCH") return response({ error: "Please try again." }, 503);
      if (options?.method === "DELETE") { deleted = true; return response({ ok: true }); }
      if (String(input).endsWith("/deliveries")) return response({ deliveries: [] });
      if (String(input) === "/api/plugins") return response({ accounts: [], catalog: [] });
      return response({ triggers: deleted ? [] : [trigger] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TriggerSettings companionId="c1" />);
    await user.click(await screen.findByRole("switch", { name: "Enable Build failure" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Please try again.");
    expect(screen.getByRole("switch", { name: "Enable Build failure" })).toBeChecked();
    expect(screen.queryByRole("button", { name: "Delete Build failure" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Build failure/ }));
    await screen.findByText("No deliveries yet.");
    await user.click(screen.getByRole("button", { name: "Delete Build failure" }));
    expect(deleted).toBe(false);
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(deleted).toBe(false);
    await user.click(screen.getByRole("button", { name: "Delete Build failure" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete Build failure" }));
    await waitFor(() => expect(deleted).toBe(true));
    expect(await screen.findByText(/A failed build/)).toBeInTheDocument();
  });

  it("does not carry a creation draft into another Companion", async () => {
    vi.stubGlobal("fetch", vi.fn(() => response({ routines: [] })));
    const user = userEvent.setup();
    const view = render(<RoutineSettings companionId="c1" />);
    await user.click(screen.getByRole("button", { name: "New routine" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Private draft");
    view.rerender(<RoutineSettings companionId="c2" />);
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New routine" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
  });
});

it.each(['auto', 'always', 'silent'])("persists the %s publication mode when creating a routine", async mode => {
  let created: Record<string, unknown> | undefined;
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, options?: RequestInit) => {
    if (options?.method === 'POST') { created = JSON.parse(String(options.body)); return response({ routine: { id: 'r1', ...created } }); }
    return response({ routines: created ? [{ id: 'r1', ...created }] : [] });
  }));
  const user = userEvent.setup();
  render(<RoutineSettings companionId="c1"/>);
  await screen.findByText(/A morning brief/);
  await user.click(screen.getByRole('button', { name: 'New routine' }));
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Bonjour');
  await user.type(screen.getByRole('textbox', { name: 'What should happen?' }), 'Say hello');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Chat messages' }), mode);
  await user.click(screen.getByRole('button', { name: 'Add routine' }));
  await waitFor(() => expect(created).toMatchObject({ name: 'Bonjour', publicationMode: mode }));
});

it('opens the linked routine and preserves publication edits on save failure', async () => {
  const routine = { id: 'r1', name: 'Bonjour', prompt: 'Say hello', cron: '0 9 * * *', timezone: 'Europe/Paris', enabled: true, publicationMode: 'silent' };
  let patch: Record<string, unknown> | undefined;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    if (options?.method === 'PATCH') { patch = JSON.parse(String(options.body)); return response({ error: 'Could not save' }, 503); }
    if (String(input).endsWith('/history')) return response({ runs: [], missed: [] });
    return response({ routines: [routine] });
  }));
  render(<RoutineSettings companionId="c1" initialRoutineId="r1"/>);
  await screen.findByText('Chat messages: Silent');
  await screen.findByText('No runs yet.');
  const user = userEvent.setup();
  await user.click(screen.getByText('Edit routine'));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Chat messages' }), 'always');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
  expect(screen.getByText('Chat messages: Silent')).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Chat messages' })).toHaveValue('always');
  expect(patch).toMatchObject({ publicationMode: 'always' });
});
