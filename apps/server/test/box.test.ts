import { test, expect } from "bun:test";
import { BoxClient } from "../../../packages/box/client";
import { fetchAgent } from "../../../packages/box/transport";
test("Box creation is isolated, templated and idempotent", async () => {
  let request: RequestInit | undefined;
  const client = new BoxClient("synthetic-secret", (async (_url: any, init: any) => {
    request = init; return Response.json({ ok: true, box: { id: "box-1", state: "provisioning" } }, { status: 202 });
  }) as typeof fetch);
  expect(await client.create("unique-key", "frozen-template")).toEqual({ id: "box-1", state: "provisioning", setupStatus: undefined });
  expect(JSON.parse(request!.body as string)).toMatchObject({ noEnv: true, from: "frozen-template" });
  expect((request!.headers as any)["Idempotency-Key"]).toBe("unique-key");
});
test("provider errors never expose raw credentials or response bodies", async () => {
  const client = new BoxClient("secret", (async () => new Response("provider secret token", { status: 500 })) as any);
  await expect(client.get("box-1")).rejects.toThrow("box_request_failed");
});
test("private preview gate preserves the request through its cookie exchange", async () => {
  const calls: any[] = [];
  const fetcher = (async (url: any, init: any) => {
    calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "/runs/id", "set-cookie": "_port_auth=synthetic; HttpOnly; Path=/" } }) : Response.json({ accepted: true });
  }) as typeof fetch;
  const response = await fetchAgent("https://test.on.ascii.dev?_token=synthetic", "daemon-secret", "/runs/id", "PUT", { content: "Hello" }, 10_000, fetcher);
  expect(response.ok).toBe(true);
  expect(calls[1].method).toBe("PUT");
  expect(calls[1].body).toBe(calls[0].body);
  expect(calls[1].headers.get("cookie")).toBe("_port_auth=synthetic");
  expect(calls[1].headers.get("authorization")).toBe("Bearer daemon-secret");
});
test("private preview redirects cannot forward credentials to another origin", async () => {
  let calls = 0;
  await expect(fetchAgent("https://test.on.ascii.dev?_token=synthetic", "daemon-secret", "/health", "GET", undefined,
    10_000, (async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://other.invalid/" } }); }) as any)).rejects.toThrow("agent_cross_origin_redirect");
  expect(calls).toBe(1);
});
test("private preview cookie exchange merges cookies across redirects", async () => {
  const calls: any[] = [];
  const fetcher = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "/health", "set-cookie": "_port_auth=first; HttpOnly; Path=/" } });
    if (calls.length === 2) return new Response(null, { status: 302, headers: { location: "/health", "set-cookie": "preview_nonce=second; HttpOnly; Path=/" } });
    return Response.json({ ready: true });
  }) as typeof fetch;
  const response = await fetchAgent("https://test.on.ascii.dev?_token=synthetic", "daemon-secret", "/health", "GET", undefined, 10_000, fetcher);
  expect(response.ok).toBe(true);
  expect(calls[2].headers.get("cookie")).toBe("_port_auth=first; preview_nonce=second");
});
test("private preview redirects cannot replay a mutation to another path", async () => {
  let calls = 0;
  await expect(fetchAgent("https://test.on.ascii.dev?_token=synthetic", "daemon-secret", "/runs/id", "PUT", { content: "Hello" },
    10_000, (async () => { calls++; return new Response(null, { status: 302, headers: { location: "/runs/other" } }); }) as any)).rejects.toThrow("agent_cross_path_redirect");
  expect(calls).toBe(1);
});
