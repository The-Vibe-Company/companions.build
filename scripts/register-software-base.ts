import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, softwareDistributionDescriptorSchema } from "../packages/box/software-distribution";
import { calculateAgentReleaseDigest } from "./lib/agent-release";
import { requirePinnedBun } from "./lib/pinned-bun";

requirePinnedBun();

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function completedSnapshotJournal(value: any) {
  const accepted = Date.parse(value?.snapshotRequestedAt), completed = Date.parse(value?.completedAt), rejected = Date.parse(value?.snapshotRejectedAt);
  return Boolean(Number.isFinite(accepted) && Number.isFinite(completed) && accepted <= completed
    && (!value?.snapshotRejectedAt || (Number.isFinite(rejected) && rejected < accepted)));
}
const run = (argv: string[]) => {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  if (result.exitCode !== 0) throw new Error("Software base artifact validation failed.");
  return new TextDecoder().decode(result.stdout);
};

export async function validateSoftwareBaseArtifact(name: string, root = process.cwd()) {
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(name)) throw new Error("Invalid immutable template name.");
  const journalPath = join(root, ".local", `template-${name}.json`);
  const archivePath = join(root, ".local", "agent.tar.gz");
  const metadata = await lstat(journalPath);
  if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o022) !== 0) throw new Error("Template journal is not an owned immutable file.");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  if (!completedSnapshotJournal(journal) || !/^[a-f0-9]{64}$/.test(journal.sha256)
    || typeof journal.boxId !== "string" || typeof journal.key !== "string") throw new Error("Template journal is incomplete.");
  const archive = new Uint8Array(await readFile(archivePath));
  if (sha(archive) !== journal.sha256) throw new Error("Template archive does not match its completed journal.");
  const entries = run(["/usr/bin/tar", "-tzf", archivePath]).trim().split("\n");
  if (entries.some(entry => entry.startsWith("/") || entry.split("/").includes(".."))) throw new Error("Template archive contains an unsafe path.");
  const directory = await mkdtemp(join(tmpdir(), "companions-software-base-"));
  try {
    run(["/usr/bin/tar", "-xzf", archivePath, "-C", directory]);
    const [descriptorBytes, builder, keyring] = await Promise.all([
      readFile(join(directory, "software-builder.json")), readFile(join(directory, "companion-software-builder")), readFile(join(directory, "software-apt-keyring.gpg")),
    ]);
    const descriptor = softwareDistributionDescriptorSchema.parse(JSON.parse(descriptorBytes.toString("utf8")));
    if (journal.software?.baseId !== descriptor.base.id || journal.software?.distributionDigest !== descriptor.base.distributionDigest
      || journal.software?.resolverConfigDigest !== descriptor.resolverConfigDigest || journal.software?.descriptorSha256 !== sha(descriptorBytes)) {
      throw new Error("Template journal is not bound to this software distribution.");
    }
    if (sha(builder) !== descriptor.softwareBuilderSha256 || sha(keyring) !== descriptor.keyringSha256) throw new Error("Software builder identity does not match its descriptor.");
    const { distributionDigest: _, ...base } = descriptor.base;
    const payload = { ...descriptor, base };
    const calculated = calculateAgentReleaseDigest(directory, { builder, descriptorPayload: payload, keyring });
    if (calculated !== descriptor.base.distributionDigest) throw new Error("Software distribution digest does not match its archive.");
    const current = await readFile(join(root, "dist", "agent", "software-builder.json"), "utf8");
    if (`${canonicalJson(descriptor)}\n` !== current) throw new Error("Template descriptor is not the current locally built descriptor.");
    return { id: descriptor.base.id, providerSnapshotName: name, distributionDigest: descriptor.base.distributionDigest,
      resolverConfigDigest: descriptor.resolverConfigDigest, distro: descriptor.base.distro };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const name = process.argv[2];
  if (!name || process.argv.length !== 3) throw new Error("Usage: register-software-base.ts <immutable-template-name>");
  const registration = await validateSoftwareBaseArtifact(name);
  const { registerSoftwareBase, activateSoftwareBase } = await import("../apps/server/src/software");
  await registerSoftwareBase(registration);
  await activateSoftwareBase(registration.id);
  console.log(`Software base ${registration.id} registered and active for ${name}.`);
}
