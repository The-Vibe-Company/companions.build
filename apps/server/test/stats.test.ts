import { afterEach, beforeAll, expect, test } from "bun:test";
import { handler } from "../src/api";
import { db, migrate } from "../src/store";

const original = process.env.STATS_TOKEN;
const token = crypto.randomUUID();
beforeAll(() => migrate());
afterEach(() => { if (original === undefined) delete process.env.STATS_TOKEN; else process.env.STATS_TOKEN = original; });
const get = (path = "/api/stats", authorization?: string) => handler(new Request(`http://localhost${path}`, { headers: authorization ? { Authorization: authorization } : {} }));

test("stats fails closed for absent, incorrect, malformed and unconfigured credentials", async () => {
  process.env.STATS_TOKEN = token;
  for (const header of [undefined, "Bearer wrong", "Basic wrong", `Bearer ${token} extra`]) {
    expect((await get("/api/stats", header)).status).toBe(401);
  }
  delete process.env.STATS_TOKEN;
  expect((await get("/api/stats", `Bearer ${token}`)).status).toBe(401);
  process.env.STATS_TOKEN = "";
  expect((await get("/api/stats", `Bearer ${token}`)).status).toBe(401);
});

test("bearer access is restricted to the exact stats GET route", async () => {
  process.env.STATS_TOKEN = token;
  for (const path of ["/api/me", "/api/companions", "/api/stats/", "/api/stats/other"]) {
    expect((await get(path, `Bearer ${token}`)).status).toBe(401);
  }
  expect((await handler(new Request("http://localhost/api/stats", { method: "POST", headers: { Authorization: `Bearer ${token}` } }))).status).toBe(401);
});

test("stats returns real, deduplicated user and activity counts without a browser session", async () => {
  process.env.STATS_TOKEN = token;
  // This suite owns its database. Replace the seeded development user.
  await db`DELETE FROM "user"`;
  for (const [id, days] of [["today", 0], ["week", 3], ["old-active", 30], ["inactive", 30]] as const) {
    await db`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (${id},${id},${id+'@example.test'},true,now()-${days}*interval '1 day',now())`;
  }
  for (const [id, userId, days] of [["a", "today", 0], ["b", "today", 0], ["c", "week", 3], ["d", "inactive", 10]] as const) {
    await db`INSERT INTO "session" (id,token,"userId","expiresAt","updatedAt") VALUES (${id},${crypto.randomUUID()},${userId},now()+interval '30 days',now()-${days}*interval '1 day')`;
  }
  const discussionId=crypto.randomUUID();
  await db`INSERT INTO discussions (id,owner_id,title,creation_fingerprint) VALUES (${discussionId},'old-active','Activity','test')`;
  await db`INSERT INTO discussion_messages (id,discussion_id,role,content,run_id) VALUES (${crypto.randomUUID()},${discussionId},'user','hello',${crypto.randomUUID()})`;
  const inactiveDiscussion=crypto.randomUUID();
  await db`INSERT INTO discussions (id,owner_id,title,creation_fingerprint) VALUES (${inactiveDiscussion},'inactive','Background','test')`;
  await db`INSERT INTO discussion_messages (id,discussion_id,role,content,run_id) VALUES (${crypto.randomUUID()},${inactiveDiscussion},'assistant','background',${crypto.randomUUID()})`;
  const result=await get("/api/stats", `Bearer ${token}`);
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual({total_users:4,new_users_1d:1,new_users_7d:2,active_users_1d:2,active_users_7d:3});
});
