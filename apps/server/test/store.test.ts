import { beforeAll, test, expect } from "bun:test";
import { db, migrate, createCompanion, acceptMessage, detail, cancel, Conflict } from "../src/store";
import { acquireExecutor, tick } from "../src/executor";
import { handler } from "../src/api";
import { encrypt } from "../src/config";
import { lifecycleControlHandlers } from "../src/lifecycle";
import { setMagicLinkDeliveryForTests } from "../src/auth";

beforeAll(async () => { await Promise.all([migrate(), migrate()]); });
const owner = "00000000-0000-4000-8000-000000000001";
test("accepted messages survive reconnect and duplicate sends create one request", async () => {
  const companion = await createCompanion(owner, { name: "Ada", instructions: "Be clear", provider: "local" });
  const client = crypto.randomUUID();
  const ids = await Promise.all(Array.from({ length: 20 }, () => acceptMessage(owner, companion.id, client, "Hello Ada")));
  expect(new Set(ids).size).toBe(1);
  const state = await detail(owner, companion.id);
  expect(state?.messages).toHaveLength(1);
  expect(state?.runs).toHaveLength(1);
  await expect(acceptMessage(owner, companion.id, client, "Changed")).rejects.toBeInstanceOf(Conflict);
  await cancel(owner, companion.id);
  expect((await detail(owner, companion.id))?.runs[0].status).toBe("cancelled");
});
async function signIn(email: string) {
  let link = "";
  setMagicLinkDeliveryForTests(message => { link = message.url; });
  const sent = await handler(new Request("http://127.0.0.1:4310/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:4310" },
    body: JSON.stringify({ email, callbackURL: "/" }),
  }));
  expect(sent.status).toBe(200);
  const verified = await handler(new Request(link, { redirect: "manual" }));
  expect(verified.status).toBe(302);
  const cookie = verified.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toContain("better-auth.session_token=");
  return cookie!;
}
test("Better Auth sessions isolate two personal accounts across every Companion operation", async () => {
  const aliceCookie = await signIn("alice@example.com");
  const bobCookie = await signIn("bob@example.com");
  const aliceHeaders = { cookie: aliceCookie, "content-type": "application/json" };
  const bobHeaders = { cookie: bobCookie, "content-type": "application/json" };
  const me = await handler(new Request("http://127.0.0.1:4310/api/me", { headers: aliceHeaders }));
  expect(me.status).toBe(200);
  expect((await me.json() as any).user.email).toBe("alice@example.com");
  const clientCreationId=crypto.randomUUID();
  const create=(name="Grace")=>handler(new Request("http://127.0.0.1:4310/api/companions", {
    method: "POST", headers: aliceHeaders,
    body: JSON.stringify({clientCreationId,name,instructions:"",provider:"local"}),
  }));
  const [created,retried]=await Promise.all([create(),create()]);
  expect(created.status).toBe(201);
  const companion = (await created.json() as any).companion;
  expect((await retried.json() as any).companion.id).toBe(companion.id);
  expect((await create("Changed")).status).toBe(409);
  const url = `http://127.0.0.1:4310/api/companions/${companion.id}/messages`;
  const body = JSON.stringify({ clientMessageId: crypto.randomUUID(), content: "Durable" });
  expect((await handler(new Request(url, { method: "POST", body }))).status).toBe(401);
  expect((await handler(new Request("http://127.0.0.1:4310/api/companions", { headers: { authorization: "Bearer former-operator-token" } }))).status).toBe(401);
  expect((await handler(new Request(url, { method: "POST", body, headers: { ...aliceHeaders, origin: "https://evil.invalid" } }))).status).toBe(403);
  expect((await handler(new Request(url, { method: "POST", body, headers: bobHeaders }))).status).toBe(404);
  expect((await handler(new Request(`http://127.0.0.1:4310/api/companions/${companion.id}`, { headers: bobHeaders }))).status).toBe(404);
  expect((await handler(new Request(`http://127.0.0.1:4310/api/companions/${companion.id}/cancel`, { method: "POST", headers: bobHeaders }))).status).toBe(404);
  expect((await handler(new Request(url, { method: "POST", body, headers: aliceHeaders }))).status).toBe(202);
  const mine = await handler(new Request("http://127.0.0.1:4310/api/companions", { headers: aliceHeaders }));
  const theirs = await handler(new Request("http://127.0.0.1:4310/api/companions", { headers: bobHeaders }));
  expect((await mine.json() as any).companions.some((row: any) => row.id === companion.id)).toBe(true);
  expect((await theirs.json() as any).companions.some((row: any) => row.id === companion.id)).toBe(false);
});
test("Better Auth sign-out invalidates the session cookie that was valid before logout", async () => {
  const cookie = await signIn(`logout-${crypto.randomUUID()}@example.com`);
  const me = () => handler(new Request("http://127.0.0.1:4310/api/me", { headers: { cookie } }));
  expect((await me()).status).toBe(200);

  const signedOut = await handler(new Request("http://127.0.0.1:4310/api/auth/sign-out", {
    method: "POST",
    headers: { cookie, origin: "http://127.0.0.1:4310" },
  }));
  expect(signedOut.status).toBe(200);
  expect((await me()).status).toBe(401);
});
test("one executor owns the database and reconciles a durable final response exactly once", async () => {
  const companion = await createCompanion(owner, { name: "Lin", instructions: "", provider: "local" });
  const runId = await acceptMessage(owner, companion.id, crypto.randomUUID(), "Finish");
  let puts = 0;
  const daemon = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (req.method === "PUT") puts++;
    return Response.json({ id: runId, status: "succeeded", text: "Already completed" });
  } });
  await db`UPDATE companions SET endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${companion.id}`;
  await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${runId}`;
  const leader = await acquireExecutor();
  expect(leader).not.toBeNull();
  expect(await acquireExecutor()).toBeNull();
  try {
    await tick(leader!);
    await tick(leader!);
    const state = await detail(owner, companion.id);
    expect(state?.runs[0].status).toBe("succeeded");
    expect(state?.messages.filter((m: any) => m.role === "assistant")).toHaveLength(1);
    expect(puts).toBe(0);
  } finally { await leader!`SELECT pg_advisory_unlock(721440139)`; leader!.release(); daemon.stop(true); }
});
test("ambiguous dispatch with no remote journal is interrupted, never resent", async () => {
  const companion = await createCompanion(owner, { name: "Alan", instructions: "", provider: "local" });
  const runId = await acceptMessage(owner, companion.id, crypto.randomUUID(), "Side effect");
  const methods: string[] = [];
  const daemon = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { methods.push(req.method); return new Response(null, { status: 404 }); } });
  await db`UPDATE companions SET endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${companion.id}`;
  await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${runId}`;
  const leader = await acquireExecutor();
  try {
    await tick(leader!);
    expect((await detail(owner, companion.id))?.runs[0].status).toBe("interrupted");
    expect(methods).toEqual(["GET"]);
  } finally { await leader!`SELECT pg_advisory_unlock(721440139)`; leader!.release(); daemon.stop(true); }
});
test("a former executor cannot claim work after releasing ownership", async () => {
  const leader = await acquireExecutor();
  expect(leader).not.toBeNull();
  try {
    await leader!`SELECT pg_advisory_unlock(721440139)`;
    await expect(tick(leader!)).rejects.toThrow("Executor ownership lost");
  } finally { leader!.release(); }
});

test("human desktop ownership survives forged agent release and only its owner can release", async () => {
  const cookie = await signIn(`desktop-owner-${crypto.randomUUID()}@example.com`);
  const foreignCookie = await signIn(`desktop-other-${crypto.randomUUID()}@example.com`);
  const headers = { cookie, "content-type": "application/json" };
  const me = await handler(new Request("http://127.0.0.1:4310/api/me", { headers }));
  const ownerId = (await me.json() as any).user.id;
  const companion = await createCompanion(ownerId, { name: "Desktop authority", instructions: "", provider: "local" });
  const url = `http://127.0.0.1:4310/api/companions/${companion.id}`;
  const post = (path: string, requestHeaders = headers, body = {}) => handler(new Request(url + path, {
    method: "POST", headers: requestHeaders, body: JSON.stringify(body),
  }));
  expect((await post("/desktop/takeover")).status).toBe(202);
  const state = async () => (await db`SELECT desktop_taken,desktop_generation FROM companions WHERE id=${companion.id}`)[0];
  const taken = await state();
  expect(taken.desktop_taken).toBe(true);
  expect(Number(taken.desktop_generation)).toBe(1);
  expect((await post("/desktop-takeover")).status).toBe(202);
  expect(Number((await state()).desktop_generation)).toBe(1);
  await expect(lifecycleControlHandlers.desktop_release({ ownerId, companionId: companion.id, runId: crypto.randomUUID(), commandId: crypto.randomUUID() } as any,
    { source: "human", ownerId, taken: false })).rejects.toThrow("HUMAN_DESKTOP_RELEASE_REQUIRED");
  expect((await state()).desktop_taken).toBe(true);
  const foreign = await post("/desktop/release", { ...headers, cookie: foreignCookie });
  expect(foreign.status).toBe(409);
  expect((await state()).desktop_taken).toBe(true);
  expect((await post("/desktop/release", headers, { source: "agent" })).status).toBe(202);
  expect((await state()).desktop_taken).toBe(false);
  expect(Number((await state()).desktop_generation)).toBe(2);
  expect((await post("/desktop-release")).status).toBe(202);
  expect(Number((await state()).desktop_generation)).toBe(2);
});
