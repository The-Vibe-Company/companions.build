import { afterEach, expect, it, vi } from "vitest";
import { discussionApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
it("uploads discussion files with the caller's stable ids and positions", async () => {
  const forms: FormData[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, options?: RequestInit) => { const path = String(input); if (path.endsWith("/messages")) return Promise.resolve(new Response(JSON.stringify({ runId: "run-1", discussionId: "d1", companionId: null }), { headers: { "content-type": "application/json" } })); forms.push(options?.body as FormData); return Promise.resolve(new Response(JSON.stringify({ file: {} }), { headers: { "content-type": "application/json" } })); }));
  await discussionApi.sendMessage("d1", { clientMessageId: "message-1", content: "Read", targetCompanionId: null, files: [{ id: "file-1", file: new File(["a"], "a.txt") }, { id: "file-2", file: new File(["b"], "b.txt") }] });
  expect(forms.map(form => [form.get("clientFileId"), form.get("position")])).toEqual([["file-1", "0"], ["file-2", "1"]]);
});
