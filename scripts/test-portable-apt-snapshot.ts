import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { compileSoftwareBundle, detectLinuxBase, installSoftwareBundle, removeSoftwareBundle } from "../packages/box/software-install";
import { resolveAptSoftware } from "../packages/box/software-resolve-apt";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Configuration required: ${name}`);
  return value;
}

if (process.env.COMPANIONS_SOFTWARE_BUILDER !== "1") throw new Error("Run only in an isolated root Linux builder with COMPANIONS_SOFTWARE_BUILDER=1");
const base = await detectLinuxBase();
const keyringBytes = new Uint8Array(await readFile(required("APT_SNAPSHOT_KEYRING")));
if (createHash("sha256").update(keyringBytes).digest("hex") !== required("APT_CANARY_KEYRING_SHA256")) throw new Error("Ubuntu archive keyring mismatch");
const result = await resolveAptSoftware([{ name: required("APT_CANARY_PACKAGE"), version: required("APT_CANARY_VERSION") }], {
  base,
  repository: {
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
});
const manifest = {
  version: 1,
  base: { id: required("APT_CANARY_BASE_ID"), distributionDigest: required("APT_CANARY_DISTRIBUTION_DIGEST"), distro: base },
  apt: result.apt,
  npm: { roots: [], packages: [] },
};
const bundle = await compileSoftwareBundle({
  manifest,
  detectedBase: base,
  repositories: { aptOrigin: required("APT_SNAPSHOT_ORIGIN"), npmRegistry: "https://registry.npmjs.org" },
  aptArtifacts: result.aptArtifacts,
  npmArtifacts: [],
});
try {
  await installSoftwareBundle(bundle, { npmPrefix: "/opt/companions/software" });
  const binary = required("APT_CANARY_BINARY");
  if (!/^\/usr\/bin\/[a-z0-9+.-]+$/.test(binary)) throw new Error("Invalid canary binary path");
  const observed = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (observed.exitCode || !new TextDecoder().decode(observed.stdout).includes(required("APT_CANARY_EXPECTED"))) throw new Error("Installed binary verification failed");
  console.log(JSON.stringify({ packageCount: result.apt.packages.length, baseDependencyCount: result.baseDependencies.length, packages: result.apt.packages, baseDependencies: result.baseDependencies }));
} finally { await removeSoftwareBundle(bundle); }
