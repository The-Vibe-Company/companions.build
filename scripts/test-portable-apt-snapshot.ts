import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLinuxBase } from "../packages/box/software-install";
import { portableSoftwareBuildRequestDigest, runPortableSoftwareBuild } from "../packages/box/software-build";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Configuration required: ${name}`);
  return value;
}

if (process.env.COMPANIONS_SOFTWARE_BUILDER !== "1") throw new Error("Run only in an isolated root Linux builder with COMPANIONS_SOFTWARE_BUILDER=1");
const base = await detectLinuxBase();
const keyringBytes = new Uint8Array(await readFile(required("APT_SNAPSHOT_KEYRING")));
if (createHash("sha256").update(keyringBytes).digest("hex") !== required("APT_CANARY_KEYRING_SHA256")) throw new Error("Ubuntu archive keyring mismatch");
const stateDirectory = await mkdtemp(join(tmpdir(), "companions-software-builder-canary-"));
const operator = {
  stateDirectory,
  base: { id: required("APT_CANARY_BASE_ID"), distributionDigest: required("APT_CANARY_DISTRIBUTION_DIGEST"), distro: base },
  aptRepository: {
    family: base.family,
    snapshot: required("APT_SNAPSHOT_ID"),
    architecture: base.architecture,
    keyring: keyringBytes,
    sources: [{
      origin: required("APT_SNAPSHOT_ORIGIN"),
      suite: base.suite,
      components: required("APT_SNAPSHOT_COMPONENTS").split(",").map(value => value.trim()),
      inReleaseSha256: required("APT_SNAPSHOT_INRELEASE_SHA256"),
    }],
  },
  npmRegistry: "https://registry.npmjs.org",
};
const partial = { buildId: crypto.randomUUID(), aptRoots: [{ name: required("APT_CANARY_PACKAGE"), version: required("APT_CANARY_VERSION") }], npmRoots: [] };
const request = { ...partial, requestDigest: portableSoftwareBuildRequestDigest(partial, operator) };
try {
  const result = await runPortableSoftwareBuild(request, operator, {
    environment: { COMPANIONS_SOFTWARE_BUILDER: "1", PATH: "/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root", LANG: "C", LC_ALL: "C" },
  });
  if (result.phase !== "verified" || !result.bundleDirectory || !result.manifestDigest) throw new Error(`Builder did not verify: ${result.errorCode}`);
  const manifest = JSON.parse(await readFile(join(result.bundleDirectory, "manifest.json"), "utf8"));
  const binary = required("APT_CANARY_BINARY");
  if (!/^\/usr\/bin\/[a-z0-9+.-]+$/.test(binary)) throw new Error("Invalid canary binary path");
  const observed = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (observed.exitCode || !new TextDecoder().decode(observed.stdout).includes(required("APT_CANARY_EXPECTED"))) throw new Error("Installed binary verification failed");
  console.log(JSON.stringify({ phase: result.phase, manifestDigest: result.manifestDigest, packageCount: manifest.apt.packages.length, packages: manifest.apt.packages }));
} finally { await rm(stateDirectory, { recursive: true, force: true }); }
