import { afterEach, beforeAll, expect, test } from "bun:test";
import { db, migrate, createCompanion } from "../src/store";
import { saveTemplate, allowTemplate } from "../src/templates";
import { registerSoftwareBase, activateSoftwareBase, enqueueTemplateSoftware, recordResolvedSoftwareManifest, getSoftwareBuild } from "../src/software";
import { createVerifiedSoftwareResult, grantedSoftwareSnapshot } from "../src/software-results";
import { createDelivery, acceptDelivery, sendDeliveryReadyInvite, setDeliveryMailerForTests } from "../src/delivery";

beforeAll(() => migrate());
afterEach(() => { delete process.env.BILLING_TEST_MODE; setDeliveryMailerForTests(null); });
async function user() {
  const id=crypto.randomUUID(),email=`${id}@example.test`;
  await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${id},'Software recipient',${email},true)`;
  return {id,email};
}
async function databaseRejects(query:PromiseLike<unknown>) {
  let rejected=false;try{await query;}catch{rejected=true;}expect(rejected).toBe(true);
}
async function fixture() {
  process.env.BILLING_TEST_MODE='1';
  const owner=await user(),baseId=`base-${crypto.randomUUID()}`,distributionDigest='a'.repeat(64);
  await registerSoftwareBase({id:baseId,providerSnapshotName:`base-${crypto.randomUUID()}`,distributionDigest,resolverConfigDigest:'b'.repeat(64),distro:{family:'ubuntu',suite:'noble',architecture:'amd64'}});
  await activateSoftwareBase(baseId);
  const template=await saveTemplate(owner.id,{name:'Prepared coder',instructions:'Use hello'});
  const build=await enqueueTemplateSoftware(owner.id,crypto.randomUUID(),{templateId:template.id,expectedRevision:1,apt:[{name:'hello',version:'2.10-3build1'}],npm:[]});
  const companion=await createCompanion(owner.id,{name:'Prepared source',provider:'local'});
  await db`UPDATE companions SET software_build_id=${build.id},snapshot_name='private-source-never-delivered' WHERE id=${companion.id}`;
  const manifest={version:1,base:{id:baseId,distributionDigest,distro:{family:'ubuntu',suite:'noble',architecture:'amd64'}},apt:{roots:['hello:amd64=2.10-3build1'],packages:[{id:'hello:amd64=2.10-3build1',name:'hello',version:'2.10-3build1',architecture:'amd64',sha256:'c'.repeat(64),dependencies:[]}]},npm:{roots:[],packages:[]}};
  return {owner,template,build,companion,manifest};
}
async function complete(f:Awaited<ReturnType<typeof fixture>>) {
  await recordResolvedSoftwareManifest(f.owner.id,f.build.id,f.manifest);
  await db`UPDATE portable_software_builds SET status='capturing',snapshot_started_at=now(),helper_request_digest=${'d'.repeat(64)} WHERE id=${f.build.id}`;
  return db.begin(async tx=>{
    const resultId=await createVerifiedSoftwareResult(tx,{id:f.build.id,ownerId:f.owner.id});
    await tx`UPDATE portable_software_builds SET status='ready',finished_at=now() WHERE id=${f.build.id}`;
    return resultId;
  });
}

test('pending prepared software sends no invitation and cannot be accepted; completion sends once',async()=>{
  const f=await fixture(),recipient=await user();let sent=0;
  setDeliveryMailerForTests(async()=>{sent++;});
  const delivery=await createDelivery(f.owner.id,{clientDeliveryId:crypto.randomUUID(),companionId:f.companion.id,clientEmail:recipient.email,includeSkills:false});
  expect(delivery?.softwareStatus).toBe('pending');expect(sent).toBe(0);
  await expect(acceptDelivery(recipient.id,delivery!.id,false)).rejects.toThrow('not ready');
  const resultId=await complete(f);
  expect(await sendDeliveryReadyInvite(delivery!.id)).toBe('sent');
  expect(await sendDeliveryReadyInvite(delivery!.id)).toBe('not_pending');expect(sent).toBe(1);
  const accepted=await acceptDelivery(recipient.id,delivery!.id,false);
  const [copy]=await db`SELECT * FROM companions WHERE id=${accepted!.companionId}`;
  expect(copy.software_result_id).toBe(resultId);expect(copy.software_build_id).toBeNull();
  expect(copy.snapshot_name).toBe(f.build.providerSnapshotName);expect(copy.snapshot_name).not.toBe('private-source-never-delivered');
  expect(copy.box_id).toBeNull();expect(copy.endpoint_secret).toBeNull();expect(copy.owner_id).toBe(recipient.id);
  expect(await getSoftwareBuild(recipient.id,f.build.id)).toBeNull();
  expect(await grantedSoftwareSnapshot(db,recipient.id,resultId)).toBe(f.build.providerSnapshotName);
  const stranger=await user();await expect(grantedSoftwareSnapshot(db,stranger.id,resultId)).rejects.toThrow('unavailable');
});

test('two accepted clients have independent execution identities and immutable clean grants',async()=>{
  const f=await fixture(),resultId=await complete(f);setDeliveryMailerForTests(async()=>{});
  const copies=[];
  for(let i=0;i<2;i++){
    const recipient=await user();
    const delivery=await createDelivery(f.owner.id,{clientDeliveryId:crypto.randomUUID(),companionId:f.companion.id,clientEmail:recipient.email,includeSkills:false});
    const accepted=await acceptDelivery(recipient.id,delivery!.id,false);
    const [copy]=await db`SELECT * FROM companions WHERE id=${accepted!.companionId}`;copies.push(copy);
  }
  expect(copies[0].create_key).not.toBe(copies[1].create_key);expect(copies[0].agent_secret).not.toBe(copies[1].agent_secret);
  expect(copies.map(c=>c.software_result_id)).toEqual([resultId,resultId]);
  await databaseRejects(db`UPDATE portable_software_results SET provider_snapshot_name='changed' WHERE id=${resultId}`);
  await databaseRejects(db`DELETE FROM portable_software_result_grants WHERE result_id=${resultId}`);
  const unrelated=await user();
  const other=await createCompanion(unrelated.id,{name:'Unrelated',provider:'local'});
  await databaseRejects(db`UPDATE companions SET software_result_id=${resultId} WHERE id=${other.id}`);
});

test('delivery pins the selected specialist revision despite later edits and never copies its private snapshot',async()=>{
  const f=await fixture(),recipient=await user();setDeliveryMailerForTests(async()=>{});
  await allowTemplate(f.owner.id,f.companion.id,{templateId:f.template.id,maxChildren:2});
  const delivery=await createDelivery(f.owner.id,{clientDeliveryId:crypto.randomUUID(),companionId:f.companion.id,clientEmail:recipient.email,templateIds:[f.template.id],includeSkills:false});
  await saveTemplate(f.owner.id,{id:f.template.id,expectedRevision:2,name:'Later edit',instructions:'Changed'});
  const [target]=await db`SELECT source_build_id,source_template_revision FROM delivery_software_targets WHERE delivery_id=${delivery!.id} AND target_key=${f.template.id}`;
  expect(target.source_build_id).toBe(f.build.id);expect(target.source_template_revision).toBe(2);
  const resultId=await complete(f);const accepted=await acceptDelivery(recipient.id,delivery!.id,false);
  const [copy]=await db`SELECT t.* FROM agent_templates t JOIN template_permissions p ON p.template_id=t.id WHERE p.parent_id=${accepted!.companionId}`;
  expect(copy.name).toBe('Prepared coder');expect(copy.software_result_id).toBe(resultId);expect(copy.source_companion_id).toBeNull();expect(copy.software_build_id).toBeNull();expect(copy.snapshot_name).toBe(f.build.providerSnapshotName);
});

test('failed software never produces a ready invite or accepted client',async()=>{
  const f=await fixture(),recipient=await user();let sent=0;setDeliveryMailerForTests(async()=>{sent++;});
  const delivery=await createDelivery(f.owner.id,{clientDeliveryId:crypto.randomUUID(),companionId:f.companion.id,clientEmail:recipient.email,includeSkills:false});
  await db`UPDATE portable_software_builds SET status='failed',error_code='software_build_install_interrupted' WHERE id=${f.build.id}`;
  expect(await sendDeliveryReadyInvite(delivery!.id)).toBe('not_pending');expect(sent).toBe(0);
  await expect(acceptDelivery(recipient.id,delivery!.id,false)).rejects.toThrow('not ready');
  const [state]=await db`SELECT software_status,status FROM companion_deliveries WHERE id=${delivery!.id}`;
  expect(state).toMatchObject({software_status:'error',status:'pending'});
});
