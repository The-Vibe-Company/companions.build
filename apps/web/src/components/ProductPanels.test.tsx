import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProduct, DeliverySettings, DesktopSheet, SpecialistsSettings } from "./ProductPanels";
import { mailApi, type Companion } from "@/api";

const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => { vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); vi.spyOn(mailApi, "account").mockResolvedValue({ configured: false, alias: null, domain: "mail.companions.build", quota: { used: 0, limit: 50, resetsAt: "2026-09-08T00:00:00Z" } }); });
afterEach(() => vi.useRealTimers());

describe("account delivery", () => {
  it.each([true,false])("shows private beta access accurately without offering Checkout (active=%s)",async active=>{
    vi.stubGlobal("fetch",vi.fn((input:RequestInfo|URL)=>{
      if(String(input)==="/api/billing")return response({configured:true,mode:"beta",plan:active?"beta":"inactive",active,status:null,currentPeriodEnd:null,cancelAtPeriodEnd:false,portalAvailable:false,usage:[]});
      if(String(input)==="/api/deliveries")return response({sent:[],received:[]});
      if(String(input)==="/api/maintenance")return response({companions:[]});
      throw new Error("Unexpected request");
    }));
    render(<AccountProduct user={{id:"u1",name:"Alex",email:"alex@example.com"}} onSignOut={vi.fn()}/>);
    expect(await screen.findByText(active?"Private beta access enabled":"Private beta access unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Subscribe"})).not.toBeInTheDocument();
    expect(screen.queryByText("No subscription")).not.toBeInTheDocument();
    expect(screen.getByText(active?"No subscription required for access.":"This account is not on the private beta list.")).toBeInTheDocument();
  });

  it("presents customer usage without internal lifecycle audit events", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/billing") return response({ configured: true, mode: "stripe", plan: "subscription", active: true, status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false, portalAvailable: true, usage: [
        { category: "box_lifecycle", unit: "event", quantity: "9" },
        { category: "box_seconds", unit: "second", quantity: "7385" },
        { category: "model_tokens", unit: "token", quantity: "12345" },
      ] });
      if (String(input) === "/api/deliveries") return response({ sent: [], received: [] });
      if (String(input) === "/api/maintenance") return response({ companions: [] });
      throw new Error(`Unexpected ${String(input)}`);
    }));
    render(<AccountProduct user={{ id: "u1", name: "Alex", email: "alex@example.com" }} onSignOut={vi.fn()} />);
    expect(await screen.findByText("2 hr 3 min 5 sec")).toBeInTheDocument();
    expect(screen.getByText(new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(12345n))).toBeInTheDocument();
    expect(screen.getByText("Computer time")).toBeInTheDocument();
    expect(screen.getByText("Model usage")).toBeInTheDocument();
    expect(screen.queryByText(/box lifecycle/i)).not.toBeInTheDocument();
    expect(screen.getByTitle(new Intl.NumberFormat().format(12345n) + " tokens")).toBeInTheDocument();
  });

  it("shows real inactive billing and sends the client maintenance choice", async () => {
    let accepted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/billing") return response({ configured: true, mode: "stripe", plan: "inactive", active: false, status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, portalAvailable: false, usage: [] });
      if (path === "/api/deliveries" && !options?.method) return response({ sent: [], received: accepted ? [] : [{ id: "d1", name: "Scout", status: "pending", skillsStatus: "ready", skillsError: null, softwareStatus: "ready", softwareError: null, maintenanceRequested: true, expiresAt: new Date().toISOString(), acceptedAt: null, companionId: null }] });
      if (path === "/api/deliveries/d1/accept") { accepted = true; return response({ companionId: "copy", accepted: true }); }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AccountProduct user={{ id: "u1", name: "Alex", email: "alex@example.com" }} onSignOut={vi.fn()} />);
    expect(await screen.findByText("No subscription")).toBeInTheDocument();
    expect(screen.getByText("Subscription + usage appear here.")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Allow maintenance" }));
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/deliveries/d1/accept", expect.objectContaining({ body: JSON.stringify({ grantMaintenance: true }) })));
  });

  it("shows preparing, failed, and ready delivery states without claiming an email was sent", async () => {
    const base = { status: "pending", maintenanceRequested: false, expiresAt: new Date().toISOString(), acceptedAt: null, companionId: null };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/billing") return response({ configured: false, mode: "unconfigured", plan: "inactive", active: false, status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, portalAvailable: false, usage: [] });
      if (path === "/api/deliveries") return response({ received: [], sent: [
        { ...base, id: "d1", clientEmail: "preparing@example.com", skillsStatus: "pending", skillsError: null, softwareStatus: "ready", softwareError: null },
        { ...base, id: "d2", clientEmail: "failed@example.com", skillsStatus: "error", skillsError: "Skill export failed safely", softwareStatus: "ready", softwareError: null },
        { ...base, id: "d3", clientEmail: "ready@example.com", skillsStatus: "ready", skillsError: null, softwareStatus: "ready", softwareError: null },
        { ...base, id: "d4", clientEmail: "software@example.com", skillsStatus: "ready", skillsError: null, softwareStatus: "pending", softwareError: null },
        { ...base, id: "d5", clientEmail: "software-error@example.com", skillsStatus: "ready", skillsError: null, softwareStatus: "error", softwareError: "Software preparation failed safely" },
      ] });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountProduct user={{ id: "u1", name: "Alex", email: "alex@example.com" }} onSignOut={vi.fn()} />);
    expect(await screen.findByText("Preparing skills…")).toBeInTheDocument();
    expect(screen.getByText("Skill export failed safely")).toBeInTheDocument();
    expect(screen.getByText("Ready for client")).toBeInTheDocument();
    expect(screen.getByText("Preparing software…")).toBeInTheDocument();
    expect(screen.getByText("Software preparation failed safely")).toBeInTheDocument();
    expect(screen.queryByText(/invitation sent/i)).not.toBeInTheDocument();
  });

  it("keeps acceptance disabled until both skills and software are ready", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/billing") return response({ configured: false, mode: "unconfigured", plan: "inactive", active: false, status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, portalAvailable: false, usage: [] });
      if (String(input) === "/api/maintenance") return response({ companions: [] });
      if (String(input) === "/api/deliveries") return response({ sent: [], received: [{ id: "d1", name: "Scout", status: "pending", skillsStatus: "ready", skillsError: null, softwareStatus: "pending", softwareError: null, maintenanceRequested: false, expiresAt: new Date().toISOString(), acceptedAt: null, companionId: null }] });
      throw new Error(`Unexpected ${String(input)}`);
    }));
    render(<AccountProduct user={{ id: "u1", name: "Alex", email: "alex@example.com" }} onSignOut={vi.fn()} />);
    expect(await screen.findByText("Preparing software…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
  });

  it("polls only while a delivery is preparing", async () => {
    vi.useFakeTimers(); let deliveryCalls = 0;
    const billing = { configured: false, mode: "unconfigured", plan: "inactive", active: false, status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, portalAvailable: false, usage: [] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/billing") return response(billing);
      if (String(input) === "/api/maintenance") return response({ companions: [] });
      if (String(input) === "/api/deliveries") { deliveryCalls++; return response({ received: [], sent: [{ id: "d1", clientEmail: "client@example.com", status: "pending", skillsStatus: "ready", skillsError: null, softwareStatus: deliveryCalls === 1 ? "pending" : "ready", softwareError: null, maintenanceRequested: false, expiresAt: new Date().toISOString(), acceptedAt: null, companionId: null }] }); }
      throw new Error(`Unexpected ${String(input)}`);
    }));
    render(<AccountProduct user={{ id: "u1", name: "Alex", email: "alex@example.com" }} onSignOut={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText("Preparing software…")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByText("Ready for client")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(deliveryCalls).toBe(2);
  });

  it("rechecks account state after returning from Checkout and stops once active", async () => {
    vi.useFakeTimers(); window.history.replaceState({}, "", "/account?checkout=complete"); let billingCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/billing") { billingCalls++; return response({ configured: true, mode: "stripe", plan: billingCalls === 1 ? "inactive" : "subscription", active: billingCalls > 1, status: billingCalls === 1 ? null : "active", currentPeriodEnd: null, cancelAtPeriodEnd: false, portalAvailable: billingCalls > 1, usage: [] }); }
      if (String(input) === "/api/deliveries") return response({ received: [], sent: [] });
      if (String(input) === "/api/maintenance") return response({ companions: [] });
      throw new Error(`Unexpected ${String(input)}`);
    }));
    render(<AccountProduct user={{ id: "u1", name: "Alex", email: "alex@example.com" }} onSignOut={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByText("Subscription active")).toBeInTheDocument();
    expect(window.location.search).toBe("");
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(billingCalls).toBe(2);
  });

  it("keeps granted maintenance bounded to configuration, diagnostics, and tasks", async () => {
    const taskBodies: Array<{ clientMessageId: string; prompt: string }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/billing") return response({ configured: false, mode: "unconfigured", plan: "inactive", active: false, status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, portalAvailable: false, usage: [] });
      if (path === "/api/deliveries") return response({ sent: [], received: [] });
      if (path === "/api/maintenance") return response({ companions: [{ id: "c1", name: "Client Scout", status: "ready", error: null, grantId: "g1" }] });
      if (path === "/api/maintenance/companions/c1") return response({ companion: { id: "c1", name: "Client Scout", instructions: "Research leads", modelId: null, status: "ready", error: null, readyAt: new Date().toISOString() } });
      if (path.endsWith("/actions")) return response({ actions: [] });
      if (path.endsWith("/tasks") && options?.method === "POST") { taskBodies.push(JSON.parse(String(options.body))); return response({ runId: "run1" }, 202); }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AccountProduct user={{ id: "u1", name: "Alex", email: "alex@example.com" }} onSignOut={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /Client Scout ready/ }));
    expect(await screen.findByText(/allowed configuration, diagnostics, and maintenance tasks/i)).toBeInTheDocument();
    expect(screen.getByText(/chat and files stay private/i)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "What should improve?" }), "Tighten the weekly report");
    await user.click(screen.getByRole("button", { name: "Assign task" }));
    await waitFor(() => expect(taskBodies[0]).toMatchObject({ prompt: "Tighten the weekly report" }));
    expect(taskBodies[0].clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses the client delivery id when a submission is retried", async () => {
    const bodies: Array<{ clientDeliveryId: string }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      if (String(input) === "/api/templates") return response({ templates: [] });
      if (String(input) === "/api/deliveries") {
        bodies.push(JSON.parse(String(options?.body)) as { clientDeliveryId: string });
        return bodies.length === 1 ? response({ error: "Try again" }, 503) : response({ delivery: { status: "pending", skillsStatus: "ready", skillsError: null, softwareStatus: "ready", softwareError: null } });
      }
      throw new Error(`Unexpected ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<DeliverySettings companionId="c1" />);
    await user.type(screen.getByRole("textbox", { name: "Client email" }), "client@example.com");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByText("Try again")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    await screen.findByText("Invitation ready.");
    expect(bodies).toHaveLength(2);
    expect(bodies[1].clientDeliveryId).toBe(bodies[0].clientDeliveryId);
  });

  it("reports software preparation after creating a delivery without claiming readiness", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/templates") return response({ templates: [] });
      if (String(input) === "/api/deliveries") return response({ delivery: { status: "pending", skillsStatus: "ready", skillsError: null, softwareStatus: "pending", softwareError: null } }, 201);
      throw new Error(`Unexpected ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<DeliverySettings companionId="c1" />);
    await user.type(screen.getByRole("textbox", { name: "Client email" }), "client@example.com");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByText("Preparing software… Follow progress in Account.")).toBeInTheDocument();
    expect(screen.queryByText(/invitation sent/i)).not.toBeInTheDocument();
  });
});

describe("desktop control", () => {
  it("waits for persisted desktop confirmation before claiming control", async () => {
    const fetchMock = vi.fn(() => response({ requested: true }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const companion: Companion = { id: "c1", name: "Luna", instructions: "", provider: "box", status: "ready", error: null, createdAt: new Date().toISOString(), desktopTaken: false, desktopPausedAt: null };
    const refresh = vi.fn().mockResolvedValue(undefined);
    const view = render(<DesktopSheet companion={companion} onClose={vi.fn()} onRefresh={refresh} />);
    await user.click(screen.getByRole("button", { name: "Take control" }));
    expect(screen.getByRole("button", { name: "Taking control…" })).toBeDisabled();
    expect(screen.queryByText("You have control")).not.toBeInTheDocument();
    view.rerender(<DesktopSheet companion={{ ...companion, desktopTaken: true, desktopPausedAt: new Date().toISOString() }} onClose={vi.fn()} onRefresh={refresh} />);
    expect(screen.getByText("You have control")).toBeInTheDocument();
  });

  it("keeps the user-opened tab and polls until the desktop URL is ready", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(() => response(++calls === 1 ? { preparing: true } : { url: "https://desktop.example/session" }, calls === 1 ? 202 : 200));
    vi.stubGlobal("fetch", fetchMock);
    const replace = vi.fn(); const close = vi.fn();
    const popup = { closed: false, close, location: { replace }, document: { title: "", body: { textContent: "", style: { cssText: "" } } } } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const companion: Companion = { id: "c1", name: "Luna", instructions: "", provider: "box", status: "ready", error: null, createdAt: new Date().toISOString() };
    const view = render(<DesktopSheet companion={companion} onClose={vi.fn()} onRefresh={vi.fn().mockResolvedValue(undefined)} />);
    screen.getByRole("button", { name: "Open desktop" }).click();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByText("Preparing desktop…")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(replace).toHaveBeenCalledWith("https://desktop.example/session");
    view.unmount();
    expect(close).not.toHaveBeenCalled();
  });
});

describe("specialist profile history", () => {
  it("shows a plain preparation status for a profile with pinned software", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/templates") return response({ templates: [{ id: "t1", name: "Researcher", instructions: "Current", avatar: { shape: 0, color: 0, face: 0 }, revision: 2, sourceCompanionId: null, softwareBuildId: "b1", softwareResultId: null, hasSnapshot: false }] });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      if (path === "/api/templates/t1/revisions") return response({ revisions: [] });
      if (path === "/api/templates/t1/software/status") return response({ templateId: "t1", templateRevision: 2, build: { id: "b1", status: "installing", verified: false, errorCode: null }, result: null });
      throw new Error(`Unexpected ${path}`);
    }));
    render(<SpecialistsSettings companionId="c1" />);
    expect(await screen.findByText("Software is being prepared.")).toBeInTheDocument();
  });

  it("restores a selected immutable revision and shows a concurrent-change conflict", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/templates") return response({ templates: [{ id: "t1", name: "Researcher", instructions: "Current", avatar: { shape: 0, color: 0, face: 0 }, revision: 2, sourceCompanionId: null, hasSnapshot: false }] });
      if (path === "/api/companions/c1/replicas") return response({ replicas: [] });
      if (path === "/api/templates/t1/revisions") return response({ revisions: [
        { revision: 2, name: "Researcher", instructions: "Current", avatar: { shape: 0, color: 0, face: 0 }, snapshotName: null, sourceCompanionId: null, createdAt: new Date().toISOString() },
        { revision: 1, name: "Researcher", instructions: "Earlier", avatar: { shape: 0, color: 0, face: 0 }, snapshotName: null, sourceCompanionId: null, createdAt: new Date().toISOString() },
      ] });
      if (path === "/api/templates/t1/rollback" && options?.method === "POST") return response({ error: "Template missing, changed, or revision unavailable." }, 409);
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SpecialistsSettings companionId="c1" />);
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    expect(await screen.findByText("Template missing, changed, or revision unavailable.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/templates/t1/rollback", expect.objectContaining({ method: "POST", body: JSON.stringify({ targetRevision: 1, expectedRevision: 2 }) }));
  });
});

describe("embedded computer controls", () => {
  const companion: Companion = { id: "c1", name: "Luna", instructions: "", provider: "box", status: "ready", error: null, createdAt: "2026-09-07T00:00:00Z", desktopTaken: true, desktopPausedAt: "2026-09-07T00:00:00Z" };
  it("renders a page section and releases control only through the explicit action", async () => {
    const fetchMock = vi.fn((..._args: unknown[]) => response({ requested: true }));
    vi.stubGlobal("fetch", fetchMock);
    const props = { companion, onClose: vi.fn(), onRefresh: vi.fn().mockResolvedValue(undefined), embedded: true };
    const view = render(<DesktopSheet {...props} />);
    expect(screen.getByRole("region", { name: "Computer controls" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close desktop controls" })).not.toBeInTheDocument();
    expect(screen.getByText("You have control")).toBeInTheDocument();
    view.rerender(<DesktopSheet {...props} active={false} />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender(<DesktopSheet {...props} active />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Release desktop" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("desktop/release");
    view.unmount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("stops pending viewer polling when the tab is hidden without releasing human control", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => response({ preparing: true }, 202));
    vi.stubGlobal("fetch", fetchMock);
    const close = vi.fn(), replace = vi.fn();
    vi.spyOn(window, "open").mockReturnValue({ closed: false, close, location: { replace }, document: { title: "", body: { textContent: "", style: { cssText: "" } } } } as unknown as Window);
    const props = { companion, onClose: vi.fn(), onRefresh: vi.fn().mockResolvedValue(undefined), embedded: true };
    const view = render(<DesktopSheet {...props} />);
    await act(async () => { screen.getByRole("button", { name: "Open desktop" }).click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    view.rerender(<DesktopSheet {...props} active={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(close).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    view.rerender(<DesktopSheet {...props} active />);
    expect(screen.getByRole("button", { name: "Open desktop" })).toBeEnabled();
    expect(screen.getByText("You have control")).toBeInTheDocument();
  });
});
