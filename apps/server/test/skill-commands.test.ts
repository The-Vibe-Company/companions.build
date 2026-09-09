import { beforeAll, expect, test } from "bun:test";
import { db, migrate, createCompanion } from "../src/store";
import { handler } from "../src/api";
import { setMagicLinkDeliveryForTests } from "../src/auth";
import { encrypt } from "../src/config";

type Actor = { id: string; cookie: string };
let alice: Actor, bob: Actor;
async function signIn(): Promise<Actor> {
  let link = "";
  setMagicLinkDeliveryForTests(message => { link = message.url; });
  expect((await handler(new Request("http://127.0.0.1:4310/api/auth/sign-in/magic-link", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:4310" },
    body: JSON.stringify({ email: `skills-${crypto.randomUUID()}@example.test`, callbackURL: "/" }),
  }))).status).toBe(200);
  const verified = await handler(new Request(link, { redirect: "manual" }));
  const cookie = verified.headers.get("set-cookie")!.split(";")[0];
  const me = await handler(new Request("http://127.0.0.1:4310/api/me", { headers: { cookie } }));
  return { cookie, id: (await me.json() as any).user.id };
}
beforeAll(async () => { await migrate(); alice = await signIn(); bob = await signIn(); });
const get = (id: string, actor: Actor | null = alice) => handler(new Request(`http://127.0.0.1:4310/api/companions/${id}/skills`, { headers: actor ? { cookie: actor.cookie } : {} }));

test("skill API authenticates ownership and forwards only safe current runtime metadata", async () => {
  const companion = await createCompanion(alice.id, { name: "Skills fixture", provider: "local", prepare: false });
  let calls = 0;
  const daemon = Bun.serve({ port: 0, fetch(request) {
    calls++;
    expect(new URL(request.url).pathname).toBe("/skill-commands");
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
    return Response.json({ enabled: true, private: "private body", skills: [{ name: "native-name", description: "Pi description", source: "user · top-level", filePath: "/private/SKILL.md", content: "private body" }] });
  } });
  try {
    await db`UPDATE companions SET status='ready',endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)},agent_secret=${encrypt("fixture-token")} WHERE id=${companion.id}`;
    expect((await get(companion.id, null)).status).toBe(401);
    expect((await get(companion.id, bob)).status).toBe(404);
    expect((await get(crypto.randomUUID())).status).toBe(404);
    expect(calls).toBe(0);
    const response = await get(companion.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ enabled: true, skills: [{ name: "native-name", description: "Pi description", source: "user · top-level" }] });
    expect(calls).toBe(1);
    await db`UPDATE companions SET retired_at=now() WHERE id=${companion.id}`;
    expect((await get(companion.id)).status).toBe(404);
    expect(calls).toBe(1);
  } finally { daemon.stop(true); }
});

test("empty, disabled, old or unavailable runtimes never block unchanged slash message admission", async () => {
  const companion = await createCompanion(alice.id, { name: "Unavailable skills fixture", provider: "local", prepare: false });
  expect((await get(companion.id)).status).toBe(503);
  const [before] = await db`SELECT status,prepare_requested,create_started_at FROM companions WHERE id=${companion.id}`;
  expect(before).toMatchObject({ status: "new", prepare_requested: false, create_started_at: null });
  let reply = () => Response.json({ enabled: true, skills: [] });
  const daemon = Bun.serve({ port: 0, fetch: () => reply() });
  try {
    await db`UPDATE companions SET status='ready',endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${companion.id}`;
    expect(await (await get(companion.id)).json()).toEqual({ enabled: true, skills: [] });
    reply = () => Response.json({ enabled: false, skills: [{ name: "hidden", description: "hidden" }] });
    expect(await (await get(companion.id)).json()).toEqual({ enabled: false, skills: [] });
    for (const status of [404, 401, 500]) {
      reply = () => new Response("private provider error", { status });
      const result = await get(companion.id);
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ error: "Skills are temporarily unavailable." });
    }
    for (const content of ["/skill:native-name arguments", "Prose /skill:native-name arguments", "/unknown arguments"]) {
      const response = await handler(new Request(`http://127.0.0.1:4310/api/companions/${companion.id}/messages`, {
        method: "POST", headers: { cookie: alice.cookie, "content-type": "application/json" },
        body: JSON.stringify({ clientMessageId: crypto.randomUUID(), content }),
      }));
      expect(response.status).toBe(202);
      const { runId } = await response.json() as any;
      const [run] = await db`SELECT content FROM runs WHERE id=${runId}`;
      expect(run.content).toBe(content);
    }
  } finally { daemon.stop(true); }
});
