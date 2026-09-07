import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portableSoftwareBuildRequestDigest } from "./software-build";
import { canonicalJson, softwareDistributionDescriptorPayload } from "./software-distribution";
import { runSoftwareBuilderCli } from "./software-builder-cli";
import { canonicalSoftwareManifest, softwareManifestDigest } from "../control/software";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))));

async function fixture(sourceState = false) {
  const root = await mkdtemp(join(tmpdir(), "software-cli-")); directories.push(root);
  const state = join(root, "state"), buildId = "790b5c48-cb73-44e2-978f-8feff575f9a8";
  await mkdir(join(state, buildId), { recursive: true });
  const executable = new TextEncoder().encode("compiled-builder"), keyring = new TextEncoder().encode("public-keyring");
  const config = { version: 1 as const, base: { id: "ubuntu-noble-v7", distro: { family: "ubuntu", suite: "noble", architecture: "amd64" } },
    aptRepository: { family: "ubuntu", snapshot: "20260901T000000Z", architecture: "amd64", keyringPath: "/operator/keyring.gpg",
      sources: [{ origin: "https://snapshot.ubuntu.com/ubuntu/20260901T000000Z", suite: "noble", components: ["main"], inReleaseSha256: "a".repeat(64) }] }, npmRegistry: "https://registry.npmjs.org" };
  const payload = softwareDistributionDescriptorPayload(config, keyring, executable);
  const descriptor = { ...payload, base: { ...payload.base, distributionDigest: "b".repeat(64) } };
  const paths = { descriptor: join(root, "descriptor.json"), keyring: join(root, "keyring.gpg"), executable: join(root, "builder"), state, export: join(root, "export"),
    forbidden: sourceState ? [join(root, "source-state")] : [join(root, "absent")] };
  await Promise.all([writeFile(paths.descriptor, `${canonicalJson(descriptor)}\n`, { mode: 0o600 }), writeFile(paths.keyring, keyring, { mode: 0o600 }),
    writeFile(paths.executable, executable, { mode: 0o700 }), writeFile(join(state, buildId, "request.json"), JSON.stringify({ version: 1, aptRoots: [], npmRoots: [{ name: "is-number", version: "7.0.0" }] }), { mode: 0o600 })]);
  if (sourceState) await writeFile(paths.forbidden[0]!, "must-not-read", { mode: 0o600 });
  const operator = { base: descriptor.base, aptRepository: { ...descriptor.aptRepository, keyring }, npmRegistry: descriptor.npmRegistry };
  const requestDigest = portableSoftwareBuildRequestDigest({ aptRoots: [], npmRoots: [{ name: "is-number", version: "7.0.0" }] }, operator);
  const manifest = { version: 1 as const, base: descriptor.base, apt: { roots: [], packages: [] }, npm: { roots: [], packages: [] } };
  await mkdir(join(state, buildId, "bundle"));
  await writeFile(join(state, buildId, "bundle", "manifest.json"), canonicalSoftwareManifest(manifest));
  return { paths, buildId, requestDigest, manifestDigest: softwareManifestDigest(manifest) };
}

describe("root software builder CLI", () => {
  test("uses fixed unit commands and reports ready only after verified sealed state", async () => {
    const value = await fixture(); const commands: string[][] = [], output: string[] = [];
    const run = (argv: string[]) => { commands.push(argv); return { exitCode: argv[1] === "is-active" ? 3 : 0, stderr: new Uint8Array() }; };
    const exit = await runSoftwareBuilderCli(["run", value.buildId, value.requestDigest], { paths: value.paths, getuid: () => 0, platform: "linux",
      trustedOwnerUid: process.getuid!(), environment: {}, run, output: text => output.push(text), build: async request => ({ version: 1 as const, buildId: request.buildId,
        requestDigest: request.requestDigest, phase: "verified" as const, manifestDigest: value.manifestDigest, errorCode: null, revision: 7,
        updatedAt: new Date().toISOString(), bundleDirectory: `${value.paths.state}/${value.buildId}/bundle` }) });
    expect(exit).toBe(0);
    expect(JSON.parse(output[0]!).readyForCapture).toBe(true);
    expect(commands[0]).toEqual(["/usr/bin/systemctl", "disable", "--now", "companions-agent-proxy.socket", "companions-agent-proxy.service", "companions-agent.service", "companions-desktop.service"]);
    expect(commands.some(argv => argv[1] === "start" || argv[1] === "unmask")).toBe(false);
    const statusOutput: string[] = [];
    await runSoftwareBuilderCli(["status", value.buildId, value.requestDigest], { paths: value.paths, getuid: () => 0, platform: "linux",
      trustedOwnerUid: process.getuid!(), environment: {}, output: text => statusOutput.push(text), observe: async () => ({ version: 1, buildId: value.buildId,
        requestDigest: value.requestDigest, phase: "verified", manifestDigest: value.manifestDigest, errorCode: null, revision: 7,
        updatedAt: new Date().toISOString(), bundleDirectory: `${value.paths.state}/${value.buildId}/bundle` }) });
    expect(JSON.parse(statusOutput[0]!).readyForCapture).toBe(true);
  });

  test("fails closed before installation when source runtime state exists", async () => {
    const value = await fixture(true); const output: string[] = []; let built = false;
    const exit = await runSoftwareBuilderCli(["run", value.buildId, value.requestDigest], { paths: value.paths, getuid: () => 0, platform: "linux",
      trustedOwnerUid: process.getuid!(), environment: {}, output: text => output.push(text), build: async () => { built = true; throw new Error("unexpected"); } });
    expect(exit).toBe(2); expect(built).toBe(false);
    expect(JSON.parse(output[0]!).errorCode).toBe("software_builder_source_state_present");
  });

  test("rejects a changed request digest before stopping product units", async () => {
    const value = await fixture(); const output: string[] = [], commands: string[][] = [];
    const exit = await runSoftwareBuilderCli(["run", value.buildId, "f".repeat(64)], { paths: value.paths, getuid: () => 0, platform: "linux",
      trustedOwnerUid: process.getuid!(), environment: {}, output: text => output.push(text),
      run: argv => { commands.push(argv); return { exitCode: 0, stderr: new Uint8Array() }; } });
    expect(exit).toBe(2); expect(commands).toEqual([]);
    expect(JSON.parse(output[0]!).errorCode).toBe("software_build_request_digest_mismatch");
  });

  test("status is observation-only and rejects a changed digest", async () => {
    const value = await fixture(); const output: string[] = [];
    const exit = await runSoftwareBuilderCli(["status", value.buildId, value.requestDigest], { paths: value.paths, getuid: () => 0, platform: "linux",
      trustedOwnerUid: process.getuid!(), environment: {}, output: text => output.push(text), observe: async () => ({ version: 1, buildId: value.buildId, requestDigest: "d".repeat(64),
        phase: "verified", manifestDigest: "c".repeat(64), errorCode: null, revision: 2, updatedAt: new Date().toISOString(), bundleDirectory: "/private" }) });
    expect(exit).toBe(0); expect(JSON.parse(output[0]!).errorCode).toBe("software_build_request_conflict");
  });
});

for (const stage of ["quiesce", "restore", "seal"] as const) {
  test(`a ${stage} wrapper failure survives restart and prevents another unit command or install`, async () => {
    const value=await fixture(), commands:string[][]=[], output:string[]=[];
    let installs=0;
    const verified={version:1 as const,buildId:value.buildId,requestDigest:value.requestDigest,phase:"verified" as const,
      manifestDigest:value.manifestDigest,errorCode:null,revision:7,updatedAt:new Date().toISOString(),bundleDirectory:`${value.paths.state}/${value.buildId}/bundle`};
    const deps={paths:value.paths,getuid:()=>0,platform:"linux" as const,trustedOwnerUid:process.getuid!(),environment:{},
      output:(text:string)=>output.push(text),
      run:(argv:string[])=>{
        commands.push(argv);
        return {exitCode:argv[1]==="is-active"?3:((stage==="quiesce"&&argv[1]==="disable")||(stage==="restore"&&argv[1]==="enable"))?1:0};
      },build:async()=>{
        installs++;
        if(stage==="seal")await mkdir(`${value.paths.state}/${value.buildId}/capture-seal.json`);
        return verified;
      },observe:async()=>stage==="quiesce"?null:verified};
    expect(await runSoftwareBuilderCli(["run",value.buildId,value.requestDigest],deps)).toBe(2);
    const failure=JSON.parse(output.pop()!);
    expect(failure).toMatchObject({phase:"failed",readyForCapture:false});
    const stored=JSON.parse(await readFile(`${value.paths.state}/${value.buildId}/cli-failure.json`,"utf8"));
    expect(stored).toEqual({version:1,requestDigest:value.requestDigest,errorCode:failure.errorCode});
    const before={commands:commands.length,installs};
    expect(await runSoftwareBuilderCli(["status",value.buildId,value.requestDigest],deps)).toBe(0);
    expect(JSON.parse(output.pop()!)).toEqual(failure);
    expect(await runSoftwareBuilderCli(["run",value.buildId,value.requestDigest],deps)).toBe(2);
    expect(JSON.parse(output.pop()!)).toEqual(failure);
    expect({commands:commands.length,installs}).toEqual(before);
  });
}

test("pre-journal descriptor rejection is durable without copying its contents into status",async()=>{
  const value=await fixture(),output:string[]=[];let effects=0;
  await writeFile(value.paths.executable,"changed-builder");
  const deps={paths:value.paths,getuid:()=>0,platform:"linux" as const,trustedOwnerUid:process.getuid!(),environment:{},
    output:(text:string)=>output.push(text),run:()=>{effects++;return {exitCode:0};}};
  expect(await runSoftwareBuilderCli(["run",value.buildId,value.requestDigest],deps)).toBe(2);
  await writeFile(value.paths.executable,"compiled-builder");
  expect(await runSoftwareBuilderCli(["status",value.buildId,value.requestDigest],deps)).toBe(0);
  expect(JSON.parse(output.pop()!)).toMatchObject({phase:"failed",errorCode:"software_builder_identity_mismatch"});
  expect(effects).toBe(0);
});

test("busy invocation is not persisted as a terminal wrapper failure",async()=>{
  const value=await fixture(),output:string[]=[];
  const deps={paths:value.paths,getuid:()=>0,platform:"linux" as const,trustedOwnerUid:process.getuid!(),environment:{},
    output:(text:string)=>output.push(text),run:(argv:string[])=>({exitCode:argv[1]==="is-active"?3:0}),
    build:async()=>{throw Error("software_build_busy");},observe:async()=>null};
  expect(await runSoftwareBuilderCli(["run",value.buildId,value.requestDigest],deps)).toBe(2);
  expect(await Bun.file(`${value.paths.state}/${value.buildId}/cli-failure.json`).exists()).toBe(false);
  expect(await runSoftwareBuilderCli(["status",value.buildId,value.requestDigest],deps)).toBe(0);
  expect(JSON.parse(output.pop()!)).toBeNull();
});

test("status validation failures use a failed exit-zero projection and never persist an outcome",async()=>{
  const value=await fixture(),output:string[]=[];
  await writeFile(value.paths.executable,"invalid-builder");
  const exit=await runSoftwareBuilderCli(["status",value.buildId,value.requestDigest],{paths:value.paths,getuid:()=>0,platform:"linux",
    trustedOwnerUid:process.getuid!(),environment:{},output:text=>output.push(text)});
  expect(exit).toBe(0);expect(JSON.parse(output[0]!)).toMatchObject({phase:"failed",errorCode:"software_builder_identity_mismatch"});
  expect(await Bun.file(`${value.paths.state}/${value.buildId}/cli-failure.json`).exists()).toBe(false);
});
