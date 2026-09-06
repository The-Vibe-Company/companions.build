import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSkills, type SkillManifest } from "../../control/skills";

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
