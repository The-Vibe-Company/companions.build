import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { config } from "../src/config";
import { acceptMessage, createCompanion, db, migrate } from "../src/store";
import { CompanionEventHub, handleCompanionEvents } from "../src/events";

const owner = "00000000-0000-4000-8000-000000000001";
const hubs: CompanionEventHub[] = [];

async function eventually(assertion: () => void, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch { await Bun.sleep(10); }
  }
  assertion();
}

beforeAll(async () => { await migrate(); });
afterAll(async () => { await Promise.all(hubs.map(hub => hub.close())); });

test("database notifications expose committed cross-process changes and omit rollbacks", async () => {
  const companion = await createCompanion(owner, { name: "Events", instructions: "", provider: "local" });
  const hub = new CompanionEventHub(db as any);
  hubs.push(hub);
  await hub.start();
  const received: string[] = [];
  const unsubscribe = hub.subscribe(companion.id, owner, kind => received.push(kind));

  await db.begin(async tx => {
    await tx`UPDATE companions SET name='First event name' WHERE id=${companion.id}`;
    await tx`UPDATE companions SET name='Committed event name' WHERE id=${companion.id}`;
    await Bun.sleep(40);
    expect(received).toEqual([]);
  });
  await eventually(() => expect(received).toEqual(["invalidate"]));

  await expect(db.begin(async tx => {
    await tx`UPDATE companions SET name='Rolled back name' WHERE id=${companion.id}`;
    throw new Error("rollback fixture");
  })).rejects.toThrow("rollback fixture");
  await Bun.sleep(60);
  expect(received).toEqual(["invalidate"]);

  const executorConnection = new SQL(config.databaseUrl);
  try { await executorConnection`UPDATE companions SET name='Executor event name' WHERE id=${companion.id}`; }
  finally { await executorConnection.close(); }
  await eventually(() => expect(received).toEqual(["invalidate", "invalidate"]));
  unsubscribe();
});

test("delegation creation, target progress and retirement invalidate the parent snapshot", async () => {
  const parent = await createCompanion(owner, { name: "Parent events", instructions: "", provider: "local" });
  const child = await createCompanion(owner, { name: "Researcher", instructions: "", provider: "local" });
  const parentRun = await acceptMessage(owner, parent.id, crypto.randomUUID(), "Delegate this");
  const childRun = await acceptMessage(owner, child.id, crypto.randomUUID(), "Research this");
  // A distinct LISTEN connection excludes fixture notifications still queued on
  // a previous test's already-listening shared connection.
  const listenerDatabase = new SQL(config.databaseUrl);
  const hub = new CompanionEventHub(listenerDatabase as any);
  hubs.push(hub);
  await hub.start();
  const received: string[] = [];
  const unsubscribe = hub.subscribe(parent.id, owner, kind => received.push(kind));

  await db`INSERT INTO delegations(id,parent_id,parent_run_id,target_id,run_id) VALUES(${crypto.randomUUID()},${parent.id},${parentRun},${child.id},${childRun})`;
  await eventually(() => expect(received).toEqual(["invalidate"]));
  received.length = 0;
  await db`UPDATE runs SET status='running' WHERE id=${childRun}`;
  await eventually(() => expect(received).toEqual(["invalidate"]));
  received.length = 0;
  await db`UPDATE companions SET retired_at=now() WHERE id=${child.id}`;
  await eventually(() => expect(received).toEqual(["invalidate"]));
  unsubscribe();
  await hub.close();
  await listenerDatabase.close();
});

test("one listener fans out reconnect resync and rejects malformed notification payloads", async () => {
  let listenCalls = 0;
  let notify: ((payload: string) => void) | undefined;
  let relisten: (() => void) | undefined;
  const fakeDatabase = {
    async listen(_channel: string, onnotify: (payload: string) => void, onlisten?: () => void) {
      listenCalls++;
      notify = onnotify;
      relisten = onlisten;
      onlisten?.();
      return { async unlisten() {} };
    },
  };
  const hub = new CompanionEventHub(fakeDatabase);
  hubs.push(hub);
  await Promise.all([hub.start(), hub.start(), hub.start()]);
  const id = crypto.randomUUID();
  const events: string[] = [];
  hub.subscribe(id, owner, kind => events.push(kind));
  notify?.("not-a-companion-id");
  notify?.(id);
  relisten?.();
  expect(listenCalls).toBe(1);
  expect(events).toEqual(["invalidate", "resync"]);
});

test("event streams enforce ownership, revalidate sessions, and release bounded subscriptions", async () => {
  const companion = await createCompanion(owner, { name: "Private events", instructions: "", provider: "local" });
  const hub = new CompanionEventHub(db as any, { total: 2, perOwner: 1 });
  hubs.push(hub);
  let authenticated: string | null = owner;
  const requestController = new AbortController();
  const request = new Request(`http://127.0.0.1/api/companions/${companion.id}/events`, { signal: requestController.signal });

  const foreign = await handleCompanionEvents(request, crypto.randomUUID(), companion.id, { hub });
  expect(foreign.status).toBe(404);
  expect(hub.activeSubscriptions).toBe(0);

  const response = await handleCompanionEvents(request, owner, companion.id, {
    hub,
    authenticate: async () => authenticated,
    authRecheckMs: 10,
    heartbeatMs: 1_000,
    maxLifetimeMs: 1_000,
    flushDelayMs: 1,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(hub.activeSubscriptions).toBe(1);
  const denied = await handleCompanionEvents(new Request(request.url), owner, companion.id, { hub });
  expect(denied.status).toBe(429);

  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("event: resync");
  authenticated = null;
  let rest = "";
  while (!rest.includes("event: unauthorized")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += new TextDecoder().decode(chunk.value);
  }
  expect(rest).toContain("event: unauthorized");
  await eventually(() => expect(hub.activeSubscriptions).toBe(0));
});
