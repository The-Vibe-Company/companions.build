import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("Companion API client", () => {
  it("opens the authenticated same-origin event stream for one Companion", () => {
    const opened: string[] = [];
    vi.stubGlobal("EventSource", class { constructor(url: string) { opened.push(url); } });
    api.companionEvents("companion-id");
    expect(opened).toEqual(["/api/companions/companion-id/events"]);
  });

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

  it("declares attachments before uploading each file with a stable client id", async () => {
    const fetchMock = vi.fn((path: RequestInfo | URL, _options?: RequestInit) => {
      if (String(path).endsWith("/messages")) return Promise.resolve(new Response(JSON.stringify({ runId: "run-files" }), { status: 202, headers: { "content-type": "application/json" } }));
      return Promise.resolve(new Response(JSON.stringify({ file: { id: "file-1" } }), { status: 201, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["brief"], "brief.txt", { type: "text/plain" });
    await api.sendMessage("ada-files", "Read this", [file]);

    const admission = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(admission).toMatchObject({ content: "Read this", attachmentCount: 1 });
    const upload = fetchMock.mock.calls[1];
    expect(String(upload[0])).toBe("/api/companions/ada-files/runs/run-files/files");
    const form = (upload[1] as RequestInit).body as FormData;
    expect(form.get("file")).toBe(file);
    expect(form.get("position")).toBe("0");
    expect(form.get("clientFileId")).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("reuses attachment identities only for exactly the same bytes and metadata", async () => {
    const admissions: string[] = [];
    const uploads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL, options: RequestInit) => {
      if (String(path).endsWith("/messages")) {
        admissions.push(JSON.parse(options.body as string).clientMessageId);
        return new Response(JSON.stringify({ runId: "pending-upload" }), { status: 202 });
      }
      uploads.push(String((options.body as FormData).get("clientFileId")));
      throw new TypeError("upload response lost");
    }));
    const file = (bytes: string) => new File([bytes], "same.txt", { type: "text/plain", lastModified: 123 });
    await expect(api.sendMessage("file-retry", "Read", [file("aaa")])).rejects.toThrow("upload response lost");
    await expect(api.sendMessage("file-retry", "Read", [file("aaa")])).rejects.toThrow("upload response lost");
    await expect(api.sendMessage("file-retry", "Read", [file("bbb")])).rejects.toThrow("previous upload is unresolved");
    expect(admissions[1]).toBe(admissions[0]);
    expect(uploads[1]).toBe(uploads[0]);
    expect(admissions).toHaveLength(2);
    expect(uploads).toHaveLength(2);
  });

  it("restores the exact file retry identity after a page reload", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: RequestInfo | URL, options: RequestInit) => {
      bodies.push(JSON.parse(options.body as string).clientMessageId);
      throw new TypeError("response lost");
    }));
    const file = () => new File(["resume"], "note.txt", { type: "text/plain", lastModified: 456 });
    await expect(api.sendMessage("reloaded-upload", "Read", [file()])).rejects.toThrow("response lost");
    vi.resetModules();
    const reloaded = (await import("./api")).api;
    await expect(reloaded.sendMessage("reloaded-upload", "Read", [file()])).rejects.toThrow("response lost");
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("does not replay legacy uploads whose attachment identity was not recorded", async () => {
    sessionStorage.setItem("companions.build:pending-message:legacy-upload", JSON.stringify({
      id: "previous-command", content: "Read", fileIds: ["previous-file"],
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.sendMessage("legacy-upload", "Read", [new File(["old"], "old.txt")]))
      .rejects.toThrow("previous upload is unresolved");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows replacement only after the pending message is explicitly stopped", async () => {
    const admissions: string[] = [];
    let cancelFails = true;
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL, options: RequestInit) => {
      if (String(path).endsWith("/cancel")) {
        if (cancelFails) throw new TypeError("cancel response lost");
        return new Response(JSON.stringify({ ok: true }));
      }
      admissions.push(JSON.parse(options.body as string).clientMessageId);
      throw new TypeError("admission response lost");
    }));
    await expect(api.sendMessage("stop-upload", "Read", [new File(["old"], "old.txt")])).rejects.toThrow("admission response lost");
    await expect(api.cancel("stop-upload")).rejects.toThrow("cancel response lost");
    await expect(api.sendMessage("stop-upload", "Replacement")).rejects.toThrow("previous upload is unresolved");
    expect(admissions).toHaveLength(1);
    cancelFails = false;
    await api.cancel("stop-upload");
    await expect(api.sendMessage("stop-upload", "Replacement")).rejects.toThrow("admission response lost");
    expect(admissions).toHaveLength(2);
    expect(admissions[1]).not.toBe(admissions[0]);
  });

});
