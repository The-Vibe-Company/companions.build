import { BoxClient } from "../packages/box/client";
import { config } from "../apps/server/src/config";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {open} from "node:fs/promises";
import {distributionManifest,manifestDigest,publishDistribution,saveDistributionJournal,validateDistributionJournal} from "./lib/distribution-verification";
import { softwareDistributionDescriptorSchema } from "../packages/box/software-distribution";
import {templateInstallScript} from "./lib/template-install";
import {requirePinnedBun} from "./lib/pinned-bun";

requirePinnedBun();

if (!config.boxKey) throw new Error("Configure BOX_API_KEY in .env before preparing the template.");
const args = process.argv.slice(2);
const name = args[0] ?? "companions-agent-v0";
if (!/^[a-z0-9-]{1,60}$/.test(name)) throw new Error("Template name must contain lowercase letters, digits and hyphens.");
let softwareConfig: string | undefined;
if (args.length > 1) {
  if (args.length !== 3 || args[1] !== "--software-config" || !args[2] || resolve(args[2]) !== args[2]) throw new Error("Usage: prepare-box-template.ts [name] [--software-config /absolute/operator-config.json]");
  softwareConfig = args[2];
}
const box = new BoxClient(config.boxKey);
mkdirSync(".local/distributions", { recursive: true, mode: 0o700 });
const journalPath=`.local/template-${name}.json`,journal=Bun.file(journalPath);
let state:any=await journal.exists()?await journal.json():{version:1,name,key:crypto.randomUUID(),startedAt:new Date().toISOString()};
if(state.version!==1)throw Error("DISTRIBUTION_LEGACY_JOURNAL_UNVERIFIED: use a new immutable name and fresh build Box; existing captures are not rebuilt.");
if(state.name!==name)throw Error("DISTRIBUTION_JOURNAL_NAME_MISMATCH");
await saveDistributionJournal(journalPath,state);
// Pin one build before any upload or Box creation. An interrupted attempt continues
// that exact archive, even if a later local build changes dist/agent.
if(!state.manifest){
 if(state.boxId||state.snapshotRequestedAt||state.completedAt)throw Error("DISTRIBUTION_LEGACY_JOURNAL_UNVERIFIED");
 const build=Bun.spawn([process.execPath,"scripts/build-agent.ts",...(softwareConfig?["--software-config",softwareConfig]:[])],{stdout:"inherit",stderr:"inherit"});
 if(await build.exited)throw Error("Agent build failed");
 const directory=realpathSync("dist/agent");
 const manifest=await distributionManifest(directory);
 if(softwareConfig){
  const descriptorBytes=Buffer.from(await Bun.file(`${directory}/software-builder.json`).arrayBuffer());
  const descriptor=softwareDistributionDescriptorSchema.parse(JSON.parse(descriptorBytes.toString("utf8")));
  state.software={baseId:descriptor.base.id,distributionDigest:descriptor.base.distributionDigest,resolverConfigDigest:descriptor.resolverConfigDigest,descriptorSha256:createHash("sha256").update(descriptorBytes).digest("hex")};
 }
 const tar=Bun.spawn(["tar","-czf",".local/agent.tar.gz","-C",directory,"."],{stdout:"inherit",stderr:"inherit"});
 if(await tar.exited)throw Error("Archive creation failed");
 // A concurrent operator modifying this release cannot silently change the pinned manifest.
 if(manifestDigest(await distributionManifest(directory))!==manifestDigest(manifest))throw Error("DISTRIBUTION_LOCAL_CONTENT_CHANGED");
 const archive=Buffer.from(await Bun.file(".local/agent.tar.gz").arrayBuffer()),digest=createHash("sha256").update(archive).digest("hex");
 const immutableArchive=`.local/distributions/${digest}.tar.gz`;
 if(await Bun.file(immutableArchive).exists()){
  if(createHash("sha256").update(new Uint8Array(await Bun.file(immutableArchive).arrayBuffer())).digest("hex")!==digest)throw Error("DISTRIBUTION_ARCHIVE_MISMATCH");
 }else{
  const file=await open(immutableArchive,"wx",0o600);try{await file.writeFile(archive);await file.sync();}finally{await file.close();}
 }
 state.manifest=manifest;state.manifestDigest=manifestDigest(manifest);state.sha256=digest;
 await saveDistributionJournal(journalPath,state);
}
validateDistributionJournal(state);
await publishDistribution(state,{
 box,save:value=>saveDistributionJournal(journalPath,value),
 async install(id){
  const archive=Buffer.from(await Bun.file(`.local/distributions/${state.sha256}.tar.gz`).arrayBuffer());
  if(createHash("sha256").update(archive).digest("hex")!==state.sha256)throw Error("DISTRIBUTION_ARCHIVE_MISMATCH");
  const directory=`/tmp/companions-${state.sha256.slice(0,16)}`;
  await box.command(id,`mkdir -p ${directory}`);
  for(let start=0,index=0;start<archive.length;start+=3*1024*1024,index++)await box.writeFile(id,`${directory}/part-${String(index).padStart(5,"0")}`,archive.subarray(start,start+3*1024*1024).toString("base64"),"base64");
  await box.command(id,`cat ${directory}/part-* > ${directory}/agent.tar.gz`,60);
  await box.command(id,templateInstallScript(directory,state.sha256),60);
  await box.command(id,`rm -rf -- ${directory}`);
 },
});
console.log(`Template content verified on independent Box ${state.verification!.boxId}. Set BOX_TEMPLATE=${name}. Build and verification Boxes archived.`);
