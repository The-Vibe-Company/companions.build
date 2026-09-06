import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProduct, DeliverySettings, DesktopSheet } from "./ProductPanels";
import type { Companion } from "@/api";

const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.useRealTimers());

describe("account delivery", () => {
  it("shows real inactive billing and sends the client maintenance choice", async () => {
    let accepted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/billing") return response({ configured: true, mode: "stripe", plan: "inactive", active: false, status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, portalAvailable: false, usage: [] });
      if (path === "/api/deliveries" && !options?.method) return response({ sent: [], received: accepted ? [] : [{ id: "d1", name: "Scout", status: "pending", maintenanceRequested: true, expiresAt: new Date().toISOString(), acceptedAt: null, companionId: null }] });
      if (path === "/api/deliveries/d1/accept") { accepted = true; return response({ companionId: "copy", accepted: true }); }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AccountProduct user={{ id: "u1", name: "Alex", email: "alex@example.com" }} onSignOut={vi.fn()} />);
    expect(await screen.findByText("No subscription")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Allow maintenance" }));
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/deliveries/d1/accept", expect.objectContaining({ body: JSON.stringify({ grantMaintenance: true }) })));
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
        return bodies.length === 1 ? response({ error: "Try again" }, 503) : response({ delivery: {} });
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
    await screen.findByText("Invitation sent.");
    expect(bodies).toHaveLength(2);
    expect(bodies[1].clientDeliveryId).toBe(bodies[0].clientDeliveryId);
  });
});

describe("desktop control", () => {
  it("waits for persisted pause confirmation before claiming control", async () => {
    const fetchMock = vi.fn(() => response({ requested: true }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const companion: Companion = { id: "c1", name: "Luna", instructions: "", provider: "box", status: "ready", error: null, createdAt: new Date().toISOString(), desktopTaken: false, desktopPausedAt: null };
    const refresh = vi.fn().mockResolvedValue(undefined);
    const view = render(<DesktopSheet companion={companion} onClose={vi.fn()} onRefresh={refresh} />);
    await user.click(screen.getByRole("button", { name: "Take control" }));
    expect(screen.getByRole("button", { name: "Pausing…" })).toBeDisabled();
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
