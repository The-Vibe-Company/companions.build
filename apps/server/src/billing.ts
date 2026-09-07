import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "./store";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const activeStatuses = new Set(["active", "trialing"]);
const safeId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const usageBase = z.object({
  operationId: safeId,
  ownerId: z.string().min(1).max(200),
  companionId: z.string().uuid().optional(),
  quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  occurredAt: z.coerce.date().optional(),
  metadata: z.record(z.string().max(80), z.union([z.string().max(200), z.number().finite(), z.boolean()])).optional(),
});
const usageInput = z.discriminatedUnion("category", [
  usageBase.extend({ category: z.literal("model_tokens"), unit: z.literal("token") }),
  usageBase.extend({ category: z.literal("box_seconds"), unit: z.literal("second") }),
  usageBase.extend({ category: z.literal("box_lifecycle"), unit: z.literal("event") }),
]).superRefine((value, context) => {
  for (const [key, item] of Object.entries(value.metadata ?? {})) {
    if (/(secret|token|password|cookie|authorization|credential|api.?key)/i.test(key) || (typeof item === "string" && /^(sk|rk|whsec)_(live|test|[A-Za-z0-9])/i.test(item))) {
      context.addIssue({ code: "custom", path: ["metadata", key], message: "Sensitive metadata is not allowed" });
    }
  }
});
export type UsageInput = z.input<typeof usageInput>;
export class UsageConflict extends Error {}

export interface BillingProvider {
  createCheckout(input: { ownerId: string; email: string; customerId: string | null }): Promise<string>;
  createPortal(customerId: string): Promise<string>;
  sendMeterEvent(input: { customerId: string; operationId: string; quantity: number; occurredAt: Date; category: string; unit: string }): Promise<void>;
}

export function billingConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const test = env.NODE_ENV !== "production" && env.BILLING_TEST_MODE === "1";
  const required = ["STRIPE_SECRET_KEY", "STRIPE_BASE_PRICE_ID", "STRIPE_MODEL_PRICE_ID", "STRIPE_BOX_PRICE_ID", "STRIPE_WEBHOOK_SECRET", "STRIPE_METER_EVENT_NAME", "STRIPE_BOX_METER_EVENT_NAME", "APP_URL"] as const;
  const missing = required.filter(key => !env[key]);
  const prices = [env.STRIPE_BASE_PRICE_ID, env.STRIPE_MODEL_PRICE_ID, env.STRIPE_BOX_PRICE_ID];
  const duplicatePrices = !missing.length && new Set(prices).size !== prices.length;
  return { mode: test ? "test" as const : missing.length || duplicatePrices ? "unconfigured" as const : "stripe" as const, missing, duplicatePrices };
}

function configuredPriceFingerprint(env: NodeJS.ProcessEnv = process.env) {
  return JSON.stringify([env.STRIPE_BASE_PRICE_ID!, env.STRIPE_MODEL_PRICE_ID!, env.STRIPE_BOX_PRICE_ID!].sort());
}

export function stripeCheckoutForm(input: { ownerId: string; email: string; customerId: string | null }, env: NodeJS.ProcessEnv = process.env) {
  const base = env.APP_URL!.replace(/\/$/, "");
  const form = new URLSearchParams({
    mode: "subscription", success_url: `${base}/account?checkout=complete`, cancel_url: `${base}/account`,
    "line_items[0][price]": env.STRIPE_BASE_PRICE_ID!,
    "line_items[0][quantity]": "1",
    "line_items[1][price]": env.STRIPE_MODEL_PRICE_ID!,
    "line_items[2][price]": env.STRIPE_BOX_PRICE_ID!,
    client_reference_id: input.ownerId, "metadata[owner_id]": input.ownerId,
    "subscription_data[metadata][owner_id]": input.ownerId,
  });
  form.set(input.customerId ? "customer" : "customer_email", input.customerId ?? input.email);
  return form;
}

class StripeHttpProvider implements BillingProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  private async post(path: string, form: URLSearchParams, idempotencyKey?: string) {
    const secret = this.env.STRIPE_SECRET_KEY!;
    const response = await fetch(`https://api.stripe.com${path}`, {
      method: "POST", signal:AbortSignal.timeout(10_000),
      headers: {
        authorization: `Basic ${Buffer.from(`${secret}:`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: form,
    });
    const body = await response.json().catch(() => null) as { id?: string; url?: string } | null;
    if (!response.ok) throw new Error(`Billing provider request failed (${response.status})`);
    return body;
  }
  async createCheckout(input: { ownerId: string; email: string; customerId: string | null }) {
    const form = stripeCheckoutForm(input, this.env);
    const bucket = Math.floor(Date.now() / 1_800_000);
    const result = await this.post("/v1/checkout/sessions", form, `checkout:${input.ownerId}:${configuredPriceFingerprint(this.env)}:${bucket}`);
    if (!result?.url) throw new Error("Billing provider did not return a checkout URL");
    return result.url;
  }
  async createPortal(customerId: string) {
    const form = new URLSearchParams({ customer: customerId, return_url: `${this.env.APP_URL!.replace(/\/$/, "")}/account` });
    const result = await this.post("/v1/billing_portal/sessions", form);
    if (!result?.url) throw new Error("Billing provider did not return a portal URL");
    return result.url;
  }
  async sendMeterEvent(input: { customerId: string; operationId: string; quantity: number; occurredAt: Date; category: string; unit: string }) {
    const eventName=input.category==='model_tokens'?this.env.STRIPE_METER_EVENT_NAME:input.category==='box_seconds'?this.env.STRIPE_BOX_METER_EVENT_NAME:undefined;
    if(!eventName)throw Error('Usage meter is not configured for this category');
    await this.post("/v1/billing/meter_events", new URLSearchParams({
      event_name: eventName, identifier: input.operationId,
      timestamp: String(Math.floor(input.occurredAt.getTime() / 1000)),
      "payload[stripe_customer_id]": input.customerId, "payload[value]": String(input.quantity),
      "payload[category]": input.category, "payload[unit]": input.unit,
    }), `meter:${input.operationId}`);
  }
}

let providerOverride: BillingProvider | null = null;
export function setBillingProviderForTests(provider: BillingProvider | null) { providerOverride = provider; }
function provider() { return providerOverride ?? new StripeHttpProvider(); }

export async function migrateBilling(sql = db) {
  const schema = await Bun.file(new URL("./billing.sql", import.meta.url)).text();
  await sql.begin(async tx => { await tx`SELECT pg_advisory_xact_lock(721440140)`; await tx.unsafe(schema); });
}

export async function billingOverview(ownerId: string) {
  const mode = billingConfiguration().mode;
  const account = await billingAccountState(ownerId);
  const usage = await db`SELECT category,unit,sum(quantity)::text AS quantity FROM usage_ledger WHERE owner_id=${ownerId} GROUP BY category,unit ORDER BY category,unit`;
  const entitled = hasEntitlement(account);
  return { configured: mode !== "unconfigured", mode, plan: entitled ? "subscription" : "inactive", active: mode === "test" || (mode === "stripe" && entitled), status: account?.status ?? null, currentPeriodEnd: account?.currentPeriodEnd ?? null, cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false, portalAvailable: mode === "stripe" && !!account?.customerId, usage };
}

async function billingAccountState(ownerId: string, sql:any=db) {
  const [account] = await sql`SELECT s.subscription_status AS status,s.current_period_end AS "currentPeriodEnd",
    s.cancel_at_period_end AS "cancelAtPeriodEnd",a.stripe_customer_id AS "customerId",s.stripe_price_id AS "priceId"
    FROM billing_accounts a LEFT JOIN billing_subscriptions s ON s.stripe_subscription_id=a.stripe_subscription_id
      AND s.owner_id=a.owner_id AND s.stripe_customer_id=a.stripe_customer_id WHERE a.owner_id=${ownerId}`;
  return account;
}
function hasEntitlement(account: Awaited<ReturnType<typeof billingAccountState>>) {
  return !!account && account.priceId === configuredPriceFingerprint() && activeStatuses.has(account.status);
}

export async function productActivation(ownerId: string, sql:any=db) {
  const mode = billingConfiguration().mode;
  const allowed = mode === "test" || (mode === "stripe" && hasEntitlement(await billingAccountState(ownerId,sql)));
  return { allowed, reason: allowed ? null : mode === "unconfigured" ? "Billing is not configured." : "An active subscription is required." };
}
export async function requireProductActivation(ownerId: string, sql:any=db) {
  const result = await productActivation(ownerId,sql);
  if (!result.allowed) throw new ProductActivationRequired(result.reason!);
}
export class ProductActivationRequired extends Error {}

export async function recordUsage(raw: UsageInput) {
  const input = usageInput.parse(raw);
  if (input.companionId) {
    const [owned] = await db`SELECT 1 FROM companions WHERE id=${input.companionId} AND owner_id=${input.ownerId}`;
    if (!owned) throw new Error("Usage Companion does not belong to this account");
  }
  const occurredAt = input.occurredAt ?? new Date();
  const [row] = await db`INSERT INTO usage_ledger (id,owner_id,companion_id,operation_id,category,quantity,unit,metadata,occurred_at)
    VALUES (${crypto.randomUUID()},${input.ownerId},${input.companionId ?? null},${input.operationId},${input.category},${input.quantity},${input.unit},${input.metadata ?? {}},${occurredAt})
    ON CONFLICT (owner_id,operation_id) DO NOTHING RETURNING id`;
  if (!row) {
    const [existing] = await db`SELECT companion_id IS NOT DISTINCT FROM ${input.companionId ?? null}::uuid
      AND category=${input.category} AND quantity=${input.quantity} AND unit=${input.unit}
      AND metadata=${input.metadata ?? {}}::jsonb AS matches FROM usage_ledger
      WHERE owner_id=${input.ownerId} AND operation_id=${input.operationId}`;
    if (!existing?.matches) throw new UsageConflict("Usage identifier was already used with different billing data");
    return { recorded: false, delivery: "duplicate" as const };
  }
  const mode = billingConfiguration().mode;
  const [account] = await db`SELECT stripe_customer_id FROM billing_accounts WHERE owner_id=${input.ownerId}`;
  if (mode !== "stripe" || input.category === "box_lifecycle") {
    await db`UPDATE usage_ledger SET stripe_delivery_status='skipped' WHERE id=${row.id}`;
    return { recorded: true, delivery: "skipped" as const };
  }
  if (!account?.stripe_customer_id) return { recorded: true, delivery: "pending" as const };
  try {
    await provider().sendMeterEvent({ customerId: account.stripe_customer_id, operationId: input.operationId, quantity: input.quantity, occurredAt, category: input.category, unit: input.unit });
    await db`UPDATE usage_ledger SET stripe_delivery_status='sent',stripe_delivered_at=now() WHERE id=${row.id}`;
    return { recorded: true, delivery: "sent" as const };
  } catch {
    return { recorded: true, delivery: "pending" as const };
  }
}

export async function flushPendingUsage(ownerId: string, limit = 100) {
  if (billingConfiguration().mode !== "stripe") return { sent: 0, pending: 0 };
  const [account] = await db`SELECT stripe_customer_id FROM billing_accounts WHERE owner_id=${ownerId}`;
  if (!account?.stripe_customer_id) return { sent: 0, pending: 0 };
  const rows = await db`SELECT id,operation_id,quantity::text,occurred_at,category,unit FROM usage_ledger WHERE owner_id=${ownerId} AND stripe_delivery_status='pending' ORDER BY created_at,id LIMIT ${Math.max(1, Math.min(limit, 500))}`;
  let sent = 0;
  for (const row of rows) {
    try {
      await provider().sendMeterEvent({ customerId: account.stripe_customer_id, operationId: row.operation_id, quantity: Number(row.quantity), occurredAt: new Date(row.occurred_at), category: row.category, unit: row.unit });
      await db`UPDATE usage_ledger SET stripe_delivery_status='sent',stripe_delivered_at=now() WHERE id=${row.id} AND stripe_delivery_status='pending'`;
      sent++;
    } catch { break; }
  }
  return { sent, pending: rows.length - sent };
}

export function verifyStripeSignature(rawBody: string, header: string, secret: string, now = Date.now()) {
  const parts = header.split(",").map(value => value.split("=", 2));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!Number.isInteger(timestamp) || Math.abs(now / 1000 - timestamp) > 300 || signatures.length === 0) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  return signatures.some(value => {
    if (!/^[0-9a-f]{64}$/i.test(value)) return false;
    const actual = Buffer.from(value, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

const stripeEvent = z.object({ id: safeId, type: z.string().min(1).max(100), created: z.number().int().nonnegative(), data: z.object({ object: z.record(z.string(), z.unknown()) }) });
function stringValue(value: unknown) { return typeof value === "string" ? value : value && typeof value === "object" && "id" in value ? String((value as any).id) : null; }
function subscriptionPriceFingerprint(object: Record<string, unknown>) {
  const data = (object.items as any)?.data;
  if (!Array.isArray(data)) return "[]";
  const prices = data.map(item => stringValue(item?.price)).filter((price): price is string => !!price);
  if (prices.length !== data.length || new Set(prices).size !== prices.length) return "[]";
  return JSON.stringify([...prices].sort());
}
export async function handleStripeWebhook(request: Request) {
  if (request.method !== "POST") return json({ error: "Not found." }, 404);
  const configuration = billingConfiguration();
  if (configuration.mode !== "stripe") return json({ error: "Billing is not configured." }, 503);
  const raw = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  if (!verifyStripeSignature(raw, signature, process.env.STRIPE_WEBHOOK_SECRET!)) return json({ error: "Invalid signature." }, 400);
  let event: z.infer<typeof stripeEvent>;
  try { event = stripeEvent.parse(JSON.parse(raw)); } catch { return json({ error: "Invalid event." }, 400); }
  try {
    const duplicate = await db.begin(async tx => {
      const [claimed] = await tx`INSERT INTO stripe_webhook_events (event_id,event_type,object_id) VALUES (${event.id},${event.type},${stringValue(event.data.object.id)}) ON CONFLICT DO NOTHING RETURNING event_id`;
      if (!claimed) return true;
      const object = event.data.object;
      if (event.type === "checkout.session.completed") {
        const ownerId = stringValue((object.metadata as any)?.owner_id) ?? stringValue(object.client_reference_id);
        const customer = stringValue(object.customer); const subscription = stringValue(object.subscription);
        if (!ownerId || !customer || !subscription) throw new Error("invalid_checkout_owner");
        const [knownSubscription] = await tx`SELECT owner_id,stripe_customer_id FROM billing_subscriptions WHERE stripe_subscription_id=${subscription} FOR UPDATE`;
        if (knownSubscription && (knownSubscription.owner_id !== ownerId || knownSubscription.stripe_customer_id !== customer)) throw new Error("checkout_subscription_conflict");
        const rows = await tx`INSERT INTO billing_accounts (owner_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,last_event_created)
          VALUES (${ownerId},${customer},${subscription},${configuredPriceFingerprint()},${event.created})
          ON CONFLICT (owner_id) DO UPDATE SET stripe_customer_id=excluded.stripe_customer_id,
            stripe_subscription_id=CASE WHEN billing_accounts.last_event_created<=excluded.last_event_created THEN coalesce(excluded.stripe_subscription_id,billing_accounts.stripe_subscription_id) ELSE billing_accounts.stripe_subscription_id END,
            stripe_price_id=CASE WHEN billing_accounts.last_event_created<=excluded.last_event_created THEN excluded.stripe_price_id ELSE billing_accounts.stripe_price_id END,
            updated_at=now(),last_event_created=greatest(billing_accounts.last_event_created,excluded.last_event_created)
          WHERE billing_accounts.stripe_customer_id IS NULL OR billing_accounts.stripe_customer_id=excluded.stripe_customer_id RETURNING owner_id`;
        if (!rows.length) throw new Error("checkout_owner_conflict");
      } else if (event.type.startsWith("customer.subscription.")) {
        const subscription = stringValue(object.id); const customer = stringValue(object.customer);
        const ownerId = stringValue((object.metadata as any)?.owner_id);
        const status = String(object.status ?? "");
        const allowed = ["incomplete","incomplete_expired","trialing","active","past_due","canceled","unpaid","paused"];
        if (!subscription || !customer || !allowed.includes(status)) throw new Error("invalid_subscription");
        const periodEnd = Number(object.current_period_end ?? (object.items as any)?.data?.[0]?.current_period_end ?? 0);
        const priceId = subscriptionPriceFingerprint(object);
        const [account] = ownerId
          ? await tx`SELECT u.id AS owner_id FROM "user" u LEFT JOIN billing_accounts a ON a.owner_id=u.id
              WHERE u.id=${ownerId} AND (a.stripe_customer_id IS NULL OR a.stripe_customer_id=${customer}) FOR UPDATE OF u`
          : await tx`SELECT owner_id FROM billing_accounts WHERE stripe_customer_id=${customer} FOR UPDATE`;
        if (!account) {
          if (ownerId) throw new Error("subscription_owner_conflict");
        } else {
          const [known] = await tx`SELECT owner_id,stripe_customer_id FROM billing_subscriptions WHERE stripe_subscription_id=${subscription} FOR UPDATE`;
          if (known && (known.owner_id !== account.owner_id || known.stripe_customer_id !== customer)) throw new Error("subscription_owner_conflict");
          await tx`INSERT INTO billing_subscriptions(stripe_subscription_id,owner_id,stripe_customer_id,stripe_price_id,subscription_status,current_period_end,cancel_at_period_end,last_event_created)
            VALUES(${subscription},${account.owner_id},${customer},${priceId},${status},${periodEnd ? new Date(periodEnd * 1000) : null},${object.cancel_at_period_end === true},${event.created})
            ON CONFLICT(stripe_subscription_id) DO UPDATE SET stripe_price_id=excluded.stripe_price_id,
              subscription_status=excluded.subscription_status,current_period_end=excluded.current_period_end,
              cancel_at_period_end=excluded.cancel_at_period_end,last_event_created=excluded.last_event_created,updated_at=now()
            WHERE billing_subscriptions.owner_id=excluded.owner_id
              AND billing_subscriptions.stripe_customer_id=excluded.stripe_customer_id
              AND billing_subscriptions.last_event_created<=excluded.last_event_created`;
          await tx`UPDATE billing_accounts SET stripe_subscription_id=COALESCE(stripe_subscription_id,${subscription}),stripe_price_id=${priceId},
            subscription_status=${status},current_period_end=${periodEnd ? new Date(periodEnd * 1000) : null},
            cancel_at_period_end=${object.cancel_at_period_end === true},updated_at=now()
            WHERE owner_id=${account.owner_id} AND stripe_customer_id=${customer}
              AND (stripe_subscription_id IS NULL OR stripe_subscription_id=${subscription})`;
        }
      }
      return false;
    });
    return json({ received: true, duplicate });
  } catch { return json({ error: "Event could not be applied." }, 400); }
}

export async function handleBilling(request: Request, ownerId: string) {
  const url = new URL(request.url);
  if (url.pathname === "/api/billing" && request.method === "GET") return json(await billingOverview(ownerId));
  if (url.pathname === "/api/billing/checkout" && request.method === "POST") {
    const mode = billingConfiguration().mode;
    if (mode === "unconfigured") return json({ error: "Billing is not configured." }, 503);
    if (mode === "test") return json({ url: `${process.env.APP_URL ?? "http://127.0.0.1:4310"}/account?billing=test` });
    const [user] = await db`SELECT email FROM "user" WHERE id=${ownerId}`;
    const [account] = await db`SELECT stripe_customer_id FROM billing_accounts WHERE owner_id=${ownerId}`;
    return json({ url: await provider().createCheckout({ ownerId, email: user.email, customerId: account?.stripe_customer_id ?? null }) });
  }
  if (url.pathname === "/api/billing/portal" && request.method === "POST") {
    if (billingConfiguration().mode !== "stripe") return json({ error: "Billing is not configured." }, 503);
    const [account] = await db`SELECT stripe_customer_id FROM billing_accounts WHERE owner_id=${ownerId}`;
    if (!account?.stripe_customer_id) return json({ error: "No billing account exists yet." }, 409);
    return json({ url: await provider().createPortal(account.stripe_customer_id) });
  }
  return null;
}
