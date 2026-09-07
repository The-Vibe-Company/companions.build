import { describe, expect, test } from "bun:test";
import { normalizedSoftwareBuildConfig, softwareDistributionDescriptorPayload, softwareResolverConfigDigest } from "./software-distribution";

const config = { version: 1 as const, base: { id: "ubuntu-noble-v7", distro: { family: "ubuntu", suite: "noble", architecture: "amd64" } },
  aptRepository: { family: "ubuntu", snapshot: "20260901T000000Z", architecture: "amd64", keyringPath: "/opt/companions/keyring.gpg",
    sources: [{ origin: "https://snapshot.ubuntu.com/ubuntu/20260901T000000Z", suite: "noble", components: ["universe", "main"], inReleaseSha256: "a".repeat(64) }] },
  npmRegistry: "https://registry.npmjs.org" };

describe("software distribution identity", () => {
  test("normalizes operator inputs and binds builder and keyring", () => {
    const keyring = new TextEncoder().encode("public-keyring");
    const payload = softwareDistributionDescriptorPayload(config, keyring, new TextEncoder().encode("builder"));
    expect(payload.aptRepository.sources[0]?.components).toEqual(["main", "universe"]);
    expect(payload.resolverConfigDigest).toBe(softwareResolverConfigDigest(config, keyring));
    expect(payload.softwareBuilderSha256).toHaveLength(64);
  });

  test("rejects mutable, private, credentialed, and mismatched repositories", () => {
    expect(() => normalizedSoftwareBuildConfig({ ...config, aptRepository: { ...config.aptRepository,
      sources: [{ ...config.aptRepository.sources[0], origin: "https://archive.ubuntu.com/ubuntu" }] } })).toThrow("software_apt_snapshot_not_immutable");
    expect(() => normalizedSoftwareBuildConfig({ ...config, npmRegistry: "https://token@registry.npmjs.org" })).toThrow("software_distribution_repository_invalid");
    expect(() => normalizedSoftwareBuildConfig({ ...config, npmRegistry: "https://127.0.0.1/npm" })).toThrow("software_distribution_repository_invalid");
    expect(() => normalizedSoftwareBuildConfig({ ...config, base: { ...config.base, distro: { ...config.base.distro, suite: "jammy" } } })).toThrow("software_base_mismatch");
  });
});
