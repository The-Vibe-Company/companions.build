import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const config = { localAvailable: true, boxAvailable: true, model: "scripted/test" };
const companion = {
  id: "ada",
  name: "Ada",
  instructions: "Research customer questions.",
  provider: "box" as const,
  status: "preparing" as const,
  error: null,
  createdAt: "2026-09-06T12:00:00.000Z",
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
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/companions/ada",
      expect.objectContaining({ credentials: "same-origin" }),
    ));
  });
});
