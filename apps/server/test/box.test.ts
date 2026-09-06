import { test, expect } from "bun:test";
import { BoxClient } from "../../../packages/box/client";
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
