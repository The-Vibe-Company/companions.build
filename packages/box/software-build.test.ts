import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observePortableSoftwareBuild,
  portableSoftwareBuildRequestDigest,
  runPortableSoftwareBuild,
  SoftwareBuildInterruptedForTests,
  type PortableSoftwareBuildOperatorConfig,
  type PortableSoftwareBuildRequest,
} from "./software-build";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))));

async function fixture(roots = true) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "software-build-test-"));
  directories.push(stateDirectory);
  const operator: PortableSoftwareBuildOperatorConfig = {
    stateDirectory,
    base: { id: "ubuntu-v7", distributionDigest: "a".repeat(64), distro: { family: "ubuntu", suite: "noble", architecture: "amd64" } },
    aptRepository: {
      family: "ubuntu", snapshot: "20240423T230000Z", architecture: "amd64", keyring: new Uint8Array([1, 2, 3]),
      sources: [{ origin: "https://snapshot.ubuntu.com/ubuntu/20240423T230000Z", suite: "noble", components: ["main"], inReleaseSha256: "b".repeat(64) }],
    },
    npmRegistry: "https://registry.npmjs.org",
  };
  const partial = {
    buildId: crypto.randomUUID(),
    aptRoots: roots ? [{ name: "hello", version: "2.10-3build1" }] : [],
    npmRoots: roots ? [{ name: "is-number", version: "7.0.0" }] : [],
  };
  const request: PortableSoftwareBuildRequest = { ...partial, requestDigest: portableSoftwareBuildRequestDigest(partial, operator) };
  return { operator, request };
}

function dependencies(counts: { apt: number; npm: number; install: number; verify: number }, installed = { value: true }) {
  return {
    platform: "linux" as const,
    getuid: () => 0,
    environment: { COMPANIONS_SOFTWARE_BUILDER: "1", PATH: "/usr/bin:/bin", LANG: "C" },
    detectBase: async () => ({ family: "ubuntu", suite: "noble", architecture: "amd64" }),
    resolveApt: async () => { counts.apt++; return { apt: { roots: [], packages: [] }, aptArtifacts: [], baseDependencies: [] }; },
    resolveNpm: async () => { counts.npm++; return { npm: { roots: [], packages: [] }, npmArtifacts: [] }; },
    install: async () => { counts.install++; installed.value = true; },
    verifyInstalled: async () => { counts.verify++; if (!installed.value) throw new Error("software_npm_install_verification_failed"); },
    lockIdentity: async () => "test-owner",
    isLockOwnerAlive: async (owner: string) => owner === "test-owner",
  };
}

describe("portable software clean builder", () => {
  test("resumes an interrupted read-only resolution and installs one locked result", async () => {
    const { operator, request } = await fixture();
    const counts = { apt: 0, npm: 0, install: 0, verify: 0 };
    let crash = true;
    await expect(runPortableSoftwareBuild(request, operator, {
      ...dependencies(counts),
      afterCheckpoint: next => { if (next === "resolving" && crash) { crash = false; throw new SoftwareBuildInterruptedForTests("crash"); } },
    })).rejects.toBeInstanceOf(SoftwareBuildInterruptedForTests);
    expect((await observePortableSoftwareBuild(operator.stateDirectory, request.buildId))?.phase).toBe("resolving");

    const completed = await runPortableSoftwareBuild(request, operator, dependencies(counts));
    expect(completed.phase).toBe("verified");
    expect(counts).toEqual({ apt: 1, npm: 1, install: 1, verify: 1 });
    expect(completed.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(completed.bundleDirectory!, "manifest.json"), "utf8")).toContain('"version":1');
  });

  test("observes a completed ambiguous install without replaying it", async () => {
    const { operator, request } = await fixture(false);
    const counts = { apt: 0, npm: 0, install: 0, verify: 0 };
    const installed = { value: false };
    let crash = true;
    await expect(runPortableSoftwareBuild(request, operator, {
      ...dependencies(counts, installed),
      install: async () => { counts.install++; installed.value = true; },
      afterInstallForTests: () => { if (crash) { crash = false; throw new SoftwareBuildInterruptedForTests("crash after effect"); } },
    })).rejects.toBeInstanceOf(SoftwareBuildInterruptedForTests);
    expect((await observePortableSoftwareBuild(operator.stateDirectory, request.buildId))?.phase).toBe("installing");

    const completed = await runPortableSoftwareBuild(request, operator, dependencies(counts, installed));
    expect(completed.phase).toBe("verified");
    expect(counts.install).toBe(1);
    expect(counts.verify).toBe(1);
  });

  test("fails closed after a partial ambiguous install instead of replaying package scripts", async () => {
    const { operator, request } = await fixture(false);
    const counts = { apt: 0, npm: 0, install: 0, verify: 0 };
    const installed = { value: false };
    await expect(runPortableSoftwareBuild(request, operator, {
      ...dependencies(counts, installed),
      install: async () => { counts.install++; throw new SoftwareBuildInterruptedForTests("process died during install"); },
    })).rejects.toBeInstanceOf(SoftwareBuildInterruptedForTests);

    const failed = await runPortableSoftwareBuild(request, operator, dependencies(counts, installed));
    expect(failed).toMatchObject({ phase: "failed", errorCode: "software_build_install_interrupted" });
    expect(counts.install).toBe(1);
    const retried = await runPortableSoftwareBuild(request, operator, dependencies(counts, installed));
    expect(retried.phase).toBe("failed");
    expect(counts.install).toBe(1);
  });

  test("pins the request and rejects changed reuse of a build id", async () => {
    const { operator, request } = await fixture(false);
    const counts = { apt: 0, npm: 0, install: 0, verify: 0 };
    await runPortableSoftwareBuild(request, operator, dependencies(counts));
    const changedPartial = { buildId: request.buildId, aptRoots: [], npmRoots: [{ name: "is-number", version: "7.0.0" }] };
    const changed = { ...changedPartial, requestDigest: portableSoftwareBuildRequestDigest(changedPartial, operator) };
    await expect(runPortableSoftwareBuild(changed, operator, dependencies(counts))).rejects.toThrow("software_build_request_conflict");
    expect(counts.install).toBe(1);
  });

  test("a conflicting retry cannot poison unfinished work for the pinned request", async () => {
    const { operator, request } = await fixture(false);
    const counts = { apt: 0, npm: 0, install: 0, verify: 0 };
    await expect(runPortableSoftwareBuild(request, operator, {
      ...dependencies(counts),
      afterCheckpoint: next => { if (next === "resolving") throw new SoftwareBuildInterruptedForTests("crash"); },
    })).rejects.toBeInstanceOf(SoftwareBuildInterruptedForTests);
    const changedPartial = { buildId: request.buildId, aptRoots: [], npmRoots: [{ name: "is-number", version: "7.0.0" }] };
    const changed = { ...changedPartial, requestDigest: portableSoftwareBuildRequestDigest(changedPartial, operator) };
    await expect(runPortableSoftwareBuild(changed, operator, dependencies(counts))).rejects.toThrow("software_build_request_conflict");
    expect((await observePortableSoftwareBuild(operator.stateDirectory, request.buildId))?.phase).toBe("resolving");
    expect((await runPortableSoftwareBuild(request, operator, dependencies(counts))).phase).toBe("verified");
  });

  test("rejects a durable bundle that no longer matches its checkpointed manifest digest", async () => {
    const { operator, request } = await fixture(false);
    const counts = { apt: 0, npm: 0, install: 0, verify: 0 };
    await expect(runPortableSoftwareBuild(request, operator, {
      ...dependencies(counts),
      afterCheckpoint: next => { if (next === "resolved") throw new SoftwareBuildInterruptedForTests("crash"); },
    })).rejects.toBeInstanceOf(SoftwareBuildInterruptedForTests);
    const path = join(operator.stateDirectory, request.buildId, "bundle", "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.base.id = "different-base";
    await writeFile(path, JSON.stringify(manifest));
    const failed = await runPortableSoftwareBuild(request, operator, dependencies(counts));
    expect(failed).toMatchObject({ phase: "failed", errorCode: "software_build_bundle_invalid" });
    expect(counts.install).toBe(0);
  });

  test("binds trusted repository inputs and rejects credential-bearing environments", async () => {
    const { operator, request } = await fixture(false);
    const changedOperator = { ...operator, npmRegistry: "https://registry.example.org" };
    expect(portableSoftwareBuildRequestDigest(request, changedOperator)).not.toBe(request.requestDigest);
    const counts = { apt: 0, npm: 0, install: 0, verify: 0 };
    await expect(runPortableSoftwareBuild(request, operator, {
      ...dependencies(counts),
      environment: { COMPANIONS_SOFTWARE_BUILDER: "1", PATH: "/usr/bin", MODEL_API_KEY: "SOURCE_CREDENTIAL_SENTINEL" },
    })).rejects.toThrow("software_build_environment_not_clean");
    expect(counts).toEqual({ apt: 0, npm: 0, install: 0, verify: 0 });
  });

  test("persists only scrubbed failure state", async () => {
    const { operator, request } = await fixture();
    const counts = { apt: 0, npm: 0, install: 0, verify: 0 };
    const failed = await runPortableSoftwareBuild(request, operator, {
      ...dependencies(counts),
      resolveApt: async () => { throw new Error("provider said SOURCE_CREDENTIAL_SENTINEL"); },
    });
    expect(failed).toMatchObject({ phase: "failed", errorCode: "software_build_failed" });
    const persisted = await readFile(join(operator.stateDirectory, request.buildId, "journal.json"), "utf8");
    expect(persisted).not.toContain("SOURCE_CREDENTIAL_SENTINEL");
    expect(persisted).not.toContain(operator.aptRepository.sources[0].origin);
    expect(persisted).not.toContain(Buffer.from(operator.aptRepository.keyring).toString("hex"));
  });

  test("rejects concurrent progression and recovers a stale process lock", async () => {
    const { operator, request } = await fixture(false);
    const counts = { apt: 0, npm: 0, install: 0, verify: 0 };
    let releaseInstall!: () => void;
    const blocked = new Promise<void>(resolve => { releaseInstall = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = runPortableSoftwareBuild(request, operator, {
      ...dependencies(counts),
      install: async () => { counts.install++; entered(); await blocked; },
    });
    await started;
    await expect(runPortableSoftwareBuild(request, operator, dependencies(counts))).rejects.toThrow("software_build_busy");
    releaseInstall();
    expect((await first).phase).toBe("verified");

    const lock = join(operator.stateDirectory, request.buildId, "build.lock");
    await writeFile(lock, "dead-process\n", { mode: 0o600 });
    const observed = await runPortableSoftwareBuild(request, operator, { ...dependencies(counts), isLockOwnerAlive: async () => false });
    expect(observed.phase).toBe("verified");
    expect(counts.install).toBe(1);
  });
});
