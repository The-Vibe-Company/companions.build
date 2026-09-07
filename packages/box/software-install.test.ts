import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSoftwareBundle, installSoftwareBundle, parseOsRelease } from "./software-install";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function npmArchive(scripts?: Record<string, string>, dependencies?: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "software-npm-fixture-")); dirs.push(dir);
  await mkdir(join(dir, "package"));
  await Bun.write(join(dir, "package", "package.json"), JSON.stringify({ name: "tiny", version: "1.2.3", scripts, dependencies }));
  const archive = join(dir, "tiny.tgz");
  const made = Bun.spawnSync(["tar", "-czf", archive, "package"], { cwd: dir, stderr: "pipe" });
  if (made.exitCode) throw new Error(made.stderr.toString());
  return new Uint8Array(await Bun.file(archive).arrayBuffer());
}

function manifest(bytes: Uint8Array) {
  return {
    version: 1,
    base: { id: "base-v7", distributionDigest: "a".repeat(64), distro: { family: "debian", suite: "bookworm", architecture: "amd64" } },
    apt: { roots: [], packages: [] },
    npm: { roots: ["tiny@1.2.3"], packages: [{ id: "tiny@1.2.3", name: "tiny", version: "1.2.3", integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, dependencies: [], lifecycle: false }] },
  };
}

describe("software bundle compiler", () => {
  test("parses the observed OS rather than assuming a distro", () => {
    expect(parseOsRelease('ID="alpine"\nVERSION_ID=3.22\n')).toEqual({ ID: "alpine", VERSION_ID: "3.22" });
  });

  test("accepts only verified archives from configured public origins and writes no source credential", async () => {
    const bytes = await npmArchive();
    const directory = await mkdtemp(join(tmpdir(), "software-bundle-test-")); dirs.push(directory);
    await compileSoftwareBundle({ manifest: manifest(bytes), detectedBase: { family: "debian", suite: "bookworm", architecture: "amd64" }, repositories: { aptOrigin: "https://snapshot.debian.org/archive/debian/20260907T000000Z", npmRegistry: "https://registry.npmjs.org" }, aptArtifacts: [], npmArtifacts: [{ packageId: "tiny@1.2.3", bytes }], directory });
    const all = `${await readFile(join(directory, "manifest.json"), "utf8")} ${await readFile(join(directory, "repositories.json"), "utf8")}`;
    expect(all).not.toContain("SOURCE_CREDENTIAL_SENTINEL");
  });

  test("rejects tampering, private origins, base drift and lifecycle archives", async () => {
    const bytes = await npmArchive();
    const input = { manifest: manifest(bytes), detectedBase: { family: "debian", suite: "bookworm", architecture: "amd64" }, repositories: { aptOrigin: "https://snapshot.debian.org", npmRegistry: "https://registry.npmjs.org" }, aptArtifacts: [], npmArtifacts: [{ packageId: "tiny@1.2.3", bytes }] };
    await expect(compileSoftwareBundle({ ...input, npmArtifacts: [{ packageId: "tiny@1.2.3", bytes: new Uint8Array([1]) }] })).rejects.toThrow("software_npm_integrity_mismatch");
    await expect(compileSoftwareBundle({ ...input, repositories: { ...input.repositories, npmRegistry: "http://127.0.0.1:4873" } })).rejects.toThrow("software_repository_invalid");
    await expect(compileSoftwareBundle({ ...input, detectedBase: { ...input.detectedBase, suite: "trixie" } })).rejects.toThrow("software_base_mismatch");
    const scripted = await npmArchive({ install: "steal-secret" });
    await expect(compileSoftwareBundle({ ...input, manifest: manifest(scripted), npmArtifacts: [{ packageId: "tiny@1.2.3", bytes: scripted }] })).rejects.toThrow("software_npm_lifecycle_unsupported");
    const remoteDependency = await npmArchive(undefined, { child: "https://evil.test/child.tgz" });
    await expect(compileSoftwareBundle({ ...input, manifest: manifest(remoteDependency), npmArtifacts: [{ packageId: "tiny@1.2.3", bytes: remoteDependency }] })).rejects.toThrow("software_npm_dependency_source_unsupported");
  });

  test("keeps the root boundary explicit", async () => {
    const bytes = await npmArchive();
    const bundle = await compileSoftwareBundle({ manifest: manifest(bytes), detectedBase: { family: "debian", suite: "bookworm", architecture: "amd64" }, repositories: { aptOrigin: "https://snapshot.debian.org", npmRegistry: "https://registry.npmjs.org" }, aptArtifacts: [], npmArtifacts: [{ packageId: "tiny@1.2.3", bytes }] });
    dirs.push(bundle.directory);
    await expect(installSoftwareBundle(bundle, { npmPrefix: "/opt/companions/software", getuid: () => 1000 })).rejects.toThrow("software_installer_requires_root");
  });
});
