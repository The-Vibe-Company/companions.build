import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const config = { localAvailable: true, boxAvailable: true, model: "scripted/test" };
const me = { user: { id: "user-1", email: "stan@example.com", name: "Stan" } };
const companion = {
  id: "ada",
  name: "Ada",
  instructions: "Research customer questions.",
  provider: "box" as const,
  status: "preparing" as const,
  error: null,
  createdAt: "2026-09-06T12:00:00.000Z",
  avatar: { shape: 1, color: 2, face: 0 },
};

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

describe("first Companion flow", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("creates a named Box Companion and opens its durable chat", async () => {
    let created = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response(config);
      if (path === "/api/companions" && options?.method === "POST") {
        created = true;
        return response({ companion });
      }
      if (path === "/api/companions") return response({ companions: created ? [companion] : [] });
      if (path === "/api/companions/ada") return response({ companion, messages: [], runs: [], activity: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Create your first Companion" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Mission"), "Research customer questions.");
    await user.click(screen.getByText("Persistent cloud computer"));
    await user.click(screen.getByRole("button", { name: "Create Companion" }));

    expect(await screen.findByRole("heading", { name: "What should Ada work on?" })).toBeInTheDocument();
    expect(screen.getByText(/Messages will wait safely/)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/companions/ada");

    const createCall = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(createCall?.[1]?.body as string)).toEqual({
      name: "Ada",
      instructions: "Research customer questions.",
      provider: "box",
      avatar: { shape: 1, color: 2, face: 0 },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/companions/ada",
      expect.objectContaining({ credentials: "same-origin" }),
    ));
  });

  it("shows a recoverable error when initial configuration fails", async () => {
    let unavailable = true;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/me") return response(me);
      if (path === "/api/config" && unavailable) return Promise.reject(new Error("Service unavailable"));
      if (path === "/api/config") return response(config);
      if (path === "/api/companions") return response({ companions: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Couldn’t load companions.build" })).toBeInTheDocument();
    expect(screen.getByText("Service unavailable")).toBeInTheDocument();

    unavailable = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Create your first Companion" })).toBeInTheDocument();
  });

  it("keeps send available during active work and clears drafts when switching Companions", async () => {
    window.history.replaceState({}, "", "/companions/ada");
    const browserCompanion = {
      ...companion,
      id: "browser",
      name: "Browser",
      provider: "local" as const,
      status: "ready" as const,
    };
    const adaReady = { ...companion, status: "ready" as const };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response(config);
      if (path === "/api/companions") return response({ companions: [adaReady, browserCompanion] });
      if (path === "/api/companions/ada") {
        return response({
          companion: adaReady,
          messages: [],
          runs: [{ id: "run-active", status: "running", error: null, createdAt: companion.createdAt }],
          activity: [],
        });
      }
      if (path === "/api/companions/browser") {
        return response({ companion: browserCompanion, messages: [], runs: [], activity: [] });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    const adaComposer = await screen.findByRole("textbox", { name: "Message Ada" });
    await user.type(adaComposer, "Queue this next");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /Browser Ready/ }));
    const browserComposer = await screen.findByRole("textbox", { name: "Message Browser" });
    expect(browserComposer).toHaveValue("");
  });

  it("requests a Better Auth magic link and offers the local Mailpit inbox", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me") return response({ error: "Authentication required" }, 401);
      if (path === "/api/auth/sign-in/magic-link" && options?.method === "POST") return response({ status: true });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Email"), "alex@example.com");
    await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open local inbox" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-in/magic-link", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ email: "alex@example.com", callbackURL: "/" }),
    }));
  });
});
