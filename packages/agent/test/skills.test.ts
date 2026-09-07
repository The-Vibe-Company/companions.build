import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSkills, type SkillManifest } from "../../control/skills";
import {AgentControl} from "../../control/agent";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function state() { const path = mkdtempSync(join(tmpdir(), "companion-skills-")); roots.push(path); return path; }
function putSkill(root: string, name: string, files: Record<string, string>) {
  const directory = join(root, name);
  for (const [path, value] of Object.entries(files)) {
    const target = join(directory, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, value);
  }
}
function file(path: string, value: string) {
  const bytes = Buffer.from(value);
  return { path, data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}
function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://agent${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
}

test("discovers Pi-compatible skill roots and exports a bounded selectable manifest", async () => {
  const directory = state();
  putSkill(join(directory, "pi", "skills"), "writer", { "SKILL.md": "---\nname: writer\ndescription: Write clear release notes.\n---\n", "references/style.md": "Be direct." });
  putSkill(join(directory, "workspace", ".pi", "skills"), "reviewer", { "SKILL.md": "---\nname: reviewer\ndescription: >\n  Review changes\n  carefully.\n---\n" });
  const skills = new AgentSkills(directory);

  expect(await (await skills.handleRequest(request("/skills")))!.json()).toEqual({ skills: [
    { name: "reviewer", description: "Review changes carefully." },
    { name: "writer", description: "Write clear release notes." },
  ] });
  const manifest = await (await skills.handleRequest(request("/skills/export?name=writer")))!.json() as SkillManifest;
  expect(manifest.version).toBe(1);
  expect(manifest.skills.map(skill => skill.name)).toEqual(["writer"]);
  expect(manifest.skills[0].files.map(item => item.path)).toEqual(["references/style.md", "SKILL.md"]);
  for (const item of manifest.skills[0].files) expect(createHash("sha256").update(Buffer.from(item.data, "base64")).digest("hex")).toBe(item.sha256);
  expect((await skills.handleRequest(request("/skills/export?name=missing")))!.status).toBe(404);
});

test("export rejects symlinks, devices, and credential files inside a skill package", async () => {
  const directory = state(); const root = join(directory, "pi", "skills");
  putSkill(root, "unsafe", { "SKILL.md": "---\ndescription: Unsafe\n---\n", "notes.txt": "safe" });
  const skills = new AgentSkills(directory);
  symlinkSync("notes.txt", join(root, "unsafe", "alias.txt"));
  expect((await skills.handleRequest(request("/skills/export?name=unsafe")))!.status).toBe(400);
  rmSync(join(root, "unsafe", "alias.txt"));
  writeFileSync(join(root, "unsafe", ".env"), "TOKEN=secret");
  expect((await skills.handleRequest(request("/skills/export?name=unsafe")))!.status).toBe(400);
  rmSync(join(root, "unsafe", ".env"));
  for (const [path, contents] of [
    ["credentials.json", '{"access_token":"private"}'], [".npmrc", "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz123456"],
    [".netrc", "machine example.test login user password private"], [".pypirc", "password=private"], [".ssh/id_rsa", "private"], ["token.txt", "private"],
  ]) {
    const target=join(root,"unsafe",path);mkdirSync(join(target,".."),{recursive:true});writeFileSync(target,contents);
    expect((await skills.handleRequest(request("/skills/export?name=unsafe")))!.status).toBe(400);rmSync(target);if(path.includes("/"))rmSync(join(target,".."),{recursive:true});
  }
  writeFileSync(join(root,"unsafe","notes.txt"),"-----BEGIN OPENSSH PRIVATE KEY-----\nobvious-secret\n-----END OPENSSH PRIVATE KEY-----");
  expect((await skills.handleRequest(request("/skills/export?name=unsafe")))!.status).toBe(400);
  writeFileSync(join(root,"unsafe","notes.txt"),"safe");
  const fifo = Bun.spawnSync(["mkfifo", join(root, "unsafe", "pipe")]);
  expect(fifo.exitCode).toBe(0);
  expect((await skills.handleRequest(request("/skills/export?name=unsafe")))!.status).toBe(400);
});

test("import validates the complete bundle before writing any skill", async () => {
  const directory = state(); const skills = new AgentSkills(directory);
  const valid = { name: "valid", files: [file("SKILL.md", "---\ndescription: Valid\n---\n")] };
  for (const invalid of [
    { name: "escape", files: [file("SKILL.md", "ok"), file("../outside", "bad")] },
    { name: "absolute", files: [file("SKILL.md", "ok"), file("C:/outside", "bad")] },
    { name: "credentials", files: [file("SKILL.md", "ok"), file("keys/provider", "bad")] },
    { name: "npm-token", files: [file("SKILL.md", "ok"), file("references/.npmrc", "bad")] },
    { name: "private-key", files: [file("SKILL.md", "ok"), file("references/setup.md", "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----")] },
    { name: "plaintext-token", files: [file("SKILL.md", "ok"), file("references/setup.md", "access_token=Abcd1234Efgh5678Ijkl9012Mnop3456")] },
    { name: "provider-token", files: [file("SKILL.md", "ok"), file("references/setup.md", `ghp_${"A1b2".repeat(10)}`)] },
    { name: "marker", files: [file("SKILL.md", "ok"), file(".companions-skill-import.json", "bad")] },
    { name: "broken", files: [{ ...file("SKILL.md", "ok"), sha256: "0".repeat(64) }] },
  ]) {
    const response = await skills.handleRequest(request("/skills/import", "PUT", { version: 1, skills: [valid, invalid] }));
    expect(response!.status).toBe(400);
    expect(existsSync(join(directory, "pi", "skills", "valid"))).toBe(false);
  }
  const tooMany = Array.from({ length: 501 }, (_, index) => file(index ? `file-${index}.txt` : "SKILL.md", "x"));
  expect((await skills.handleRequest(request("/skills/import", "PUT", { version: 1, skills: [{ name: "large", files: tooMany }] })))!.status).toBe(413);
  expect(existsSync(join(directory, "pi", "skills", "large"))).toBe(false);
});

test("import is idempotent, atomically updates imported names, and preserves unrelated skills", async () => {
  const directory = state(); const root = join(directory, "pi", "skills"); const skills = new AgentSkills(directory);
  const scriptMarker = join(directory, "script-ran");
  const first = { version: 1 as const, skills: [{ name: "portable", files: [
    file("SKILL.md", "---\ndescription: Portable\n---\nVersion one"),
    file("package.json", JSON.stringify({ scripts: { postinstall: `touch ${scriptMarker}` } })),
    file("old.txt", "old"),
  ] }] };
  const imported = await (await skills.handleRequest(request("/skills/import", "PUT", first)))!.json() as any;
  expect(imported.imported).toEqual(["portable"]); expect(imported.unchanged).toEqual([]);
  expect(existsSync(scriptMarker)).toBe(false);
  const retried = await (await skills.handleRequest(request("/skills/import", "PUT", first)))!.json() as any;
  expect(retried.bundleHash).toBe(imported.bundleHash); expect(retried).toMatchObject({ imported: [], unchanged: ["portable"] });

  const changed = { version: 1 as const, skills: [{ name: "portable", files: [file("SKILL.md", "---\ndescription: Portable\n---\nVersion two")] }] };
  expect(await (await skills.handleRequest(request("/skills/import", "PUT", changed)))!.json()).toMatchObject({ imported: ["portable"], unchanged: [] });
  expect(readFileSync(join(root, "portable", "SKILL.md"), "utf8")).toContain("Version two");
  expect(existsSync(join(root, "portable", "old.txt"))).toBe(false);

  putSkill(root, "existing", { "SKILL.md": "Unrelated local package" });
  const collision = { version: 1 as const, skills: [{ name: "existing", files: [file("SKILL.md", "Replacement") ] }] };
  expect((await skills.handleRequest(request("/skills/import", "PUT", collision)))!.status).toBe(409);
  expect(readFileSync(join(root, "existing", "SKILL.md"), "utf8")).toBe("Unrelated local package");
});

test("control operations install, CAS-update, list and idempotently remove a local Pi skill",async()=>{
  const directory=state(),skills=new AgentSkills(directory);let control=new AgentControl(directory,skills);const runId=crypto.randomUUID();
  const first={name:"writer",files:[file("SKILL.md","---\ndescription: Writes clearly.\n---\nVersion one"),file("references/style.md","Direct.")]};
  const install={clientOperationId:crypto.randomUUID(),skill:first};
  try{
    expect(await control.call(runId,"skill_install",install)).toMatchObject({imported:["writer"],unchanged:[]});
    expect(await control.call(runId,"skill_install",install)).toMatchObject({imported:["writer"],unchanged:[]});
    const listed=await control.call(runId,"skills",{}) as any,hash=listed.skills[0].hash;
    expect(listed).toEqual({skills:[{name:"writer",description:"Writes clearly.",hash,editable:true}]});

    const changed={name:"writer",files:[file("SKILL.md","---\ndescription: Writes clearly.\n---\nVersion two")]};
    expect(await control.call(runId,"skill_update",{clientOperationId:crypto.randomUUID(),expectedHash:"0".repeat(64),skill:changed})).toEqual({error:"SKILL_NAME_CONFLICT"});
    expect(readFileSync(join(directory,"pi","skills","writer","SKILL.md"),"utf8")).toContain("Version one");
    expect(await control.call(runId,"skill_update",{clientOperationId:crypto.randomUUID(),expectedHash:hash,skill:changed})).toMatchObject({imported:["writer"]});
    const updated=(await control.call(runId,"skills",{}) as any).skills[0].hash;

    const remove={clientOperationId:crypto.randomUUID(),name:"writer",expectedHash:updated};
    expect(await control.call(runId,"skill_remove",remove)).toEqual({removed:true,unchanged:false});
    expect((await control.call(runId,"skills",{}) as any).skills).toEqual([]);
    expect(await control.call(runId,"skill_install",{clientOperationId:crypto.randomUUID(),skill:changed})).toMatchObject({imported:["writer"]});
    control.close();control=new AgentControl(directory,skills);
    expect(await control.call(runId,"skill_remove",remove)).toEqual({removed:true,unchanged:false});
    expect((await control.call(runId,"skills",{}) as any).skills).toHaveLength(1);
  }finally{control.close();}
});

test("control identity advertises the local skill schemas without sending mutations to the server",async()=>{
  const directory=state(),control=new AgentControl(directory),runId=crypto.randomUUID();
  try{
    const pending=control.call(runId,"identity",{});await Bun.sleep(0);
    const requestList=await (await control.handleRequest(request("/control")))!.json() as any;
    expect(requestList.requests).toHaveLength(1);
    await control.handleRequest(request(`/control/${requestList.requests[0].id}/result`,"POST",{operations:["identity"],examples:{},instructions:"Read state."}));
    const identity=await pending as any;
    expect(identity.operations).toContain("skills");expect(identity.operations).toContain("skill_install");
    expect(identity.examples.skill_update).toMatchObject({clientOperationId:"UUID",expectedHash:"hash returned by skills"});
    expect(identity.instructions).toContain("keep clientOperationId stable");
    expect((await (await control.handleRequest(request("/control")))!.json() as any).requests).toEqual([]);
  }finally{control.close();}
});

test("a retry reconciles a crash after an install without repeating or changing its result",async()=>{
  const directory=state(),skills=new AgentSkills(directory),runId=crypto.randomUUID(),clientOperationId=crypto.randomUUID();
  const input={clientOperationId,skill:{name:"recovered",files:[file("SKILL.md","---\ndescription: Recovered.\n---\nInstalled")]}};
  let fail=true;let control=new AgentControl(directory,skills,()=>{if(fail){fail=false;throw new Error("FAULT_AFTER_SKILL_MUTATION");}});
  await expect(control.call(runId,"skill_install",input)).rejects.toThrow("FAULT_AFTER_SKILL_MUTATION");
  expect(readFileSync(join(directory,"pi","skills","recovered","SKILL.md"),"utf8")).toContain("Installed");
  control.close();control=new AgentControl(directory,skills);
  try{
    const recovered=await control.call(runId,"skill_install",input);
    expect(recovered).toMatchObject({imported:["recovered"],unchanged:[]});
    expect(await control.call(runId,"skill_install",input)).toEqual(recovered);
  }finally{control.close();}
});

test("an ambiguous update retry never overwrites a newer reinstall",async()=>{
  const directory=state(),skills=new AgentSkills(directory),runId=crypto.randomUUID();
  const first={name:"writer",files:[file("SKILL.md","---\ndescription: Writes.\n---\nVersion one")]};
  let control=new AgentControl(directory,skills);
  await control.call(runId,"skill_install",{clientOperationId:crypto.randomUUID(),skill:first});
  const firstHash=(await control.call(runId,"skills",{}) as any).skills[0].hash;control.close();
  const second={name:"writer",files:[file("SKILL.md","---\ndescription: Writes.\n---\nVersion two")]};
  const ambiguous={clientOperationId:crypto.randomUUID(),expectedHash:firstHash,skill:second};let fail=true;
  control=new AgentControl(directory,skills,()=>{if(fail){fail=false;throw new Error("FAULT_AFTER_SKILL_MUTATION");}});
  await expect(control.call(runId,"skill_update",ambiguous)).rejects.toThrow("FAULT_AFTER_SKILL_MUTATION");control.close();
  const secondHash=(skills.control("skills",{}) as any).skills[0].hash;
  const third={name:"writer",files:[file("SKILL.md","---\ndescription: Writes.\n---\nVersion three")]};
  expect(skills.control("skill_update",{clientOperationId:crypto.randomUUID(),expectedHash:secondHash,skill:third})).toMatchObject({imported:["writer"]});
  control=new AgentControl(directory,skills);
  try{
    expect(await control.call(runId,"skill_update",ambiguous)).toEqual({error:"SKILL_NAME_CONFLICT"});
    expect(readFileSync(join(directory,"pi","skills","writer","SKILL.md"),"utf8")).toContain("Version three");
  }finally{control.close();}
});
