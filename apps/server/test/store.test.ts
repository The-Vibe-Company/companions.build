import { beforeAll, test, expect } from "bun:test";
import { db, migrate, createCompanion, acceptMessage, detail, cancel, Conflict } from "../src/store";
import { acquireExecutor, tick } from "../src/executor";
import { handler } from "../src/api";
import { config, encrypt } from "../src/config";

beforeAll(async () => { await Promise.all([migrate(), migrate()]); });
test("accepted messages survive reconnect and duplicate sends create one request", async () => {
  const companion = await createCompanion({ name: "Ada", instructions: "Be clear", provider: "local" });
  const client = crypto.randomUUID();
  const ids = await Promise.all(Array.from({ length: 20 }, () => acceptMessage(companion.id, client, "Hello Ada")));
  expect(new Set(ids).size).toBe(1);
  const state = await detail(companion.id);
  expect(state?.messages).toHaveLength(1);
  expect(state?.runs).toHaveLength(1);
  await expect(acceptMessage(companion.id, client, "Changed")).rejects.toBeInstanceOf(Conflict);
  await cancel(companion.id);
  expect((await detail(companion.id))?.runs[0].status).toBe("cancelled");
});
test("API authorizes before reading or accepting requests and persists before returning 202", async () => {
  const companion = await createCompanion({ name: "Grace", instructions: "", provider: "local" });
  const url = `http://127.0.0.1:4311/api/companions/${companion.id}/messages`;
  const body = JSON.stringify({ clientMessageId: crypto.randomUUID(), content: "Durable" });
  expect((await handler(new Request(url, { method: "POST", body }))).status).toBe(401);
  expect((await detail(companion.id))?.messages).toHaveLength(0);
  const headers = { authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
  expect((await handler(new Request(url, { method: "POST", body, headers: { ...headers, origin: "https://evil.invalid" } }))).status).toBe(403);
  expect((await handler(new Request(url, { method: "POST", body, headers }))).status).toBe(202);
  expect((await detail(companion.id))?.messages[0].content).toBe("Durable");
  await cancel(companion.id);
});
test("one executor owns the database and reconciles a durable final response exactly once", async () => {
  const companion = await createCompanion({ name: "Lin", instructions: "", provider: "local" });
  const runId = await acceptMessage(companion.id, crypto.randomUUID(), "Finish");
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
    const state = await detail(companion.id);
    expect(state?.runs[0].status).toBe("succeeded");
    expect(state?.messages.filter((m: any) => m.role === "assistant")).toHaveLength(1);
    expect(puts).toBe(0);
  } finally { await leader!`SELECT pg_advisory_unlock(721440139)`; leader!.release(); daemon.stop(true); }
});
test("ambiguous dispatch with no remote journal is interrupted, never resent", async () => {
  const companion = await createCompanion({ name: "Alan", instructions: "", provider: "local" });
  const runId = await acceptMessage(companion.id, crypto.randomUUID(), "Side effect");
  const methods: string[] = [];
  const daemon = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { methods.push(req.method); return new Response(null, { status: 404 }); } });
  await db`UPDATE companions SET endpoint_secret=${encrypt(`http://127.0.0.1:${daemon.port}`)} WHERE id=${companion.id}`;
  await db`UPDATE runs SET status='running',dispatched=true,started_at=now() WHERE id=${runId}`;
  const leader = await acquireExecutor();
  try {
    await tick(leader!);
    expect((await detail(companion.id))?.runs[0].status).toBe("interrupted");
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
