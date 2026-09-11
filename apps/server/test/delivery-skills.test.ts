import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSkills } from "../../../packages/control/skills";
import { createCompanion, db, migrate } from "../src/store";
import { migrateBilling } from "../src/billing";
import { acceptDelivery, createDelivery, migrateDelivery, sendDeliveryReadyInvite, setDeliveryMailerForTests } from "../src/delivery";
import { migrateLifecycle } from "../src/lifecycle";
import { migrateDeliverySkills, progressDeliverySkills, progressDeliverySkillsForCompanion, stageDeliverySkills } from "../src/delivery-skills";
import { encrypt } from "../src/config";
import { createObjectStorage } from "../src/storage";
import { acquireExecutor } from "../src/executor";

class MemoryStorage {
  objects=new Map<string,Blob>();
  puts=0;
  async put(key:string,bytes:Uint8Array,type:string){this.puts++;this.objects.set(key,new Blob([bytes.slice().buffer as ArrayBuffer],{type}));}
  async get(key:string){const value=this.objects.get(key);if(!value)throw Error("missing");return value;}
  async delete(key:string){this.objects.delete(key);}
}
const directories:string[]=[];
let executor:any;
beforeAll(async()=>{await migrate();await migrateBilling();await migrateLifecycle();await migrateDelivery();await migrateDeliverySkills();executor=await acquireExecutor();if(!executor)throw Error("executor lock unavailable");});
afterAll(async()=>{if(executor){await executor`SELECT pg_advisory_unlock(721440139)`;executor.release();}});
afterEach(()=>{setDeliveryMailerForTests(null);process.env.BILLING_TEST_MODE="1";while(directories.length)rmSync(directories.pop()!,{recursive:true,force:true});});
async function user(){const id=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${id},'User',${`${id}@example.test`},true)`;return id;}
function skills(name:string,content:string){const state=mkdtempSync(join(tmpdir(),"delivery-skills-"));directories.push(state);const root=join(state,"pi","skills",name);mkdirSync(root,{recursive:true});writeFileSync(join(root,"SKILL.md"),`---\nname: ${name}\ndescription: Portable ${name}\n---\n${content}`);return {state,handler:new AgentSkills(state)};}
async function call(handler:AgentSkills,path:string,method="GET",body?:unknown){const response=await handler.handleRequest(new Request(`http://agent${path}`,{method,...(body===undefined?{}:{body:JSON.stringify(body)})}));if(!response?.ok)throw Error(`agent ${response?.status}`);return response.json();}
function manifestFile(path:string,value:string){const bytes=Buffer.from(value);return {path,data:bytes.toString("base64"),sha256:createHash("sha256").update(bytes).digest("hex")};}

test("a ready immutable S3 bundle is imported once into the independent client companion",async()=>{
 process.env.BILLING_TEST_MODE="1";const sender=await user(),recipient=await user();
 const source=await createCompanion(sender,{name:"Studio",instructions:"Work",provider:"local"});
 const main=skills("writer","main bytes"),receivedMain=skills("placeholder","remove me");
 rmSync(join(receivedMain.state,"pi","skills","placeholder"),{recursive:true});
 await db`UPDATE companions SET status='ready',prepare_requested=false,endpoint_secret=${encrypt("main")},agent_secret=${encrypt("token")} WHERE id=${source.id}`;
 const storage=process.env.RUN_STORAGE_ACCEPTANCE==="1"?createObjectStorage():new MemoryStorage();let mails=0;setDeliveryMailerForTests(async()=>{mails++;});
 const delivery=await createDelivery(sender,{clientDeliveryId:crypto.randomUUID(),companionId:source.id,clientEmail:`${recipient}@example.test`});
 expect(delivery?.skillsStatus).toBe("pending");expect(mails).toBe(0);
 await expect(acceptDelivery(recipient,delivery!.id,false)).rejects.toThrow("still being prepared");
 const requestAgent=async(endpoint:string,_token:string,path:string,method?:string,body?:unknown)=>call(main.handler,path,method,body);
 await progressDeliverySkillsForCompanion(executor,source.id,"main","token",{storage,requestAgent,notifyReady:sendDeliveryReadyInvite});
 expect(mails).toBe(1);expect((await db`SELECT skills_status FROM companion_deliveries WHERE id=${delivery!.id}`)[0].skills_status).toBe("ready");
 const accepted=await acceptDelivery(recipient,delivery!.id,false);const parentId=accepted!.companionId;
 let imports=0;const importMain=async(_e:string,_t:string,path:string,method?:string,body?:unknown)=>{imports++;return call(receivedMain.handler,path,method,body);};
 expect(await stageDeliverySkills(parentId,"recipient","token",{storage,requestAgent:importMain})).toMatchObject({staged:true});
 expect(await stageDeliverySkills(parentId,"recipient","token",{storage,requestAgent:importMain})).toMatchObject({staged:false});expect(imports).toBe(1);
 expect(readFileSync(join(receivedMain.state,"pi","skills","writer","SKILL.md"),"utf8")).toContain("main bytes");
});

test("revoked deliveries, crafted secret manifests, and cross-owner jobs fail closed before storage",async()=>{
 process.env.BILLING_TEST_MODE="1";const sender=await user(),recipient=await user(),other=await user();const source=await createCompanion(sender,{name:"Safe",instructions:"",provider:"local"});
 await db`UPDATE companions SET status='ready',prepare_requested=false,endpoint_secret=${encrypt("source")},agent_secret=${encrypt("token")} WHERE id=${source.id}`;
 expect(await createDelivery(other,{clientDeliveryId:crypto.randomUUID(),companionId:source.id,clientEmail:`${recipient}@example.test`})).toBeNull();
 const storage=new MemoryStorage(),mail:string[]=[];setDeliveryMailerForTests(async value=>{mail.push(value.to);});
 const revoked=await createDelivery(sender,{clientDeliveryId:crypto.randomUUID(),companionId:source.id,clientEmail:`${recipient}@example.test`});
 await db`UPDATE companion_deliveries SET status='revoked' WHERE id=${revoked!.id}`;
 let calls=0;await progressDeliverySkills(executor,{storage,requestAgent:async()=>{calls++;return {version:1,skills:[]}},notifyReady:async()=>{}});expect(calls).toBe(0);
 const invalid=await createDelivery(sender,{clientDeliveryId:crypto.randomUUID(),companionId:source.id,clientEmail:`${recipient}@example.test`});
 await progressDeliverySkillsForCompanion(executor,source.id,"source","token",{storage,requestAgent:async()=>({version:1,skills:[{name:"bad",files:[{path:"SKILL.md",data:"eA==",sha256:"0".repeat(64)}]}]}),notifyReady:async()=>{}});
 expect((await db`SELECT skills_status FROM companion_deliveries WHERE id=${invalid!.id}`)[0].skills_status).toBe("error");await expect(acceptDelivery(recipient,invalid!.id,false)).rejects.toThrow("could not be prepared");
 const secret=await createDelivery(sender,{clientDeliveryId:crypto.randomUUID(),companionId:source.id,clientEmail:`${recipient}@example.test`}),writes=storage.puts;
 await progressDeliverySkillsForCompanion(executor,source.id,"source","token",{storage,requestAgent:async()=>({version:1,skills:[{name:"leaky",files:[manifestFile("SKILL.md","---\ndescription: Leaky\n---\n"),manifestFile("references/setup.md","-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----")]}]}),notifyReady:async()=>{}});
 expect(storage.puts).toBe(writes);expect((await db`SELECT skills_status FROM companion_deliveries WHERE id=${secret!.id}`)[0].skills_status).toBe("error");
 const [forgedJob]=await db`UPDATE portable_skill_exports SET source_owner_id=${other},status='pending' WHERE delivery_id=${secret!.id} RETURNING id`;const forged=forgedJob.id;
 await progressDeliverySkills(executor,{storage,requestAgent:async()=>{throw Error("must not contact agent")}});expect(storage.puts).toBe(writes);expect((await db`SELECT status FROM portable_skill_exports WHERE id=${forged}`)[0].status).toBe("error");
 const empty=await createDelivery(sender,{clientDeliveryId:crypto.randomUUID(),companionId:source.id,clientEmail:`${recipient}@example.test`});
 await progressDeliverySkillsForCompanion(executor,source.id,"source","token",{storage,requestAgent:async()=>({version:1,skills:[]}),notifyReady:sendDeliveryReadyInvite});
 expect((await db`SELECT skills_status FROM companion_deliveries WHERE id=${empty!.id}`)[0].skills_status).toBe("ready");expect(mail).toEqual([`${recipient}@example.test`]);
});

test("an ambiguous ready-email attempt does not turn a completed skill export into an error",async()=>{
 process.env.BILLING_TEST_MODE="1";const sender=await user(),recipient=await user();
 const source=await createCompanion(sender,{name:"Mail uncertain",instructions:"",provider:"local"});
 await db`UPDATE companions SET status='ready',prepare_requested=false,endpoint_secret=${encrypt("source")},agent_secret=${encrypt("token")} WHERE id=${source.id}`;
 const delivery=await createDelivery(sender,{clientDeliveryId:crypto.randomUUID(),companionId:source.id,clientEmail:`${recipient}@example.test`});
 setDeliveryMailerForTests(async()=>{throw new Error("ambiguous SMTP result");});
 await progressDeliverySkillsForCompanion(executor,source.id,"source","token",{storage:new MemoryStorage(),requestAgent:async()=>({version:1,skills:[]}),notifyReady:sendDeliveryReadyInvite});
 expect((await db`SELECT skills_status,email_status FROM companion_deliveries WHERE id=${delivery!.id}`)[0]).toEqual({skills_status:"ready",email_status:"unknown"});
 expect(await acceptDelivery(recipient,delivery!.id,false)).toMatchObject({accepted:true});
});
