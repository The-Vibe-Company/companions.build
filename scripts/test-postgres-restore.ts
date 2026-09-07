import { chmod, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

process.env.NODE_ENV = "test";
const { handler } = await import("../apps/server/src/api");
const { setMagicLinkDeliveryForTests } = await import("../apps/server/src/auth");
const { assertMigrated, db, migrate } = await import("../apps/server/src/store");

const stateSchema = z.object({ email: z.string().email(), cookie: z.string().min(1), companionId: z.string().uuid(),
  clientCreationId: z.string().uuid(), clientMessageId: z.string().uuid(), runId: z.string().uuid() }).strict();
const [operation, statePath] = process.argv.slice(2);
if (!["seed", "verify"].includes(operation ?? "") || !statePath || process.argv.length !== 4) throw new Error("Usage: test-postgres-restore.ts seed|verify <private-state-path>");

const request = (path: string, init: RequestInit = {}) => handler(new Request(`http://127.0.0.1:4310${path}`, init));

async function signIn(email: string) {
  let link = "";
  setMagicLinkDeliveryForTests(message => { link = message.url; });
  const sent = await request("/api/auth/sign-in/magic-link", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:4310" },
    body: JSON.stringify({ email, callbackURL: "/" }) });
  if (sent.status !== 200 || !link) throw new Error("postgres_restore_auth_seed_failed");
  const verified = await handler(new Request(link, { redirect: "manual" }));
  const cookie = verified.headers.get("set-cookie")?.split(";")[0];
  if (verified.status !== 302 || !cookie?.startsWith("better-auth.session_token=")) throw new Error("postgres_restore_auth_seed_failed");
  return cookie;
}

if (operation === "seed") {
  await migrate();
  const email = `restore-${crypto.randomUUID()}@example.com`, cookie = await signIn(email);
  const headers = { cookie, "content-type": "application/json" }, clientCreationId = crypto.randomUUID();
  const created = await request("/api/companions", { method: "POST", headers,
    body: JSON.stringify({ clientCreationId, name: "Restore proof", instructions: "Keep this durable.", provider: "local" }) });
  if (created.status !== 201) throw new Error("postgres_restore_companion_seed_failed");
  const companionId = (await created.json() as any).companion?.id;
  const clientMessageId = crypto.randomUUID();
  const accepted = await request(`/api/companions/${companionId}/messages`, { method: "POST", headers,
    body: JSON.stringify({ clientMessageId, content: "Survive the database recovery." }) });
  if (accepted.status !== 202) throw new Error("postgres_restore_turn_seed_failed");
  const runId = (await accepted.json() as any).runId;
  const state = stateSchema.parse({ email, cookie, companionId, clientCreationId, clientMessageId, runId });
  await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(statePath, 0o600);
} else {
  await assertMigrated();
  const state = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
  const headers = { cookie: state.cookie, "content-type": "application/json" };
  const me = await request("/api/me", { headers });
  if (me.status !== 200 || (await me.json() as any).user?.email !== state.email) throw new Error("postgres_restore_session_missing");
  if ((await request("/api/me")).status !== 401) throw new Error("postgres_restore_auth_boundary_failed");
  const retriedCreation = await request("/api/companions", { method: "POST", headers,
    body: JSON.stringify({ clientCreationId: state.clientCreationId, name: "Restore proof", instructions: "Keep this durable.", provider: "local" }) });
  if (retriedCreation.status !== 201 || (await retriedCreation.json() as any).companion?.id !== state.companionId) {
    throw new Error("postgres_restore_companion_idempotency_missing");
  }
  const detail = await request(`/api/companions/${state.companionId}`, { headers });
  if (detail.status !== 200) throw new Error("postgres_restore_companion_missing");
  const body = await detail.json() as any;
  const run = body.runs?.find((value: any) => value.id === state.runId);
  if (run?.status !== "queued" || !body.messages?.some((value: any) => value.runId === state.runId && value.content === "Survive the database recovery.")) {
    throw new Error("postgres_restore_durable_turn_missing");
  }
  const retried = await request(`/api/companions/${state.companionId}/messages`, { method: "POST", headers,
    body: JSON.stringify({ clientMessageId: state.clientMessageId, content: "Survive the database recovery." }) });
  if (retried.status !== 202 || (await retried.json() as any).runId !== state.runId) throw new Error("postgres_restore_idempotency_missing");
  const [counts] = await db`SELECT
    (SELECT count(*)::int FROM companions WHERE id=${state.companionId} AND client_creation_id=${state.clientCreationId}) AS companions,
    (SELECT count(*)::int FROM runs WHERE id=${state.runId} AND companion_id=${state.companionId} AND client_message_id=${state.clientMessageId}) AS runs,
    (SELECT count(*)::int FROM messages WHERE companion_id=${state.companionId} AND run_id=${state.runId}
      AND role='user' AND content='Survive the database recovery.') AS messages`;
  if (counts.companions !== 1 || counts.runs !== 1 || counts.messages !== 1) throw new Error("postgres_restore_duplicate_rows");
}

// Better Auth's PostgreSQL pool has an idle lifetime; the acceptance has awaited every write/read.
process.exit(0);
