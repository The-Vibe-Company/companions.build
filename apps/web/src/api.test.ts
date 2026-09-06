import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("Companion API client", () => {
  it("sends the durable client message id required by the API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ runId: "run-1" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.sendMessage("ada", "Investigate the incident")).resolves.toEqual({ runId: "run-1" });

    const [path, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { clientMessageId: string; content: string };
    expect(path).toBe("/api/companions/ada/messages");
    expect(options.method).toBe("POST");
    expect(body.content).toBe("Investigate the incident");
    expect(body.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses the same client message id after a lost response", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network connection lost"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runId: "run-recovered" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.sendMessage("retry-companion", "Keep this id")).rejects.toThrow("network connection lost");
    await expect(api.sendMessage("retry-companion", "Keep this id")).resolves.toEqual({ runId: "run-recovered" });

    const bodies = fetchMock.mock.calls.map(([, options]) =>
      JSON.parse((options as RequestInit).body as string) as { clientMessageId: string },
    );
    expect(bodies[1].clientMessageId).toBe(bodies[0].clientMessageId);
    expect(sessionStorage.getItem("companions.build:pending-message:retry-companion")).toBeNull();
  });

  it("preserves an API error message and status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Desktop is still starting" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await expect(api.openDesktop("ada")).rejects.toEqual(
      expect.objectContaining({ message: "Desktop is still starting", status: 409 }),
    );
  });
});
