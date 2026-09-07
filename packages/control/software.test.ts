import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalSoftwareManifest, softwareManifestDigest, validatePortableSoftwareManifest } from "./software";

const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const base = {
  version: 1 as const,
  base: { id: "base-v7", distributionDigest: "a".repeat(64), distro: { family: "debian", suite: "bookworm", architecture: "amd64" } },
  apt: { roots: ["hello:amd64=1.0-1"], packages: [{ id: "hello:amd64=1.0-1", name: "hello", version: "1.0-1", architecture: "amd64", sha256: "b".repeat(64), dependencies: [] }] },
  npm: { roots: ["tiny@1.2.3"], packages: [{ id: "tiny@1.2.3", name: "tiny", version: "1.2.3", integrity, dependencies: [], lifecycle: false as const }] },
};

describe("portable software manifest", () => {
  test("canonicalizes graph order and produces a stable digest", () => {
    const shuffled = structuredClone(base);
    shuffled.apt.roots.reverse();
    expect(canonicalSoftwareManifest(shuffled)).toBe(canonicalSoftwareManifest(base));
    expect(softwareManifestDigest(base)).toBe(createHash("sha256").update(canonicalSoftwareManifest(base)).digest("hex"));
  });

  test("rejects ranges, lifecycle requirements, URLs, unknown fields and incomplete closure", () => {
    expect(() => validatePortableSoftwareManifest({ ...base, npm: { roots: ["tiny@^1"], packages: [{ ...base.npm.packages[0], id: "tiny@^1", version: "^1" }] } })).toThrow();
    expect(() => validatePortableSoftwareManifest({ ...base, npm: { ...base.npm, packages: [{ ...base.npm.packages[0], lifecycle: true }] } })).toThrow();
    expect(() => validatePortableSoftwareManifest({ ...base, command: "curl bad" })).toThrow();
    expect(() => validatePortableSoftwareManifest({ ...base, npm: { roots: ["missing@1.0.0"], packages: base.npm.packages } })).toThrow("software_npm_incomplete_closure");
    expect(() => validatePortableSoftwareManifest({ ...base, base: { ...base.base, repository: "https://example.test" } })).toThrow();
  });
});

export { base as softwareManifestFixture };
