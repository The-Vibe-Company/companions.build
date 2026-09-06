/** Optional live canary for portable Pi skills on the existing v2 Box Companion. */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { config, decrypt } from "../apps/server/src/config";
import { fetchAgent } from "../packages/box/transport";
import { agentRequest } from "../apps/server/src/machines";
import { db } from "../apps/server/src/store";

if (!config.boxKey || !config.boxTemplate || config.testMode) throw Error("Configure the live Box stack and real model before running this canary.");
const sourceFile=Bun.file(process.env.BOX_CANARY_STATE_FILE??".local/box-canary-v2.json");
if(!await sourceFile.exists())throw Error("Run the v2 Box canary before the portable-skills canary.");
const source=z.object({companionId:z.string().uuid()}).parse(await sourceFile.json());
const sessionFile=Bun.file(".local/session-cookie");
if(!await sessionFile.exists())throw Error("Run python3 scripts/dev-session.py before the authenticated live canary.");
const cookie=(await sessionFile.text()).trim();
const apiBase=`http://127.0.0.1:${process.env.API_PORT??Number(process.env.WEB_PORT??4310)+1}/api`;
const journalPath=process.env.SKILLS_CANARY_STATE_FILE??".local/live-skills-canary.json";
const journalFile=Bun.file(journalPath);
const stateSchema=z.object({version:z.literal(1),companionId:z.string().uuid(),skillName:z.string(),marker:z.string(),messageId:z.string().uuid(),runId:z.string().uuid().optional(),passedAt:z.string().optional()});
const state=await journalFile.exists()?stateSchema.parse(await journalFile.json()):{
 version:1 as const,companionId:source.companionId,skillName:`live-skills-${crypto.randomUUID().replaceAll("-","").slice(0,16)}`,
 marker:`SKILLS_CANARY_${crypto.randomUUID().replaceAll("-","").slice(0,20).toUpperCase()}`,messageId:crypto.randomUUID(),
};
if(state.companionId!==source.companionId)throw Error("The skills canary journal belongs to a different Companion.");
function save(){mkdirSync(dirname(journalPath),{recursive:true,mode:0o700});const temporary=`${journalPath}.tmp`;writeFileSync(temporary,JSON.stringify(state,null,2),{mode:0o600});renameSync(temporary,journalPath);chmodSync(journalPath,0o600);}
save();

async function api(path:string,body?:unknown){
 const response=await fetch(`${apiBase}${path}`,{method:body===undefined?"GET":"POST",headers:{cookie,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});
 if(!response.ok)throw Error(`SKILLS_CANARY_API_${response.status}`);return response.json() as Promise<any>;
}
async function until<T>(label:string,read:()=>Promise<T|null>,timeout=240_000){const deadline=Date.now()+timeout;for(;;){const value=await read();if(value!==null)return value;if(Date.now()>deadline)throw Error(`${label}_TIMEOUT`);await Bun.sleep(500);}}
const fileSchema=z.object({path:z.string().min(1),data:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
const manifestSchema=z.object({version:z.literal(1),skills:z.array(z.object({name:z.string(),files:z.array(fileSchema).min(1)}))});
function sha(bytes:Uint8Array|string){return createHash("sha256").update(bytes).digest("hex");}
function validateManifest(value:unknown){
 const manifest=manifestSchema.parse(value);
 for(const skill of manifest.skills)for(const file of skill.files){const bytes=Buffer.from(file.data,"base64");if(bytes.toString("base64")!==file.data||sha(bytes)!==file.sha256)throw Error("SKILLS_CANARY_EXPORT_HASH_MISMATCH");}
 return manifest;
}

try{
 const detail=await api(`/companions/${state.companionId}`);
 // The authenticated projection above proves access before the canary reads the encrypted transport reference.
 async function transport(){const [row]=await db`SELECT endpoint_secret,agent_secret FROM companions WHERE id=${state.companionId} AND retired_at IS NULL`;if(!row?.endpoint_secret||!row.agent_secret)return null;const endpoint=decrypt(row.endpoint_secret),token=decrypt(row.agent_secret);try{if((await agentRequest(endpoint,token,"/health"))?.ready)return {endpoint,token};}catch{}return null;}
 let agent=detail.companion.status==="ready"?await transport():null;
 if(!agent){await api(`/companions/${state.companionId}/prepare`,{});agent=await until("SKILLS_CANARY_PREPARE",transport);}
 const {endpoint,token}=agent;
 validateManifest(await agentRequest(endpoint,token,"/skills/export"));

 const skillText=`---\nname: ${state.skillName}\ndescription: Live portable-skill canary; use only when explicitly requested.\n---\nRead fixture/marker.txt in this skill directory with a file tool. Reply with exactly its contents and nothing else.\n`;
 const fixtureText=`${state.marker}\n`;
 const manifest={version:1 as const,skills:[{name:state.skillName,files:[
  {path:"SKILL.md",data:Buffer.from(skillText).toString("base64"),sha256:sha(skillText)},
  {path:"fixture/marker.txt",data:Buffer.from(fixtureText).toString("base64"),sha256:sha(fixtureText)},
 ]}]};
 const rejectedFile=JSON.stringify({fixture:"not-a-real-credential"});
 const rejected=await fetchAgent(endpoint,token,"/skills/import","PUT",{version:1,skills:[{name:`${state.skillName}-rejected`,files:[manifest.skills[0].files[0],{path:"credentials.json",data:Buffer.from(rejectedFile).toString("base64"),sha256:sha(rejectedFile)}]}]});
 const refusal=await rejected.json() as any;
 if(rejected.status!==400||!["UNSAFE_SKILL_PATH","SKILL_CREDENTIAL_RISK"].includes(refusal.error))throw Error("SKILLS_CANARY_CREDENTIAL_GUARD_FAILED");
 const first=z.object({bundleHash:z.string().regex(/^[a-f0-9]{64}$/),imported:z.array(z.string()),unchanged:z.array(z.string())}).parse(await agentRequest(endpoint,token,"/skills/import","PUT",manifest));
 const second=z.object({bundleHash:z.string().regex(/^[a-f0-9]{64}$/),imported:z.array(z.string()),unchanged:z.array(z.string())}).parse(await agentRequest(endpoint,token,"/skills/import","PUT",manifest));
 if(first.bundleHash!==second.bundleHash||!second.unchanged.includes(state.skillName))throw Error("SKILLS_CANARY_IMPORT_NOT_IDEMPOTENT");
 const exported=validateManifest(await agentRequest(endpoint,token,`/skills/export?name=${encodeURIComponent(state.skillName)}`));
 const skill=exported.skills.find(item=>item.name===state.skillName),expected=new Map(manifest.skills[0].files.map(file=>[file.path,file.sha256]));
 if(!skill||skill.files.length!==expected.size||skill.files.some(file=>expected.get(file.path)!==file.sha256))throw Error("SKILLS_CANARY_EXPORTED_FILES_MISMATCH");
 const listing=z.object({skills:z.array(z.object({name:z.string(),description:z.string()}))}).parse(await agentRequest(endpoint,token,"/skills"));
 if(!listing.skills.some(item=>item.name===state.skillName&&item.description.includes("Live portable-skill canary")))throw Error("SKILLS_CANARY_LIST_MISMATCH");

 const prompt=`Use the installed skill named ${state.skillName}. Follow its instructions and reply with only the marker stored in its fixture file.`;
 if(!state.runId){const accepted=await api(`/companions/${state.companionId}/messages`,{clientMessageId:state.messageId,content:prompt});state.runId=z.string().uuid().parse(accepted.runId);save();}
 const result=await until("SKILLS_CANARY_RUN",async()=>{
  const value=await api(`/companions/${state.companionId}`),run=value.runs.find((item:any)=>item.id===state.runId);
  if(["failed","interrupted","cancelled"].includes(run?.status))throw Error(`SKILLS_CANARY_RUN_${String(run.status).toUpperCase()}`);
  if(run?.status!=="succeeded")return null;
  const reply=value.messages.find((item:any)=>item.runId===state.runId&&item.role==="assistant");if(reply?.content?.trim()!==state.marker)throw Error("SKILLS_CANARY_REPLY_MISMATCH");return reply;
 });
 if(!result)throw Error("SKILLS_CANARY_REPLY_MISMATCH");
 const [current]=await db`SELECT endpoint_secret,agent_secret FROM companions WHERE id=${state.companionId} AND retired_at IS NULL`;
 if(!current?.endpoint_secret)throw Error("SKILLS_CANARY_JOURNAL_UNAVAILABLE");
 const daemonRun=await agentRequest(decrypt(current.endpoint_secret),decrypt(current.agent_secret),`/runs/${state.runId}`);
 if(daemonRun?.status!=="succeeded"||daemonRun.text?.trim()!==state.marker)throw Error("SKILLS_CANARY_JOURNAL_MISMATCH");
 state.passedAt=new Date().toISOString();save();
 console.log(JSON.stringify({status:"passed",companionId:state.companionId,skill:state.skillName,idempotent:true,exported:true,listed:true,piReadFixture:true,journalVerified:true,credentialFileRejected:true}));
}finally{await db.close();}
