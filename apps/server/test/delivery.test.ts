import { afterEach, beforeAll, expect, test } from "bun:test";
import { migrate, createCompanion, acceptMessage, detail, db } from "../src/store";
import { migrateBilling } from "../src/billing";
import { acceptDelivery, canMaintainCompanion, createDelivery, handleDelivery, migrateDelivery, sendDeliveryReadyInvite, setDeliveryMailerForTests } from "../src/delivery";
import { migrateDeliverySkills } from "../src/delivery-skills";
import { attachPlugin, selectedPlugins } from "../src/plugins";
import { config, encrypt } from "../src/config";

beforeAll(async () => { await migrate(); await migrateBilling(); await migrateDelivery(); await migrateDeliverySkills(); });
afterEach(() => {
  setDeliveryMailerForTests(null);
  for (const key of ["BILLING_TEST_MODE", "STRIPE_SECRET_KEY", "STRIPE_BASE_PRICE_ID", "STRIPE_MODEL_PRICE_ID", "STRIPE_BOX_PRICE_ID", "STRIPE_WEBHOOK_SECRET", "STRIPE_METER_EVENT_NAME", "STRIPE_BOX_METER_EVENT_NAME", "APP_URL"]) delete process.env[key];
});
async function user(email: string) {
  const id = crypto.randomUUID();
  await db`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (${id},${email},${email},true,now(),now())`;
  return id;
}

test("a verified matching client receives an independent copy with explicit revocable maintenance", async () => {
  process.env.BILLING_TEST_MODE = "1";
  const sender = await user(`sender-${crypto.randomUUID()}@example.com`);
  const recipientEmail = `client-${crypto.randomUUID()}@example.com`;
  const recipient = await user(recipientEmail);
  const stranger = await user(`stranger-${crypto.randomUUID()}@example.com`);
  const source = await createCompanion(sender, { name: "Scout", instructions: "Watch the market", provider: "local" });
  await db`UPDATE companions SET model_id='glm-5.3-flash' WHERE id=${source.id}`;
  const mails: Array<{ to: string; text: string }> = [];
  setDeliveryMailerForTests(async mail => { mails.push(mail); });
  const delivery = await createDelivery(sender, { clientDeliveryId: crypto.randomUUID(), companionId: source.id, clientEmail: recipientEmail.toUpperCase(), maintenanceRequested: true, includeSkills: false });
  expect(delivery?.clientEmail).toBe(recipientEmail);
  expect(mails[0].to).toBe(recipientEmail);
  expect(await acceptDelivery(stranger, delivery!.id, true)).toBeNull();
  const accepted = await acceptDelivery(recipient, delivery!.id, true);
  expect(accepted?.accepted).toBe(true);
  expect(accepted?.companionId).not.toBe(source.id);
  const [copy] = await db`SELECT owner_id,name,instructions,box_id,endpoint_secret,model_id FROM companions WHERE id=${accepted!.companionId}`;
  expect(copy).toMatchObject({ owner_id: recipient, name: "Scout", instructions: "Watch the market", box_id: null, endpoint_secret: null, model_id: "glm-5.3-flash" });
  expect(await canMaintainCompanion(sender, accepted!.companionId)).toBe(true);
  expect(await canMaintainCompanion(stranger, accepted!.companionId)).toBe(false);
  const revoked = await handleDelivery(new Request(`http://localhost/api/deliveries/${delivery!.id}/maintenance`, { method: "DELETE" }), recipient);
  expect(revoked?.status).toBe(200);
  expect(await canMaintainCompanion(sender, accepted!.companionId)).toBe(false);
});

test("maintenance is never granted unless the client explicitly accepts it", async () => {
  process.env.BILLING_TEST_MODE = "1";
  const sender = await user(`sender-${crypto.randomUUID()}@example.com`);
  const recipientEmail = `client-${crypto.randomUUID()}@example.com`; const recipient = await user(recipientEmail);
  const source = await createCompanion(sender, { name: "Private", instructions: "No access", provider: "local" });
  setDeliveryMailerForTests(async () => {});
  const delivery = await createDelivery(sender, { clientDeliveryId: crypto.randomUUID(), companionId: source.id, clientEmail: recipientEmail, maintenanceRequested: true, includeSkills: false });
  const accepted = await acceptDelivery(recipient, delivery!.id, false);
  expect(await canMaintainCompanion(sender, accepted!.companionId)).toBe(false);
});

test("sender and recipient listings do not leak deliveries across accounts", async () => {
  const sender = await user(`sender-${crypto.randomUUID()}@example.com`);
  const recipientEmail = `client-${crypto.randomUUID()}@example.com`; const recipient = await user(recipientEmail);
  const stranger = await user(`stranger-${crypto.randomUUID()}@example.com`);
  const source = await createCompanion(sender, { name: "Ledger", instructions: "Reconcile", provider: "local" });
  setDeliveryMailerForTests(async () => {});
  const delivery = await createDelivery(sender, { clientDeliveryId: crypto.randomUUID(), companionId: source.id, clientEmail: recipientEmail, includeSkills: false });
  const sent = await (await handleDelivery(new Request("http://localhost/api/deliveries"), sender))!.json() as any;
  const received = await (await handleDelivery(new Request("http://localhost/api/deliveries"), recipient))!.json() as any;
  const unrelated = await (await handleDelivery(new Request("http://localhost/api/deliveries"), stranger))!.json() as any;
  expect(sent.sent.some((item: any) => item.id === delivery!.id)).toBe(true);
  expect(received.received.some((item: any) => item.id === delivery!.id)).toBe(true);
  expect(unrelated.sent).toEqual([]); expect(unrelated.received).toEqual([]);
});

test("delivery creation retries one immutable request without another email or copy", async () => {
  process.env.BILLING_TEST_MODE = "1";
  const sender = await user(`sender-${crypto.randomUUID()}@example.com`);
  const recipientEmail = `client-${crypto.randomUUID()}@example.com`; const recipient = await user(recipientEmail);
  const source = await createCompanion(sender, { name: "Retry safe", instructions: "Portable", provider: "local" });
  const clientDeliveryId = crypto.randomUUID(); let mails = 0;
  setDeliveryMailerForTests(async () => { mails++; });
  const input = { clientDeliveryId, companionId: source.id, clientEmail: recipientEmail, maintenanceRequested: false, includeSkills: false };
  const [first, retry] = await Promise.all([createDelivery(sender, input), createDelivery(sender, input)]);
  expect(retry).toEqual(first);
  expect(mails).toBe(1);
  expect((await db`SELECT id FROM companion_deliveries WHERE source_owner_id=${sender} AND client_delivery_id=${clientDeliveryId}`)).toHaveLength(1);
  const accepted = await acceptDelivery(recipient, first!.id, false);
  expect(accepted?.accepted).toBe(true);
  expect((await acceptDelivery(recipient, first!.id, false))?.accepted).toBe(false);
  expect((await db`SELECT id FROM companions WHERE owner_id=${recipient} AND name='Retry safe'`)).toHaveLength(1);
  await expect(createDelivery(sender, { ...input, clientEmail: `other-${crypto.randomUUID()}@example.com` })).rejects.toThrow("different details");
});

test("concurrent ready notifications claim one durable email attempt", async () => {
  process.env.BILLING_TEST_MODE = "1";
  const sender = await user(`sender-${crypto.randomUUID()}@example.com`);
  const recipientEmail = `client-${crypto.randomUUID()}@example.com`;
  const source = await createCompanion(sender, { name: "One invitation", instructions: "Send once", provider: "local" });
  const delivery = await createDelivery(sender, { clientDeliveryId: crypto.randomUUID(), companionId: source.id, clientEmail: recipientEmail });
  await db`UPDATE companion_deliveries SET skills_status='ready' WHERE id=${delivery!.id}`;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  setDeliveryMailerForTests(async () => { attempts++; await blocked; });

  const notifications = [sendDeliveryReadyInvite(delivery!.id), sendDeliveryReadyInvite(delivery!.id)];
  while (attempts === 0) await Bun.sleep(1);
  release();

  expect((await Promise.all(notifications)).sort()).toEqual(["not_pending", "sent"]);
  expect(attempts).toBe(1);
  expect((await db`SELECT email_status FROM companion_deliveries WHERE id=${delivery!.id}`)[0].email_status).toBe("sent");
});

test("an ambiguous mail failure becomes unknown and is never replayed", async () => {
  process.env.BILLING_TEST_MODE = "1";
  const sender = await user(`sender-${crypto.randomUUID()}@example.com`);
  const recipientEmail = `client-${crypto.randomUUID()}@example.com`;
  const recipient = await user(recipientEmail);
  const source = await createCompanion(sender, { name: "Visible invitation", instructions: "Remain accessible", provider: "local" });
  const delivery = await createDelivery(sender, { clientDeliveryId: crypto.randomUUID(), companionId: source.id, clientEmail: recipientEmail });
  await db`UPDATE companion_deliveries SET skills_status='ready' WHERE id=${delivery!.id}`;
  let attempts = 0;
  setDeliveryMailerForTests(async () => { attempts++; throw new Error("ambiguous transport failure"); });

  expect(await sendDeliveryReadyInvite(delivery!.id)).toBe("unknown");
  expect(await sendDeliveryReadyInvite(delivery!.id)).toBe("not_pending");
  expect(attempts).toBe(1);
  expect((await db`SELECT email_status FROM companion_deliveries WHERE id=${delivery!.id}`)[0].email_status).toBe("unknown");
  expect((await acceptDelivery(recipient, delivery!.id, false))?.accepted).toBe(true);
});

test("a delivery stays pending when the recipient has no active subscription", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_local";
  process.env.STRIPE_BASE_PRICE_ID = "price_base_local";
  process.env.STRIPE_MODEL_PRICE_ID = "price_model_local";
  process.env.STRIPE_BOX_PRICE_ID = "price_box_local";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_local";
  process.env.STRIPE_METER_EVENT_NAME = "tokens";
  process.env.STRIPE_BOX_METER_EVENT_NAME = "box_seconds";
  process.env.APP_URL = "http://127.0.0.1:4310";
  const sender = await user(`sender-${crypto.randomUUID()}@example.com`);
  const recipientEmail = `client-${crypto.randomUUID()}@example.com`; const recipient = await user(recipientEmail);
  const source = await createCompanion(sender, { name: "Awaiting plan", instructions: "Remain pending", provider: "local" });
  setDeliveryMailerForTests(async () => {});
  const delivery = await createDelivery(sender, { clientDeliveryId: crypto.randomUUID(), companionId: source.id, clientEmail: recipientEmail, includeSkills: false });
  await expect(acceptDelivery(recipient, delivery!.id, false)).rejects.toThrow("active subscription");
  const [persisted] = await db`SELECT status,accepted_by,delivered_companion_id FROM companion_deliveries WHERE id=${delivery!.id}`;
  expect(persisted).toMatchObject({ status: "pending", accepted_by: null, delivered_companion_id: null });
});


test("billing test mode does not opt delivered companions into the local runtime", async () => {
  process.env.BILLING_TEST_MODE = "1";
  const sender = await user(`sender-${crypto.randomUUID()}@example.com`);
  const email = `recipient-${crypto.randomUUID()}@example.com`;
  const recipient = await user(email);
  const source = await createCompanion(sender, { name: "Shared", instructions: "Help", provider: "local" });
  setDeliveryMailerForTests(async () => {});
  const delivery = await createDelivery(sender, { clientDeliveryId: crypto.randomUUID(), companionId: source.id, clientEmail: email, includeSkills: false });
  const previous = { defaultProvider: config.defaultProvider, localAvailable: config.localAvailable, boxTemplate: config.boxTemplate };
  try {
    Object.assign(config, { defaultProvider: "box", localAvailable: false, boxTemplate: "box:test-base" });
    const accepted = await acceptDelivery(recipient, delivery!.id, false);
    const [copy] = await db`SELECT provider,box_id FROM companions WHERE id=${accepted!.companionId}`;
    expect(copy).toMatchObject({ provider: "box", box_id: null });
  } finally {
    Object.assign(config, previous);
  }
});
