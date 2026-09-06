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
    await screen.findByText("No triggers yet.");
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
    await user.click(await screen.findByRole("button", { name: /^Webhook generic/ }));
    expect(await screen.findByText("example · ignored")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test only" }));
    expect(await screen.findByText("Would start work")).toBeInTheDocument();
  });
});
