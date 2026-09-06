import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createCompanion, migrate } from "../src/store";
import { productActivation, billingConfiguration, flushPendingUsage, handleBilling, handleStripeWebhook, migrateBilling, recordUsage, setBillingProviderForTests, verifyStripeSignature, type BillingProvider, type UsageInput } from "../src/billing";
import { db } from "../src/store";

const saved = { ...process.env };
beforeAll(async () => { await migrate(); await migrateBilling(); });
afterEach(() => {
  for (const key of ["STRIPE_SECRET_KEY","STRIPE_PRICE_ID","STRIPE_WEBHOOK_SECRET","STRIPE_METER_EVENT_NAME","STRIPE_BOX_METER_EVENT_NAME","APP_URL","BILLING_TEST_MODE"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  setBillingProviderForTests(null);
});
async function user(email: string) {
  const id = crypto.randomUUID();
  await db`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (${id},${email},${email},true,now(),now())`;
  return id;
}
function stripeMode() {
  process.env.STRIPE_SECRET_KEY = "sk_test_local";
  process.env.STRIPE_PRICE_ID = "price_local";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_signing_secret";
  process.env.STRIPE_METER_EVENT_NAME = "companions_usage";
  process.env.STRIPE_BOX_METER_EVENT_NAME = "companions_box_seconds";
  process.env.APP_URL = "http://127.0.0.1:4310";
}
function signed(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET!).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}
async function webhook(type: string, object: Record<string, unknown>, created: number) {
  const body = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type, created, data: { object } });
  return handleStripeWebhook(new Request("http://localhost/api/stripe/webhook", {
    method: "POST", headers: { "stripe-signature": signed(body) }, body,
  }));
}

test("missing Stripe configuration remains visibly unavailable", async () => {
  for (const key of ["STRIPE_SECRET_KEY","STRIPE_PRICE_ID","STRIPE_WEBHOOK_SECRET","STRIPE_METER_EVENT_NAME","STRIPE_BOX_METER_EVENT_NAME","APP_URL","BILLING_TEST_MODE"]) delete process.env[key];
  expect(billingConfiguration().mode).toBe("unconfigured");
  const owner = await user(`unconfigured-${crypto.randomUUID()}@example.com`);
  const overview = await handleBilling(new Request("http://localhost/api/billing"), owner);
  expect(await overview!.json()).toMatchObject({ configured: false, plan: "inactive", active: false, status: null });
  expect((await handleBilling(new Request("http://localhost/api/billing/checkout", { method: "POST" }), owner))!.status).toBe(503);
});

test("usage is durable, owner scoped and deduplicated before meter delivery", async () => {
  stripeMode();
  const owner = await user(`usage-${crypto.randomUUID()}@example.com`);
  await db`INSERT INTO billing_accounts (owner_id,stripe_customer_id) VALUES (${owner},${`cus_${crypto.randomUUID()}`})`;
  const delivered: string[] = [];
  setBillingProviderForTests({
    async createCheckout() { throw new Error("unused"); }, async createPortal() { throw new Error("unused"); },
    async sendMeterEvent(input) { delivered.push(input.operationId); },
  });
  const input = { operationId: `run:${crypto.randomUUID()}`, ownerId: owner, category: "model_tokens", quantity: 42, unit: "token", metadata: { model: "test" } } satisfies UsageInput;
  expect(await recordUsage(input)).toEqual({ recorded: true, delivery: "sent" });
  expect(await recordUsage(input)).toEqual({ recorded: false, delivery: "duplicate" });
  await expect(recordUsage({ ...input, quantity: 43 })).rejects.toThrow("different billing data");
  await expect(recordUsage({ ...input, operationId: `run:${crypto.randomUUID()}`, unit: "second" } as unknown as UsageInput)).rejects.toThrow();
  expect(delivered).toEqual([input.operationId]);
  const overview = await handleBilling(new Request("http://localhost/api/billing"), owner);
  expect((await overview!.json() as any).usage).toEqual([{ category: "model_tokens", unit: "token", quantity: "42" }]);
  await expect(recordUsage({ ...input, operationId: `run:${crypto.randomUUID()}`, metadata: { apiKey: "must-not-be-stored" } })).rejects.toThrow("Sensitive metadata");
  const anotherOwner = await user(`other-usage-${crypto.randomUUID()}@example.com`);
  const anotherCompanion = await createCompanion(anotherOwner, { name: "Private", instructions: "", provider: "local" });
  await expect(recordUsage({ ...input, operationId: `run:${crypto.randomUUID()}`, companionId: anotherCompanion.id })).rejects.toThrow("does not belong");
});

test("metered usage recorded before Checkout remains pending while lifecycle audit events are skipped", async () => {
  stripeMode();
  const owner = await user(`pending-${crypto.randomUUID()}@example.com`);
  const operationId = `box:${crypto.randomUUID()}`; const delivered: string[] = [];
  setBillingProviderForTests({ async createCheckout() { throw new Error("unused"); }, async createPortal() { throw new Error("unused"); }, async sendMeterEvent(input) { delivered.push(input.operationId); } });
  expect(await recordUsage({ operationId, ownerId: owner, category: "box_seconds", quantity: 60, unit: "second" })).toEqual({ recorded: true, delivery: "pending" });
  expect(await recordUsage({ operationId: `lifecycle:${crypto.randomUUID()}`, ownerId: owner, category: "box_lifecycle", quantity: 1, unit: "event" })).toEqual({ recorded: true, delivery: "skipped" });
  await db`INSERT INTO billing_accounts (owner_id,stripe_customer_id) VALUES (${owner},${`cus_${crypto.randomUUID()}`})`;
  expect(await flushPendingUsage(owner)).toEqual({ sent: 1, pending: 0 });
  expect(delivered).toEqual([operationId]);
});

test("late meter delivery preserves the usage time from the subscription period where it occurred", async () => {
  stripeMode();
  const owner = await user(`late-usage-${crypto.randomUUID()}@example.com`);
  const customer = `cus_${crypto.randomUUID()}`;
  const subscription = `sub_${crypto.randomUUID()}`;
  const operationId = `run:${crypto.randomUUID()}`;
  const firstPeriodEnd = Math.floor(Date.now() / 1000) - 3_600;
  const occurredAt = new Date((firstPeriodEnd - 60) * 1_000);
  await db`INSERT INTO billing_accounts (owner_id,stripe_customer_id) VALUES (${owner},${customer})`;
  expect((await webhook("customer.subscription.updated", {
    id: subscription, customer, status: "active", metadata: { owner_id: owner }, current_period_end: firstPeriodEnd,
    cancel_at_period_end: false, items: { data: [{ price: { id: "price_local" } }] },
  }, firstPeriodEnd - 3_600)).status).toBe(200);

  const delivered: Array<{ operationId: string; occurredAt: Date }> = [];
  let providerUnavailable = true;
  setBillingProviderForTests({
    async createCheckout() { throw new Error("unused"); },
    async createPortal() { throw new Error("unused"); },
    async sendMeterEvent(input) {
      if (providerUnavailable) throw new Error("simulated outage");
      delivered.push({ operationId: input.operationId, occurredAt: input.occurredAt });
    },
  });
  expect(await recordUsage({ operationId, ownerId: owner, category: "model_tokens", quantity: 250, unit: "token", occurredAt })).toEqual({ recorded: true, delivery: "pending" });

  const nextPeriodEnd = firstPeriodEnd + 30 * 86_400;
  expect((await webhook("customer.subscription.updated", {
    id: subscription, customer, status: "active", metadata: { owner_id: owner }, current_period_end: nextPeriodEnd,
    cancel_at_period_end: false, items: { data: [{ price: { id: "price_local" } }] },
  }, firstPeriodEnd + 1)).status).toBe(200);
  providerUnavailable = false;
  expect(await flushPendingUsage(owner)).toEqual({ sent: 1, pending: 0 });
  expect(delivered).toHaveLength(1);
  expect(delivered[0].operationId).toBe(operationId);
  expect(delivered[0].occurredAt.toISOString()).toBe(occurredAt.toISOString());
  const [state] = await db`SELECT l.occurred_at,l.stripe_delivery_status,s.current_period_end
    FROM usage_ledger l JOIN billing_subscriptions s ON s.owner_id=l.owner_id
    WHERE l.owner_id=${owner} AND l.operation_id=${operationId} AND s.stripe_subscription_id=${subscription}`;
  expect(new Date(state.occurred_at).toISOString()).toBe(occurredAt.toISOString());
  expect(new Date(state.current_period_end).toISOString()).toBe(new Date(nextPeriodEnd * 1_000).toISOString());
  expect(state.stripe_delivery_status).toBe("sent");
});

test("only the selected subscription and configured price grant access", async () => {
  stripeMode();
  const owner = await user(`subscriptions-${crypto.randomUUID()}@example.com`);
  const customer = `cus_${crypto.randomUUID()}`;
  const firstSubscription = `sub_${crypto.randomUUID()}`;
  const selectedSubscription = `sub_${crypto.randomUUID()}`;
  const base = Math.floor(Date.now() / 1000) - 100;
  const subscriptionObject = (id: string, status: string, price = "price_local") => ({
    id, customer, status, metadata: { owner_id: owner }, current_period_end: base + 3600,
    cancel_at_period_end: false, items: { data: [{ price: { id: price } }] },
  });

  expect((await webhook("customer.subscription.updated", subscriptionObject(firstSubscription, "active"), base)).status).toBe(200);
  expect((await webhook("checkout.session.completed", {
    id: `cs_${crypto.randomUUID()}`, customer, subscription: firstSubscription,
    client_reference_id: owner, metadata: { owner_id: owner },
  }, base + 1)).status).toBe(200);
  expect(await (await handleBilling(new Request("http://localhost/api/billing"), owner))!.json()).toMatchObject({ active: true, status: "active" });

  expect((await webhook("checkout.session.completed", {
    id: `cs_${crypto.randomUUID()}`, customer, subscription: selectedSubscription,
    client_reference_id: owner, metadata: { owner_id: owner },
  }, base + 2)).status).toBe(200);
  expect(await (await handleBilling(new Request("http://localhost/api/billing"), owner))!.json()).toMatchObject({ active: false, status: null });

  expect((await webhook("customer.subscription.updated", subscriptionObject(selectedSubscription, "active"), base + 3)).status).toBe(200);
  expect((await webhook("customer.subscription.deleted", subscriptionObject(firstSubscription, "canceled"), base + 4)).status).toBe(200);
  expect(await (await handleBilling(new Request("http://localhost/api/billing"), owner))!.json()).toMatchObject({ active: true, status: "active" });

  const wrongPriceSubscription = `sub_${crypto.randomUUID()}`;
  expect((await webhook("checkout.session.completed", {
    id: `cs_${crypto.randomUUID()}`, customer, subscription: wrongPriceSubscription,
    client_reference_id: owner, metadata: { owner_id: owner },
  }, base + 5)).status).toBe(200);
  expect((await webhook("customer.subscription.updated", subscriptionObject(wrongPriceSubscription, "active", "price_other"), base + 6)).status).toBe(200);
  expect(await (await handleBilling(new Request("http://localhost/api/billing"), owner))!.json()).toMatchObject({ active: false, status: "active", plan: "inactive" });
});

test("raw Stripe signatures and durable event IDs protect subscription ownership", async () => {
  stripeMode();
  const owner = await user(`webhook-${crypto.randomUUID()}@example.com`);
  const customer = `cus_${crypto.randomUUID()}`; const subscription = `sub_${crypto.randomUUID()}`;
  await db`INSERT INTO billing_accounts (owner_id,stripe_customer_id) VALUES (${owner},${customer})`;
  const payload = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type: "customer.subscription.updated", created: Math.floor(Date.now()/1000), data: { object: { id: subscription, customer, status: "active", metadata: { owner_id: owner }, current_period_end: Math.floor(Date.now()/1000)+3600, cancel_at_period_end: false, items: { data: [{ price: { id: "price_local" } }] } } } });
  expect(verifyStripeSignature(payload, signed(payload), process.env.STRIPE_WEBHOOK_SECRET!)).toBe(true);
  expect(verifyStripeSignature(`${payload} `, signed(payload), process.env.STRIPE_WEBHOOK_SECRET!)).toBe(false);
  expect((await handleStripeWebhook(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=00" }, body: payload }))).status).toBe(400);
  const first = await handleStripeWebhook(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": signed(payload) }, body: payload }));
  expect(await first.json()).toEqual({ received: true, duplicate: false });
  const second = await handleStripeWebhook(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": signed(payload) }, body: payload }));
  expect(await second.json()).toEqual({ received: true, duplicate: true });
  const stalePayload = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type: "customer.subscription.updated", created: Math.floor(Date.now()/1000)-60, data: { object: { id: subscription, customer, status: "past_due", metadata: { owner_id: owner }, items: { data: [{ price: { id: "price_local" } }] } } } });
  expect((await handleStripeWebhook(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": signed(stalePayload) }, body: stalePayload }))).status).toBe(200);
  const overview = await handleBilling(new Request("http://localhost/api/billing"), owner);
  expect(await overview!.json()).toMatchObject({ status: "active", active: true, plan: "subscription" });
});

test("checkout and portal use injected provider without exposing configuration", async () => {
  stripeMode();
  const owner = await user(`checkout-${crypto.randomUUID()}@example.com`);
  const calls: string[] = [];
  const fake: BillingProvider = {
    async createCheckout(input) { calls.push(`checkout:${input.ownerId}`); return "https://checkout.stripe.test/session"; },
    async createPortal(id) { calls.push(`portal:${id}`); return "https://billing.stripe.test/session"; },
    async sendMeterEvent() {},
  };
  setBillingProviderForTests(fake);
  const checkout = await handleBilling(new Request("http://localhost/api/billing/checkout", { method: "POST" }), owner);
  expect(await checkout!.json()).toEqual({ url: "https://checkout.stripe.test/session" });
  await db`INSERT INTO billing_accounts (owner_id,stripe_customer_id) VALUES (${owner},'cus_portal')`;
  const portal = await handleBilling(new Request("http://localhost/api/billing/portal", { method: "POST" }), owner);
  expect(await portal!.json()).toEqual({ url: "https://billing.stripe.test/session" });
  expect(calls).toEqual([`checkout:${owner}`, "portal:cus_portal"]);
});


test("activation can share an existing transaction instead of acquiring a nested connection",async()=>{
 stripeMode();delete process.env.BILLING_TEST_MODE;
 const owner=await user(`transaction-${crypto.randomUUID()}@example.com`),customer=`cus_${crypto.randomUUID()}`,subscription=`sub_${crypto.randomUUID()}`;
 await db.begin(async tx=>{
  await tx`INSERT INTO billing_accounts(owner_id,stripe_customer_id,stripe_subscription_id) VALUES(${owner},${customer},${subscription})`;
  await tx`INSERT INTO billing_subscriptions(stripe_subscription_id,owner_id,stripe_customer_id,stripe_price_id,subscription_status,last_event_created) VALUES(${subscription},${owner},${customer},'price_local','active',1)`;
  expect((await productActivation(owner,tx)).allowed).toBe(true);
  await tx`UPDATE billing_subscriptions SET subscription_status='canceled' WHERE stripe_subscription_id=${subscription}`;
  expect((await productActivation(owner,tx)).allowed).toBe(false);
 });
});
