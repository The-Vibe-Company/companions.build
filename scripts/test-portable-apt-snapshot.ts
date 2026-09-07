import { readFile } from "node:fs/promises";
import { detectLinuxBase } from "../packages/box/software-install";
import { resolveAptSoftware } from "../packages/box/software-resolve-apt";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Configuration required: ${name}`);
  return value;
}

if (process.env.COMPANIONS_SOFTWARE_BUILDER !== "1") throw new Error("Run only in an isolated root Linux builder with COMPANIONS_SOFTWARE_BUILDER=1");
const base = await detectLinuxBase();
const result = await resolveAptSoftware([{ name: required("APT_CANARY_PACKAGE"), version: required("APT_CANARY_VERSION") }], {
  base,
  repository: {
    family: base.family,
    snapshot: required("APT_SNAPSHOT_ID"),
    architecture: base.architecture,
    keyring: new Uint8Array(await readFile(required("APT_SNAPSHOT_KEYRING"))),
    sources: [{
      origin: required("APT_SNAPSHOT_ORIGIN"),
      suite: base.suite,
      components: required("APT_SNAPSHOT_COMPONENTS").split(",").map(value => value.trim()),
      inReleaseSha256: required("APT_SNAPSHOT_INRELEASE_SHA256"),
    }],
  },
});
console.log(`Verified ${result.apt.packages.length} downloaded packages and ${result.baseDependencies.length} immutable-base dependencies`);
