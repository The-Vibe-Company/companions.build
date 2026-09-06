import { beforeAll, expect, test } from "bun:test";
import { db, migrate } from "../src/store";
import { migrateLifecycle } from "../src/lifecycle";
import { LifecycleConflict, listTemplateRevisions, recordTemplateRevision, rollbackTemplate, saveTemplate } from "../src/templates";

beforeAll(async () => { await migrate(); await migrateLifecycle(); });
async function owner() {
  const id = crypto.randomUUID();
  await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${id},'Template owner',${`${id}@example.test`},true)`;
  return id;
}

test("template saves append immutable revisions and rollback appends the selected state", async () => {
  const ownerId = await owner();
  const otherId = await owner();
  const created = await saveTemplate(ownerId, { name: "Developer", instructions: "Version one", avatar: { shape: 1, color: 2, face: 3 } });
  expect(created.revision).toBe(1);
  await saveTemplate(ownerId, { id: created.id, expectedRevision: 1, name: "Developer plus", instructions: "Version two", avatar: { shape: 2, color: 3, face: 4 } });

  expect(await listTemplateRevisions(otherId, created.id)).toEqual([]);
  expect((await listTemplateRevisions(ownerId, created.id)).map((row:any) => [row.revision, row.instructions])).toEqual([[2, "Version two"], [1, "Version one"]]);

  expect(await rollbackTemplate(ownerId, created.id, { targetRevision: 1, expectedRevision: 2 })).toEqual({ id: created.id, revision: 3 });
  const [current] = await db`SELECT name,instructions,avatar,revision,snapshot_name FROM agent_templates WHERE id=${created.id}`;
  expect(current).toMatchObject({ name: "Developer", instructions: "Version one", avatar: { shape: 1, color: 2, face: 3 }, revision: 3, snapshot_name: null });
  expect((await listTemplateRevisions(ownerId, created.id)).map((row:any) => row.revision)).toEqual([3, 2, 1]);

  await expect(rollbackTemplate(ownerId, created.id, { targetRevision: 2, expectedRevision: 2 })).rejects.toBeInstanceOf(LifecycleConflict);
  await expect(rollbackTemplate(otherId, created.id, { targetRevision: 2, expectedRevision: 3 })).rejects.toBeInstanceOf(LifecycleConflict);
  expect((await db`SELECT revision FROM agent_templates WHERE id=${created.id}`)[0].revision).toBe(3);
});

test("snapshot activation records a restorable revision without contacting a machine", async () => {
  const ownerId = await owner();
  const sourceId = crypto.randomUUID();
  await db`INSERT INTO companions(id,owner_id,name,instructions,provider,create_key,agent_secret,prepare_requested) VALUES(${sourceId},${ownerId},'Source','Built tools','local',${crypto.randomUUID()},'secret',false)`;
  const template = await saveTemplate(ownerId, { name: "Builder", instructions: "Build", avatar: { shape: 0, color: 0, face: 0 } });
  await db.begin(async sql => {
    await sql`UPDATE agent_templates SET snapshot_name='snapshot-v2',source_companion_id=${sourceId},revision=revision+1 WHERE id=${template.id}`;
    expect(await recordTemplateRevision(sql, template.id)).toEqual({ id: template.id, revision: 2 });
  });
  await saveTemplate(ownerId, { id: template.id, expectedRevision: 2, name: "Builder", instructions: "Changed profile", avatar: { shape: 0, color: 0, face: 1 } });

  expect(await rollbackTemplate(ownerId, template.id, { targetRevision: 1, expectedRevision: 3 })).toEqual({ id: template.id, revision: 4 });
  expect((await db`SELECT snapshot_name,source_companion_id FROM agent_templates WHERE id=${template.id}`)[0]).toMatchObject({ snapshot_name: null, source_companion_id: null });
  expect(await rollbackTemplate(ownerId, template.id, { targetRevision: 2, expectedRevision: 4 })).toEqual({ id: template.id, revision: 5 });
  expect((await db`SELECT snapshot_name,source_companion_id,revision FROM agent_templates WHERE id=${template.id}`)[0]).toMatchObject({ snapshot_name: "snapshot-v2", source_companion_id: sourceId, revision: 5 });
});

test("migration backfills the current revision of an existing template", async () => {
  const ownerId = await owner();
  const id = crypto.randomUUID();
  await db`INSERT INTO agent_templates(id,owner_id,name,instructions,avatar,revision) VALUES(${id},${ownerId},'Imported','Existing state',${{ shape: 4, color: 4, face: 4 }},7)`;
  await migrateLifecycle();
  expect((await listTemplateRevisions(ownerId, id))[0]).toMatchObject({ revision: 7, name: "Imported", instructions: "Existing state" });
});
