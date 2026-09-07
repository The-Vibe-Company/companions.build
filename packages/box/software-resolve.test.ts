import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNpmSoftware } from "./software-resolve";

type Package = { name: string; version: string; dependencies?: Record<string, string>; scripts?: Record<string, string>; optionalDependencies?: Record<string, string> };

async function archive(value: Package) {
  const dir = await mkdtemp(join(tmpdir(), "npm-resolver-test-"));
  try {
    await mkdir(join(dir, "package"));
    await Bun.write(join(dir, "package", "package.json"), JSON.stringify(value));
    const path = join(dir, "package.tgz");
    const result = Bun.spawnSync(["tar", "-czf", path, "package"], { cwd: dir, stderr: "pipe" });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function registry(packages: Package[], override?: (url: URL) => Response | undefined) {
  const byName = new Map<string, Record<string, any>>();
  const tarballs = new Map<string, Uint8Array>();
  return Promise.all(packages.map(async item => {
    const bytes = await archive(item);
    const tarball = `https://registry.npmjs.org/${item.name}/-/${item.name.split("/").at(-1)}-${item.version}.tgz`;
    tarballs.set(tarball, bytes);
    const versions = byName.get(item.name) ?? {};
    versions[item.version] = { ...item, dist: { integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, tarball } };
    byName.set(item.name, versions);
  })).then(() => (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const special = override?.(url); if (special) return special;
    const bytes = tarballs.get(url.href);
    if (bytes) return new Response(bytes as unknown as BodyInit);
    const name = decodeURIComponent(url.pathname.slice(1));
    const versions = byName.get(name);
    return versions ? Response.json({ name, versions }) : new Response("missing", { status: 404 });
  }) as typeof fetch);
}

describe("trusted npm resolver", () => {
  test("locks a full closure deterministically and verifies every archive", async () => {
    const fetch = await registry([
      { name: "alpha", version: "1.0.0", dependencies: { beta: "^1.0.0" } },
      { name: "beta", version: "1.0.0" },
      { name: "beta", version: "1.4.0" },
    ]);
    const result = await resolveNpmSoftware([{ name: "alpha", version: "1.0.0" }], { registry: "https://registry.npmjs.org", fetch });
    expect(result.npm.roots).toEqual(["alpha@1.0.0"]);
    expect(result.npm.packages.map(item => item.id)).toEqual(["alpha@1.0.0", "beta@1.4.0"]);
    expect(result.npm.packages[0].dependencies).toEqual(["beta@1.4.0"]);
    expect(result.npmArtifacts).toHaveLength(2);
  });

  test("rejects graphs needing multiple versions and unsupported package behavior", async () => {
    const conflicting = await registry([
      { name: "alpha", version: "1.0.0", dependencies: { shared: "^1.0.0" } },
      { name: "bravo", version: "1.0.0", dependencies: { shared: "^2.0.0" } },
      { name: "shared", version: "1.1.0" }, { name: "shared", version: "2.1.0" },
    ]);
    await expect(resolveNpmSoftware([{ name: "alpha", version: "1.0.0" }, { name: "bravo", version: "1.0.0" }], { registry: "https://registry.npmjs.org", fetch: conflicting })).rejects.toThrow("software_npm_multiple_versions_unsupported");
    const lifecycle = await registry([{ name: "scripted", version: "1.0.0", scripts: { install: "node install.js" } }]);
    await expect(resolveNpmSoftware([{ name: "scripted", version: "1.0.0" }], { registry: "https://registry.npmjs.org", fetch: lifecycle })).rejects.toThrow("software_npm_lifecycle_unsupported");
    const optional = await registry([{ name: "optional", version: "1.0.0", optionalDependencies: { child: "1.0.0" } }]);
    await expect(resolveNpmSoftware([{ name: "optional", version: "1.0.0" }], { registry: "https://registry.npmjs.org", fetch: optional })).rejects.toThrow("software_npm_dependency_kind_unsupported");
  });

  test("never follows registry metadata outside the configured origin and bounds bytes", async () => {
    const escaped = await registry([{ name: "alpha", version: "1.0.0" }], url => url.pathname === "/alpha" ? new Response(null, { status: 302, headers: { location: "https://evil.test/alpha" } }) : undefined);
    await expect(resolveNpmSoftware([{ name: "alpha", version: "1.0.0" }], { registry: "https://registry.npmjs.org", fetch: escaped })).rejects.toThrow("software_npm_registry_escape");
    const normal = await registry([{ name: "alpha", version: "1.0.0" }]);
    await expect(resolveNpmSoftware([{ name: "alpha", version: "1.0.0" }], { registry: "https://registry.npmjs.org", fetch: normal, maxMetadataBytes: 8 })).rejects.toThrow("software_npm_response_too_large");
    await expect(resolveNpmSoftware([{ name: "alpha", version: "1.0.0" }], { registry: "https://user:secret@registry.npmjs.org", fetch: normal })).rejects.toThrow("software_npm_registry_invalid");
    const badIntegrity = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await normal(input, init);
      if (new URL(String(input)).pathname !== "/alpha") return response;
      const body = await response.json() as any;
      body.versions["1.0.0"].dist.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
      return Response.json(body);
    }) as typeof fetch;
    await expect(resolveNpmSoftware([{ name: "alpha", version: "1.0.0" }], { registry: "https://registry.npmjs.org", fetch: badIntegrity })).rejects.toThrow("software_npm_integrity_mismatch");
  });
});
