import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SQL, ReservedSQL } from "bun";
import { runFilter } from "../../../packages/filters";
import { decrypt, encrypt } from "./config";
import { db } from "./store";

type Database = SQL | ReservedSQL;
const uuid = z.string().uuid();
const slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const repo = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/).max(200);
const targetSchema = z.object({
  repo: repo.optional(), organization: slug.optional(), project: slug.optional(),
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/).optional(),
  events: z.array(z.string().regex(/^[A-Za-z0-9.*_-]{1,64}$/)).min(1).max(30).optional(),
}).strict();
const requestSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
  provider: z.enum(["github", "sentry"]), connectionId: uuid.optional(),
  path: z.string().min(1).max(500),
}).strict();
export const triggerInputSchema = z.object({
  name: z.string().trim().min(1).max(100), prompt: z.string().trim().min(1).max(50_000),
  source: z.enum(["generic", "github", "sentry"]), mode: z.enum(["direct", "filter"]),
  filterCode: z.string().trim().min(1).max(20_000).optional(), filter: z.string().trim().min(1).max(20_000).optional(),
  filterRequests: z.array(requestSchema).max(5).default([]),
  problemPath: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,7}$/).optional(),
  providerAccountId: uuid.optional(), target: targetSchema.optional(), enabled: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  if (value.mode === "filter" && !(value.filterCode ?? value.filter)) context.addIssue({ code: "custom", message: "Filter code is required." });
  if (value.mode === "direct" && value.filterRequests.length) context.addIssue({ code: "custom", message: "API requests require a code filter." });
  if (value.source === "github" && !value.target?.repo) context.addIssue({ code: "custom", message: "A GitHub repository is required." });
  if (value.source === "sentry" && (!value.target?.organization || !value.target.project)) context.addIssue({ code: "custom", message: "A Sentry project is required." });
  if (value.source === "github" && value.target?.events?.some(event => event !== "workflow_run")) context.addIssue({ code: "custom", message: "GitHub failed-CI triggers use workflow_run events." });
  if (value.source === "sentry" && value.target?.events?.some(event => event !== "event.created")) context.addIssue({ code: "custom", message: "Sentry issue triggers use event.created events." });
});
export type TriggerInput = z.infer<typeof triggerInputSchema>;
const triggerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(), prompt: z.string().trim().min(1).max(50_000).optional(),
  mode: z.enum(["direct", "filter"]).optional(), filterCode: z.string().trim().min(1).max(20_000).optional(),
  filter: z.string().trim().min(1).max(20_000).optional(), filterRequests: z.array(requestSchema).max(5).optional(),
  problemPath: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,7}$/).optional(), enabled: z.boolean().optional(),
}).strict();

interface TriggerRow {
  id: string; ownerId: string; companionId: string; name: string; prompt: string;
  source: "generic" | "github" | "sentry"; mode: "direct" | "filter"; filterCode: string | null;
  filterRequests: FilterRequest[]; problemPath: string | null; providerAccountId: string | null;
  target: z.infer<typeof targetSchema> | null; enabled: boolean; secretCiphertext: string;
  registrationStatus: "manual" | "registered" | "needs_connection" | "error";
  registrationError: string | null; remoteHookId: string | null; lastDeliveryAt: string | null;
  createdAt: string; updatedAt: string;
}
type FilterRequest = z.infer<typeof requestSchema>;
const triggerColumns = `t.id,t.owner_id AS "ownerId",t.companion_id AS "companionId",t.name,t.prompt,t.source,t.mode,
 t.filter_code AS "filterCode",t.filter_requests AS "filterRequests",t.problem_path AS "problemPath",
 t.provider_account_id AS "providerAccountId",t.target,t.enabled,t.secret_ciphertext AS "secretCiphertext",
 t.registration_status AS "registrationStatus",t.registration_error AS "registrationError",t.remote_hook_id AS "remoteHookId",
 t.last_delivery_at AS "lastDeliveryAt",t.created_at AS "createdAt",t.updated_at AS "updatedAt"`;

function jsonColumn<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function normalizeTrigger(row: TriggerRow): TriggerRow {
  return { ...row, filterRequests: jsonColumn(row.filterRequests), target: row.target ? jsonColumn(row.target) : null };
}

export class TriggerError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid_trigger") { super(message); }
}

export async function migrateTriggers(database: Database = db) {
  const migration = await Bun.file(new URL("./triggers.sql", import.meta.url)).text();
  await database.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(721440140)`;
    await tx.unsafe(migration);
  });
}

function publicTrigger(row: TriggerRow) {
  const { ownerId: _, secretCiphertext: __, filterCode, ...value } = row;
  return { ...value, filter: filterCode, url: new URL(`/api/webhooks/${row.id}`, process.env.APP_URL ?? "http://127.0.0.1:4310").href };
}

async function ownedTrigger(database: Database, ownerId: string, companionId: string, triggerId: string) {
  const rows = await database.unsafe(`SELECT ${triggerColumns} FROM triggers t JOIN companions c ON c.id=t.companion_id
    WHERE t.id=$1 AND t.companion_id=$2 AND t.owner_id=$3 AND c.owner_id=$3`, [triggerId, companionId, ownerId]) as TriggerRow[];
  return rows[0] ? normalizeTrigger(rows[0]) : null;
}

interface ProviderCredential { token: string; accountId: string }
async function providerCredential(database: Database, ownerId: string, provider: "github" | "sentry", accountId?: string | null): Promise<ProviderCredential> {
  const rows = await database.unsafe(`SELECT id,credential_secret AS "credentialSecret" FROM plugin_accounts
    WHERE owner_id=$1 AND provider=$2 AND ($3::uuid IS NULL OR id=$3::uuid) ORDER BY created_at DESC LIMIT 2`,
    [ownerId, provider, accountId ?? null]) as { id: string; credentialSecret: string }[];
  if (rows.length !== 1) throw new TriggerError(`Connect ${provider === "github" ? "GitHub" : "Sentry"} to register this trigger.`, 409, "needs_connection");
  let credential: unknown;
  try { credential = JSON.parse(decrypt(rows[0].credentialSecret)); } catch { throw new TriggerError("Reconnect this provider before registering the trigger.", 409, "needs_connection"); }
  const parsed = z.object({ kind: z.literal("oauth"), accessToken: z.string().min(1), accessExpiresAt: z.string().nullable().optional() }).passthrough().safeParse(credential);
  if (!parsed.success || (parsed.data.accessExpiresAt && Date.parse(parsed.data.accessExpiresAt) <= Date.now())) {
    throw new TriggerError("Reconnect this provider before registering the trigger.", 409, "needs_connection");
  }
  return { token: parsed.data.accessToken, accountId: rows[0].id };
}

async function providerJson(url: string, token: string, init: RequestInit, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000), headers: {
    Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers,
  } });
  if (!response.ok) throw new TriggerError("The provider could not register this webhook.", 502, "provider_rejected");
  const text = await response.text();
  if (text.length > 256_000) throw new TriggerError("The provider returned an invalid webhook response.", 502, "provider_rejected");
  try { return text ? JSON.parse(text) : null; } catch { throw new TriggerError("The provider returned an invalid webhook response.", 502, "provider_rejected"); }
}

interface ProviderRegistrationResult { remoteHookId: string; secret: string }
interface TriggerProviderAdapter {
  register(input: { target: z.infer<typeof targetSchema>; webhookUrl: string; secret: string; token: string; fetchImpl: typeof fetch }): Promise<ProviderRegistrationResult>;
  deleteUrl(target: z.infer<typeof targetSchema>, remoteHookId: string): string;
}

export const triggerProviderAdapters: Record<"github" | "sentry", TriggerProviderAdapter> = {
  github: {
    async register({ target, webhookUrl, secret, token, fetchImpl }) {
    const [owner, repository] = target.repo!.split("/");
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/hooks`;
    const listed = z.array(z.object({ id: z.union([z.string(), z.number()]), config: z.object({ url: z.string().optional() }).passthrough() }).passthrough())
        .parse(await providerJson(endpoint, token, { method: "GET" }, fetchImpl));
    const found = listed.find(hook => hook.config.url === webhookUrl);
      let remoteHookId: string;
    if (found) {
      remoteHookId = String(found.id);
        await providerJson(`${endpoint}/${encodeURIComponent(remoteHookId)}`, token, {
        method: "PATCH", body: JSON.stringify({ active: true, events: target.events ?? ["workflow_run"],
          config: { url: webhookUrl, content_type: "json", insecure_ssl: "0", secret } }),
      }, fetchImpl);
    } else {
        const created = z.object({ id: z.union([z.string(), z.number()]) }).passthrough().parse(await providerJson(endpoint, token, {
        method: "POST", body: JSON.stringify({ name: "web", active: true, events: target.events ?? ["workflow_run"],
          config: { url: webhookUrl, content_type: "json", insecure_ssl: "0", secret } }),
      }, fetchImpl));
      remoteHookId = String(created.id);
    }
      return { remoteHookId, secret };
    },
    deleteUrl(target, remoteHookId) {
      return `https://api.github.com/repos/${target.repo!.split("/").map(encodeURIComponent).join("/")}/hooks/${encodeURIComponent(remoteHookId)}`;
    },
  },
  sentry: {
    async register({ target, webhookUrl, token, fetchImpl }) {
    const endpoint = `https://sentry.io/api/0/projects/${encodeURIComponent(target.organization!)}/${encodeURIComponent(target.project!)}/hooks/`;
    const hookSchema = z.object({ id: z.string().min(1), url: z.string(), secret: z.string().min(16) }).passthrough();
      const listed = z.array(hookSchema).parse(await providerJson(endpoint, token, { method: "GET" }, fetchImpl));
    let hook = listed.find(candidate => candidate.url === webhookUrl);
      if (!hook) hook = hookSchema.parse(await providerJson(endpoint, token, {
      method: "POST", body: JSON.stringify({ url: webhookUrl, events: target.events ?? ["event.created"] }),
    }, fetchImpl));
      return { remoteHookId: hook.id, secret: hook.secret };
    },
    deleteUrl(target, remoteHookId) {
      return `https://sentry.io/api/0/projects/${encodeURIComponent(target.organization!)}/${encodeURIComponent(target.project!)}/hooks/${encodeURIComponent(remoteHookId)}/`;
    },
  },
};

async function registerProvider(row: TriggerRow, secret: string, database: Database, fetchImpl: typeof fetch) {
  if (row.source === "generic") return;
  const credential = await providerCredential(database, row.ownerId, row.source, row.providerAccountId);
  const webhookUrl = new URL(`/api/webhooks/${row.id}`, process.env.APP_URL ?? "http://127.0.0.1:4310").href;
  const result = await triggerProviderAdapters[row.source].register({ target: targetSchema.parse(row.target), webhookUrl, secret,
    token: credential.token, fetchImpl });
  await database.unsafe(`UPDATE triggers SET provider_account_id=$2,remote_hook_id=$3,secret_ciphertext=$4,
    registration_status='registered',registration_error=NULL,updated_at=now() WHERE id=$1`,
    [row.id, credential.accountId, result.remoteHookId, encrypt(result.secret)]);
}

export async function reconcileTriggerRegistration(ownerId: string, companionId: string, triggerId: string,
  dependencies: { database?: Database; fetchImpl?: typeof fetch } = {}) {
  const database = dependencies.database ?? db;
  const row = await ownedTrigger(database, ownerId, uuid.parse(companionId), uuid.parse(triggerId));
  if (!row) throw new TriggerError("Trigger not found.", 404);
  if (row.source === "generic") return publicTrigger(row);
  try {
    await registerProvider(row, decrypt(row.secretCiphertext), database, dependencies.fetchImpl ?? fetch);
  } catch (error) {
    const triggerError = error instanceof TriggerError ? error : new TriggerError("The provider could not register this webhook.", 502, "provider_rejected");
    const status = triggerError.code === "needs_connection" ? "needs_connection" : "error";
    await database.unsafe(`UPDATE triggers SET registration_status=$2,registration_error=$3,updated_at=now() WHERE id=$1`,
      [row.id, status, triggerError.message.slice(0, 500)]);
    throw triggerError;
  }
  return publicTrigger((await ownedTrigger(database, ownerId, companionId, triggerId))!);
}

async function unregisterProvider(row: TriggerRow, database: Database, fetchImpl: typeof fetch) {
  if (row.source === "generic" || !row.remoteHookId) return;
  const credential = await providerCredential(database, row.ownerId, row.source, row.providerAccountId);
  const target = targetSchema.parse(row.target);
  const endpoint = triggerProviderAdapters[row.source].deleteUrl(target, row.remoteHookId);
  let response: Response;
  try { response = await fetchImpl(endpoint, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/json", Authorization: `Bearer ${credential.token}` } }); }
  catch { throw new TriggerError("The provider webhook could not be removed. Try again.", 502, "provider_cleanup_failed"); }
  if (response.status !== 204 && response.status !== 404) throw new TriggerError("The provider webhook could not be removed. Try again.", 502, "provider_cleanup_failed");
}

async function createTrigger(database: Database, ownerId: string, companionId: string, raw: unknown, fetchImpl: typeof fetch) {
  const value = triggerInputSchema.parse(raw);
  const secret = randomBytes(32).toString("hex");
  const id = crypto.randomUUID();
  const rows = await database.unsafe(`INSERT INTO triggers(id,owner_id,companion_id,name,prompt,source,mode,filter_code,
    filter_requests,problem_path,provider_account_id,target,enabled,secret_ciphertext,registration_status)
    SELECT $1,$2,c.id,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15 FROM companions c
    WHERE c.id=$3 AND c.owner_id=$2 RETURNING *`, [id, ownerId, companionId, value.name, value.prompt, value.source,
    value.mode, value.mode === "filter" ? value.filterCode ?? value.filter : null, JSON.stringify(value.filterRequests),
    value.problemPath ?? null, value.providerAccountId ?? null, JSON.stringify(value.target ?? null), value.enabled,
    encrypt(secret), value.source === "generic" ? "manual" : "needs_connection"]);
  if (!rows[0]) throw new TriggerError("Companion not found.", 404);
  let row = await ownedTrigger(database, ownerId, companionId, id) as TriggerRow;
  if (value.source !== "generic") {
    try { await registerProvider(row, secret, database, fetchImpl); }
    catch (error) {
      const triggerError = error instanceof TriggerError ? error : new TriggerError("The provider could not register this webhook.", 502, "provider_rejected");
      const status = triggerError.code === "needs_connection" ? "needs_connection" : "error";
      await database.unsafe(`UPDATE triggers SET registration_status=$2,registration_error=$3,updated_at=now() WHERE id=$1`, [id, status, triggerError.message.slice(0, 500)]);
    }
    row = await ownedTrigger(database, ownerId, companionId, id) as TriggerRow;
  }
  return { trigger: publicTrigger(row), ...(value.source === "generic" ? { secret } : {}) };
}

function safeEqual(actual: string, expected: string) {
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request: Request, max = 1024 * 1024) {
  if (!request.body) throw new TriggerError("A webhook body is required.", 400);
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new TriggerError("Webhook body is too large.", 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function valueAt(payload: unknown, path: string | null) {
  if (!path) return undefined;
  let value: unknown = payload;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return ["string", "number"].includes(typeof value) ? String(value) : undefined;
}

function problemKey(row: TriggerRow, payload: unknown) {
  const fallbackPath = row.source === "sentry" ? "data.issue.id" : row.source === "github" ? "workflow_run.id" : null;
  const identity = valueAt(payload, row.problemPath ?? fallbackPath) ?? createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return createHash("sha256").update(`${row.source}:${identity}`).digest("hex");
}

export async function handleWebhook(request: Request, dependencies: { database?: Database } = {}): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(/^\/api\/webhooks\/([a-f0-9-]+)$/i);
  if (!match) return null;
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  const database = dependencies.database ?? db;
  try {
    const rows = await database.unsafe(`SELECT ${triggerColumns} FROM triggers t WHERE t.id=$1 AND t.enabled`, [uuid.parse(match[1])]) as TriggerRow[];
    const trigger = rows[0] ? normalizeTrigger(rows[0]) : null;
    if (!trigger) throw new TriggerError("Webhook not found.", 404);
    const body = await readBody(request);
    const secret = decrypt(trigger.secretCiphertext);
    const digest = createHmac("sha256", secret).update(body).digest("hex");
    const supplied = trigger.source === "github" ? request.headers.get("x-hub-signature-256")?.replace(/^sha256=/, "")
      : trigger.source === "sentry" ? request.headers.get("sentry-hook-signature")?.replace(/^sha256=/, "")
      : request.headers.get("x-companions-signature")?.replace(/^sha256=/, "");
    const bearer = trigger.source === "generic" ? request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] : null;
    if (!(supplied && safeEqual(supplied, digest)) && !(bearer && safeEqual(bearer, secret))) throw new TriggerError("Invalid webhook signature.", 401);
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { throw new TriggerError("Webhook payload must be JSON.", 400); }
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const providerDelivery = trigger.source === "github" ? request.headers.get("x-github-delivery") : request.headers.get("x-webhook-id");
    const deliveryKey = createHash("sha256").update(`${trigger.source}:${providerDelivery ?? payloadHash}`).digest("hex");
    const id = crypto.randomUUID();
    const inserted = await database.unsafe(`INSERT INTO trigger_deliveries(id,trigger_id,delivery_key,payload_hash,problem_key,event_name,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(trigger_id,delivery_key) DO NOTHING RETURNING id`,
      [id, trigger.id, deliveryKey, payloadHash, problemKey(trigger, payload), request.headers.get("x-github-event") ?? request.headers.get("sentry-hook-resource"), JSON.stringify(payload)]);
    if (!inserted[0]) {
      const existing = await database.unsafe(`SELECT payload_hash AS "payloadHash" FROM trigger_deliveries WHERE trigger_id=$1 AND delivery_key=$2`, [trigger.id, deliveryKey]) as { payloadHash: string }[];
      if (existing[0]?.payloadHash !== payloadHash) throw new TriggerError("Delivery identifier was reused with different content.", 409);
    } else await database.unsafe(`UPDATE triggers SET last_delivery_at=now() WHERE id=$1`, [trigger.id]);
    return Response.json({ ok: true, duplicate: !inserted[0] }, { status: 202 });
  } catch (error) {
    if (error instanceof TriggerError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Webhook could not be accepted." }, { status: 500 });
  }
}

function allowedProviderUrl(request: FilterRequest) {
  if (request.path.includes("\\") || request.path.includes("..") || !request.path.startsWith("/")) throw new TriggerError("A filter API request is invalid.");
  const base = request.provider === "github" ? "https://api.github.com" : "https://sentry.io";
  const url = new URL(request.path, base);
  if (url.origin !== base || (request.provider === "github" ? !url.pathname.startsWith("/repos/") : !url.pathname.startsWith("/api/0/"))) {
    throw new TriggerError("A filter API request is invalid.");
  }
  return url.href;
}

export async function resolveFilterRequests(row: Pick<TriggerRow, "ownerId" | "filterRequests">, database: Database = db, fetchImpl: typeof fetch = fetch) {
  const result: Record<string, unknown> = {};
  for (const request of z.array(requestSchema).max(5).parse(row.filterRequests)) {
    const credential = await providerCredential(database, row.ownerId, request.provider, request.connectionId);
    const response = await fetchImpl(allowedProviderUrl(request), { method: "GET", redirect: "error", signal: AbortSignal.timeout(5_000),
      headers: { Accept: "application/json", Authorization: `Bearer ${credential.token}` } });
    if (!response.ok) throw new TriggerError("A filter API request failed.", 502, "filter_api_failed");
    const text = await response.text();
    if (text.length > 64_000) throw new TriggerError("A filter API response was too large.", 502, "filter_api_failed");
    try { result[request.key] = JSON.parse(text); } catch { throw new TriggerError("A filter API response was invalid.", 502, "filter_api_failed"); }
  }
  return result;
}

export interface EnqueueBackground { (input: { companionId: string; clientMessageId: string; content: string; source: "trigger" }): Promise<string | null> }

function sourceMatches(trigger: TriggerRow, payload: unknown, eventName: string | null) {
  if (trigger.source !== "github") return true;
  if (eventName !== "workflow_run" || !payload || typeof payload !== "object") return false;
  const value = payload as Record<string, any>;
  return value.action === "completed" && value.workflow_run?.conclusion === "failure"
    && value.workflow_run?.head_branch === (trigger.target?.branch ?? "main");
}

async function flushPendingBatch(database: Database, enqueueBackground: EnqueueBackground) {
  const batches = await database.unsafe(`UPDATE trigger_batches b SET enqueue_attempts=b.enqueue_attempts+1,
    next_enqueue_at=now()+interval '2 minutes',updated_at=now() WHERE b.id=(SELECT id FROM trigger_batches
      WHERE enqueue_status IN ('pending','error') AND enqueue_attempts<5 AND next_enqueue_at<=now()
      ORDER BY next_enqueue_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING b.id,b.companion_id AS "companionId",(SELECT prompt FROM triggers WHERE id=b.trigger_id) AS prompt,
      (SELECT name FROM triggers WHERE id=b.trigger_id) AS name`) as { id: string; companionId: string; prompt: string; name: string }[];
  const batch = batches[0]; if (!batch) return false;
  try {
    const runId = await enqueueBackground({ companionId: batch.companionId, clientMessageId: batch.id,
      content: `${batch.prompt}\n\nTriggered by ${batch.name}. Load persisted trigger batch ${batch.id} before acting.`, source: "trigger" });
    if (!runId) throw new Error("companion missing");
    await database.unsafe(`UPDATE trigger_batches SET enqueue_status='sent',run_id=$2,updated_at=now() WHERE id=$1`, [batch.id, runId]);
  } catch {
    await database.unsafe(`UPDATE trigger_batches SET enqueue_status='error',status=CASE WHEN enqueue_attempts>=5 THEN 'finished' ELSE status END,
      next_enqueue_at=now()+interval '5 seconds',updated_at=now() WHERE id=$1`, [batch.id]);
  }
  return true;
}

export async function processTriggerInbox(dependencies: { database?: Database; enqueueBackground: EnqueueBackground; fetchImpl?: typeof fetch; runFilterImpl?: typeof runFilter }) {
  const database = dependencies.database ?? db;
  await syncTriggerBatches(database);
  await database.unsafe(`UPDATE trigger_deliveries SET status='error',decision='error',error_code='evaluation_abandoned',decided_at=now()
    WHERE status='evaluating' AND attempts>=5 AND claimed_at<now()-interval '5 minutes'`);
  if (await flushPendingBatch(database, dependencies.enqueueBackground)) return 1;
  const delivery = await database.begin(async tx => {
    const rows = await tx.unsafe(`UPDATE trigger_deliveries SET status='evaluating',attempts=attempts+1,claimed_at=now()
      WHERE id=(SELECT id FROM trigger_deliveries WHERE (status='received' OR (status='evaluating' AND claimed_at<now()-interval '5 minutes'))
        AND attempts<5 ORDER BY received_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id,trigger_id AS "triggerId",payload,problem_key AS "problemKey",event_name AS "eventName"`) as { id: string; triggerId: string; payload: unknown; problemKey: string; eventName: string | null }[];
    return rows[0] ?? null;
  });
  if (!delivery) return 0;
  const triggers = await database.unsafe(`SELECT ${triggerColumns} FROM triggers t WHERE t.id=$1`, [delivery.triggerId]) as TriggerRow[];
  const trigger = triggers[0] ? normalizeTrigger(triggers[0]) : null;
  delivery.payload = jsonColumn(delivery.payload);
  if (!trigger?.enabled) {
    await database.unsafe(`UPDATE trigger_deliveries SET status='ignored',decision='ignored',decided_at=now() WHERE id=$1`, [delivery.id]);
    return 1;
  }
  try {
    const matches = sourceMatches(trigger, delivery.payload, delivery.eventName);
    const responses = matches && trigger.mode === "filter"
      ? await resolveFilterRequests(trigger, database, dependencies.fetchImpl ?? fetch) : {};
    const accepted = matches && (trigger.mode === "direct"
      || await (dependencies.runFilterImpl ?? runFilter)({ code: trigger.filterCode!, payload: delivery.payload, responses }));
    if (!accepted) {
      await database.unsafe(`UPDATE trigger_deliveries SET status='ignored',decision='ignored',decided_at=now() WHERE id=$1`, [delivery.id]);
      return 1;
    }
    const batchId = await database.begin(async tx => {
      await tx.unsafe(`SELECT id FROM triggers WHERE id=$1 FOR UPDATE`, [trigger.id]);
      const existing = await tx.unsafe(`SELECT id FROM trigger_batches WHERE trigger_id=$1 AND problem_key=$2 AND status='queued' LIMIT 1`, [trigger.id, delivery.problemKey]) as { id: string }[];
      const id = existing[0]?.id ?? crypto.randomUUID();
      if (!existing[0]) await tx.unsafe(`INSERT INTO trigger_batches(id,trigger_id,companion_id,problem_key) VALUES($1,$2,$3,$4)`, [id, trigger.id, trigger.companionId, delivery.problemKey]);
      await tx.unsafe(`UPDATE trigger_deliveries SET status='enqueued',decision='accepted',batch_id=$2,decided_at=now() WHERE id=$1`, [delivery.id, id]);
      return id;
    });
    await flushPendingBatch(database, dependencies.enqueueBackground);
    return batchId ? 1 : 0;
  } catch (error) {
    const code = error instanceof TriggerError ? error.code : "filter_failed";
    await database.unsafe(`UPDATE trigger_deliveries SET status='error',decision='error',error_code=$2,decided_at=now() WHERE id=$1`, [delivery.id, code]);
    return 1;
  }
}

export async function triggerBatchContext(runId: string, database: Database = db) {
  const rows = await database.unsafe(`SELECT d.id,d.event_name AS "eventName",d.payload,d.received_at AS "receivedAt"
    FROM trigger_batches b JOIN trigger_deliveries d ON d.batch_id=b.id WHERE b.run_id=$1 ORDER BY d.received_at,d.id`, [uuid.parse(runId)]);
  return rows.map((row: any) => ({ ...row, payload: jsonColumn(row.payload) }));
}

export async function syncTriggerBatches(database: Database = db) {
  await database.unsafe(`UPDATE trigger_batches b SET status=CASE WHEN r.status='queued' THEN 'queued'
    WHEN r.status IN ('preparing','running') THEN 'running' ELSE 'finished' END,updated_at=now()
    FROM runs r WHERE b.run_id=r.id AND b.status<>CASE WHEN r.status='queued' THEN 'queued'
    WHEN r.status IN ('preparing','running') THEN 'running' ELSE 'finished' END`);
}

const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function handleTriggers(request: Request, ownerId: string, dependencies: { database?: Database; fetchImpl?: typeof fetch; runFilterImpl?: typeof runFilter } = {}): Promise<Response | null> {
  const database = dependencies.database ?? db; const fetchImpl = dependencies.fetchImpl ?? fetch;
  const path = new URL(request.url).pathname;
  const collection = path.match(/^\/api\/companions\/([a-f0-9-]+)\/triggers$/i);
  const history = path.match(/^\/api\/companions\/([a-f0-9-]+)\/triggers\/([a-f0-9-]+)\/deliveries$/i);
  const member = path.match(/^\/api\/companions\/([a-f0-9-]+)\/triggers\/([a-f0-9-]+)(\/(?:test|register))?$/i);
  if (!collection && !member && !history) return null;
  if (!ownerId) return response({ error: "Authentication required." }, 401);
  try {
    if (collection && request.method === "GET") {
      const rows = await database.unsafe(`SELECT ${triggerColumns} FROM triggers t JOIN companions c ON c.id=t.companion_id
        WHERE t.companion_id=$1 AND t.owner_id=$2 AND c.owner_id=$2 ORDER BY t.created_at,t.id`, [uuid.parse(collection[1]), ownerId]) as TriggerRow[];
      return response({ triggers: rows.map(row => publicTrigger(normalizeTrigger(row))) });
    }
    if (collection && request.method === "POST") return response(await createTrigger(database, ownerId, uuid.parse(collection[1]), await request.json(), fetchImpl), 201);
    if (history && request.method === "GET") {
      const [companionId, triggerId] = history.slice(1, 3).map(value => uuid.parse(value));
      if (!await ownedTrigger(database, ownerId, companionId, triggerId)) throw new TriggerError("Trigger not found.", 404);
      const rows = await database.unsafe(`SELECT d.id,d.event_name AS "eventName",d.payload,d.status,d.decision,d.error_code AS "errorCode",
        d.received_at AS "receivedAt",d.decided_at AS "decidedAt",d.batch_id AS "batchId",b.run_id AS "runId"
        FROM trigger_deliveries d LEFT JOIN trigger_batches b ON b.id=d.batch_id WHERE d.trigger_id=$1
        ORDER BY d.received_at DESC,d.id DESC LIMIT 100`, [triggerId]);
      return response({ deliveries: rows.map((row: any) => ({ ...row, payload: jsonColumn(row.payload) })) });
    }
    if (member) {
      const [companionId, triggerId] = member.slice(1, 3).map(value => uuid.parse(value));
      const trigger = await ownedTrigger(database, ownerId, companionId, triggerId);
      if (!trigger) throw new TriggerError("Trigger not found.", 404);
      if (member[3] && request.method === "POST") {
        if (member[3] === "/register") return response({ trigger: await reconcileTriggerRegistration(ownerId, companionId, triggerId, { database, fetchImpl }) });
        const payload = await request.json();
        const matches = sourceMatches(trigger, payload, trigger.source === "github" ? "workflow_run" : trigger.source === "sentry" ? "event.created" : null);
        const responses = matches && trigger.mode === "filter" ? await resolveFilterRequests(trigger, database, fetchImpl) : {};
        const accepted = matches && (trigger.mode === "direct"
          || await (dependencies.runFilterImpl ?? runFilter)({ code: trigger.filterCode!, payload, responses }));
        return response({ decision: accepted ? "trigger" : "ignore" });
      }
      if (!member[3] && request.method === "PATCH") {
        const patch = triggerUpdateSchema.parse(await request.json());
        const filterCode = patch.filterCode ?? patch.filter;
        if (patch.mode === "filter" && !filterCode && !trigger.filterCode) throw new TriggerError("Filter code is required.");
        if ((patch.mode ?? trigger.mode) === "direct" && patch.filterRequests?.length) throw new TriggerError("API requests require a code filter.");
        await database.unsafe(`UPDATE triggers SET name=COALESCE($4,name),prompt=COALESCE($5,prompt),mode=COALESCE($6,mode),
          filter_code=CASE WHEN $6='direct' THEN NULL ELSE COALESCE($7,filter_code) END,
          filter_requests=CASE WHEN $6='direct' THEN '[]'::jsonb ELSE COALESCE($8::jsonb,filter_requests) END,
          problem_path=COALESCE($9,problem_path),enabled=COALESCE($10,enabled),updated_at=now()
          WHERE id=$1 AND companion_id=$2 AND owner_id=$3`, [triggerId, companionId, ownerId, patch.name ?? null, patch.prompt ?? null,
          patch.mode ?? null, filterCode ?? null, patch.filterRequests ? JSON.stringify(patch.filterRequests) : null, patch.problemPath ?? null, patch.enabled ?? null]);
        return response({ trigger: publicTrigger((await ownedTrigger(database, ownerId, companionId, triggerId))!) });
      }
      if (!member[3] && request.method === "DELETE") {
        await unregisterProvider(trigger, database, fetchImpl);
        await database.unsafe(`DELETE FROM triggers WHERE id=$1 AND companion_id=$2 AND owner_id=$3`, [triggerId, companionId, ownerId]);
        return response({ ok: true });
      }
    }
    return response({ error: "Method not allowed." }, 405);
  } catch (error) {
    if (error instanceof TriggerError) return response({ error: error.message, code: error.code }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return response({ error: "Invalid trigger request." }, 400);
    return response({ error: "Trigger request failed." }, 500);
  }
}
