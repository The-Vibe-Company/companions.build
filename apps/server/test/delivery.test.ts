import { afterEach, beforeAll, expect, test } from "bun:test";
import { migrate, createCompanion, db } from "../src/store";
import { migrateBilling } from "../src/billing";
import { acceptDelivery, canMaintainCompanion, createDelivery, handleDelivery, migrateDelivery, setDeliveryMailerForTests } from "../src/delivery";

beforeAll(async () => { await migrate(); await migrateBilling(); await migrateDelivery(); });
afterEach(() => { setDeliveryMailerForTests(null); delete process.env.BILLING_TEST_MODE; });
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
  const mails: Array<{ to: string; text: string }> = [];
  setDeliveryMailerForTests(async mail => { mails.push(mail); });
  const delivery = await createDelivery(sender, { companionId: source.id, clientEmail: recipientEmail.toUpperCase(), maintenanceRequested: true });
  expect(delivery?.clientEmail).toBe(recipientEmail);
  expect(mails[0].to).toBe(recipientEmail);
  expect(await acceptDelivery(stranger, delivery!.id, true)).toBeNull();
  const accepted = await acceptDelivery(recipient, delivery!.id, true);
  expect(accepted?.accepted).toBe(true);
  expect(accepted?.companionId).not.toBe(source.id);
  const [copy] = await db`SELECT owner_id,name,instructions,box_id,endpoint_secret FROM companions WHERE id=${accepted!.companionId}`;
  expect(copy).toMatchObject({ owner_id: recipient, name: "Scout", instructions: "Watch the market", box_id: null, endpoint_secret: null });
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
  const delivery = await createDelivery(sender, { companionId: source.id, clientEmail: recipientEmail, maintenanceRequested: true });
  const accepted = await acceptDelivery(recipient, delivery!.id, false);
  expect(await canMaintainCompanion(sender, accepted!.companionId)).toBe(false);
});

test("sender and recipient listings do not leak deliveries across accounts", async () => {
  const sender = await user(`sender-${crypto.randomUUID()}@example.com`);
  const recipientEmail = `client-${crypto.randomUUID()}@example.com`; const recipient = await user(recipientEmail);
  const stranger = await user(`stranger-${crypto.randomUUID()}@example.com`);
  const source = await createCompanion(sender, { name: "Ledger", instructions: "Reconcile", provider: "local" });
  setDeliveryMailerForTests(async () => {});
  const delivery = await createDelivery(sender, { companionId: source.id, clientEmail: recipientEmail });
  const sent = await (await handleDelivery(new Request("http://localhost/api/deliveries"), sender))!.json() as any;
  const received = await (await handleDelivery(new Request("http://localhost/api/deliveries"), recipient))!.json() as any;
  const unrelated = await (await handleDelivery(new Request("http://localhost/api/deliveries"), stranger))!.json() as any;
  expect(sent.sent.some((item: any) => item.id === delivery!.id)).toBe(true);
  expect(received.received.some((item: any) => item.id === delivery!.id)).toBe(true);
  expect(unrelated.sent).toEqual([]); expect(unrelated.received).toEqual([]);
});
