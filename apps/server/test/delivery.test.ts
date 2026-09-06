import { afterEach, beforeAll, expect, test } from "bun:test";
import { migrate, createCompanion, acceptMessage, detail, db } from "../src/store";
import { migrateBilling } from "../src/billing";
import { acceptDelivery, canMaintainCompanion, createDelivery, handleDelivery, migrateDelivery, sendDeliveryReadyInvite, setDeliveryMailerForTests } from "../src/delivery";
import { migrateDeliverySkills } from "../src/delivery-skills";
import { allowTemplate, listTemplateRevisions, listTemplates, saveTemplate } from "../src/templates";
import { attachPlugin, selectedPlugins } from "../src/plugins";
import { encrypt } from "../src/config";

beforeAll(async () => { await migrate(); await migrateBilling(); await migrateDelivery(); await migrateDeliverySkills(); });
afterEach(() => {
  setDeliveryMailerForTests(null);
  for (const key of ["BILLING_TEST_MODE", "STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "STRIPE_WEBHOOK_SECRET", "STRIPE_METER_EVENT_NAME", "STRIPE_BOX_METER_EVENT_NAME", "APP_URL"]) delete process.env[key];
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
  const mails: Array<{ to: string; text: string }> = [];
  setDeliveryMailerForTests(async mail => { mails.push(mail); });
  const delivery = await createDelivery(sender, { clientDeliveryId: crypto.randomUUID(), companionId: source.id, clientEmail: recipientEmail.toUpperCase(), maintenanceRequested: true, includeSkills: false });
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

test("two clients receive isolated copies from one source without history, files, connections, or later propagation", async () => {
  process.env.BILLING_TEST_MODE = "1";
  const sender = await user(`sender-${crypto.randomUUID()}@example.com`);
  const firstEmail = `first-${crypto.randomUUID()}@example.com`;
  const secondEmail = `second-${crypto.randomUUID()}@example.com`;
  const firstOwner = await user(firstEmail);
  const secondOwner = await user(secondEmail);
  const source = await createCompanion(sender, {
    name: "Shared source",
    instructions: "Original instructions",
    provider: "local",
    avatar: { shape: 2, color: 3, face: 4 },
  });

  const runId = await acceptMessage(sender, source.id, crypto.randomUUID(), "Private source history", 1);
  await db`INSERT INTO attachments (id,client_file_id,owner_id,companion_id,run_id,kind,position,filename,content_type,byte_size,sha256,storage_key)
    VALUES (${crypto.randomUUID()},${crypto.randomUUID()},${sender},${source.id},${runId},'user_upload',0,'private.txt','text/plain',7,${"a".repeat(64)},${`test/${crypto.randomUUID()}`})`;
  const pluginId = crypto.randomUUID();
  await db`INSERT INTO plugin_accounts (id,owner_id,provider,label,credential_secret)
    VALUES (${pluginId},${sender},'custom','Private connection',${encrypt(JSON.stringify({ kind: "custom", transport: "http", url: "https://example.invalid/mcp", headers: {} }))})`;
  await attachPlugin(sender, source.id, pluginId, true);
  expect((await detail(sender, source.id))?.messages).toHaveLength(1);
  expect(await db`SELECT id FROM attachments WHERE companion_id=${source.id}`).toHaveLength(1);
  expect(await selectedPlugins(sender, source.id)).toHaveLength(1);

  const template = await saveTemplate(sender, { name: "Researcher", instructions: "Initial template", avatar: { shape: 1, color: 2, face: 3 } });
  await allowTemplate(sender, source.id, { templateId: template.id, maxChildren: 2 });
  setDeliveryMailerForTests(async () => {});
  const [firstDelivery, secondDelivery] = await Promise.all([
    createDelivery(sender, { clientDeliveryId: crypto.randomUUID(), companionId: source.id, clientEmail: firstEmail, templateIds: [template.id], includeSkills: false }),
    createDelivery(sender, { clientDeliveryId: crypto.randomUUID(), companionId: source.id, clientEmail: secondEmail, templateIds: [template.id], includeSkills: false }),
  ]);
  const first = await acceptDelivery(firstOwner, firstDelivery!.id, false);
  const second = await acceptDelivery(secondOwner, secondDelivery!.id, false);
  expect(first?.companionId).not.toBe(second?.companionId);

  const [firstCopy, secondCopy] = await Promise.all([detail(firstOwner, first!.companionId), detail(secondOwner, second!.companionId)]);
  expect(firstCopy?.companion).toMatchObject({ name: "Shared source", instructions: "Original instructions" });
  expect(secondCopy?.companion).toMatchObject({ name: "Shared source", instructions: "Original instructions" });
  expect(firstCopy?.messages).toEqual([]);
  expect(secondCopy?.messages).toEqual([]);
  expect(firstCopy?.runs).toEqual([]);
  expect(secondCopy?.runs).toEqual([]);
  expect(await selectedPlugins(firstOwner, first!.companionId)).toEqual([]);
  expect(await selectedPlugins(secondOwner, second!.companionId)).toEqual([]);
  const copiedFiles = await db`SELECT id FROM attachments WHERE companion_id IN (${first!.companionId},${second!.companionId})`;
  expect(copiedFiles).toHaveLength(0);

  const firstTemplates = await listTemplates(firstOwner);
  const secondTemplates = await listTemplates(secondOwner);
  expect(firstTemplates).toHaveLength(1);
  expect(secondTemplates).toHaveLength(1);
  expect(firstTemplates[0]).toMatchObject({ name: "Researcher", instructions: "Initial template", sourceCompanionId: null, hasSnapshot: false, revision: 1 });
  expect(secondTemplates[0]).toMatchObject({ name: "Researcher", instructions: "Initial template", sourceCompanionId: null, hasSnapshot: false, revision: 1 });
  expect(firstTemplates[0].id).not.toBe(secondTemplates[0].id);
  expect(firstTemplates[0].id).not.toBe(template.id);
  expect(secondTemplates[0].id).not.toBe(template.id);

  await saveTemplate(firstOwner, { id: firstTemplates[0].id, expectedRevision: 1, name: "Client one revision", instructions: "Only client one", avatar: { shape: 4, color: 5, face: 0 } });
  await db`UPDATE companions SET name='Client one companion' WHERE id=${first!.companionId} AND owner_id=${firstOwner}`;
  await saveTemplate(sender, { id: template.id, expectedRevision: 1, name: "Source revision", instructions: "Only the sender", avatar: { shape: 5, color: 6, face: 1 } });
  await db`UPDATE companions SET name='Renamed source' WHERE id=${source.id} AND owner_id=${sender}`;
  expect((await listTemplates(secondOwner))[0]).toMatchObject({ name: "Researcher", instructions: "Initial template", revision: 1 });
  expect((await listTemplates(sender))[0]).toMatchObject({ name: "Source revision", instructions: "Only the sender", revision: 2 });
  expect((await detail(secondOwner, second!.companionId))?.companion.name).toBe("Shared source");
  expect((await detail(firstOwner, first!.companionId))?.companion.name).toBe("Client one companion");
  expect((await detail(sender, source.id))?.companion.name).toBe("Renamed source");
  expect(await listTemplateRevisions(secondOwner, firstTemplates[0].id)).toEqual([]);
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
  process.env.STRIPE_PRICE_ID = "price_local";
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
