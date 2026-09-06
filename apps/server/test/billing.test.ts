import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createCompanion, migrate } from "../src/store";
import { billingConfiguration, flushPendingUsage, handleBilling, handleStripeWebhook, migrateBilling, recordUsage, setBillingProviderForTests, verifyStripeSignature, type BillingProvider } from "../src/billing";
import { db } from "../src/store";

const saved = { ...process.env };
beforeAll(async () => { await migrate(); await migrateBilling(); });
afterEach(() => {
  for (const key of ["STRIPE_SECRET_KEY","STRIPE_PRICE_ID","STRIPE_WEBHOOK_SECRET","STRIPE_METER_EVENT_NAME","APP_URL","BILLING_TEST_MODE"]) {
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
  process.env.APP_URL = "http://127.0.0.1:4310";
}
function signed(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET!).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

test("missing Stripe configuration remains visibly unavailable", async () => {
  for (const key of ["STRIPE_SECRET_KEY","STRIPE_PRICE_ID","STRIPE_WEBHOOK_SECRET","STRIPE_METER_EVENT_NAME","APP_URL","BILLING_TEST_MODE"]) delete process.env[key];
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
  const input = { operationId: `run:${crypto.randomUUID()}`, ownerId: owner, category: "model_tokens", quantity: 42, unit: "token", metadata: { model: "test" } };
  expect(await recordUsage(input)).toEqual({ recorded: true, delivery: "sent" });
  expect(await recordUsage(input)).toEqual({ recorded: false, delivery: "duplicate" });
  expect(delivered).toEqual([input.operationId]);
  const overview = await handleBilling(new Request("http://localhost/api/billing"), owner);
  expect((await overview!.json() as any).usage).toEqual([{ category: "model_tokens", unit: "token", quantity: "42" }]);
  await expect(recordUsage({ ...input, operationId: `run:${crypto.randomUUID()}`, metadata: { apiKey: "must-not-be-stored" } })).rejects.toThrow("Sensitive metadata");
  const anotherOwner = await user(`other-usage-${crypto.randomUUID()}@example.com`);
  const anotherCompanion = await createCompanion(anotherOwner, { name: "Private", instructions: "", provider: "local" });
  await expect(recordUsage({ ...input, operationId: `run:${crypto.randomUUID()}`, companionId: anotherCompanion.id })).rejects.toThrow("does not belong");
});

test("usage recorded before Checkout remains pending and can be flushed", async () => {
  stripeMode();
  const owner = await user(`pending-${crypto.randomUUID()}@example.com`);
  const operationId = `box:${crypto.randomUUID()}`; const delivered: string[] = [];
  setBillingProviderForTests({ async createCheckout() { throw new Error("unused"); }, async createPortal() { throw new Error("unused"); }, async sendMeterEvent(input) { delivered.push(input.operationId); } });
  expect(await recordUsage({ operationId, ownerId: owner, category: "box_lifecycle", quantity: 1, unit: "event" })).toEqual({ recorded: true, delivery: "pending" });
  await db`INSERT INTO billing_accounts (owner_id,stripe_customer_id) VALUES (${owner},${`cus_${crypto.randomUUID()}`})`;
  expect(await flushPendingUsage(owner)).toEqual({ sent: 1, pending: 0 });
  expect(delivered).toEqual([operationId]);
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
