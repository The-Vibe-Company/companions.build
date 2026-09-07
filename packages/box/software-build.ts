import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { softwareManifestDigest, validatePortableSoftwareManifest, type PortableSoftwareManifest } from "../control/software";
import { resolveAptSoftware, type AptSnapshotRepository, type ExactAptRoot } from "./software-resolve-apt";
import { resolveNpmSoftware, type ExactNpmRoot } from "./software-resolve";
import {
  compileSoftwareBundle,
  detectLinuxBase,
  installSoftwareBundle,
  verifyInstalledSoftwareBundle,
  type CompiledSoftwareBundle,
  type DetectedLinuxBase,
  type SoftwareArtifact,
} from "./software-install";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const phase = z.enum(["pending", "resolving", "resolved", "installing", "verifying", "verified", "failed"]);
export type PortableSoftwareBuildPhase = z.infer<typeof phase>;

const journalSchema = z.object({
  version: z.literal(1),
  buildId: uuid,
  requestDigest: digest,
  phase,
  manifestDigest: digest.nullable(),
  errorCode: z.string().regex(/^software_[a-z0-9_:.-]{1,160}$/).nullable(),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
}).strict();

export type PortableSoftwareBuildJournal = z.infer<typeof journalSchema>;

export type PortableSoftwareBuildRequest = {
  buildId: string;
  requestDigest: string;
  aptRoots: ExactAptRoot[];
  npmRoots: ExactNpmRoot[];
};

export type PortableSoftwareBuildOperatorConfig = {
  stateDirectory: string;
  base: { id: string; distributionDigest: string; distro: DetectedLinuxBase };
  aptRepository: AptSnapshotRepository;
  npmRegistry: string;
};

type CommandResult = { exitCode: number; stdout?: Uint8Array; stderr: Uint8Array };
type BuildDependencies = {
  platform?: NodeJS.Platform;
  getuid?: () => number;
  environment?: Record<string, string | undefined>;
  detectBase?: () => Promise<DetectedLinuxBase>;
  resolveApt?: typeof resolveAptSoftware;
  resolveNpm?: typeof resolveNpmSoftware;
  compile?: typeof compileSoftwareBundle;
  install?: typeof installSoftwareBundle;
  verifyInstalled?: typeof verifyInstalledSoftwareBundle;
  run?: (argv: string[]) => CommandResult;
  afterCheckpoint?: (phase: PortableSoftwareBuildPhase) => void | Promise<void>;
  afterInstallForTests?: () => void | Promise<void>;
  lockIdentity?: () => Promise<string>;
  isLockOwnerAlive?: (identity: string) => Promise<boolean>;
  now?: () => Date;
  npmPrefix?: string;
};

export class SoftwareBuildInterruptedForTests extends Error {}

const allowedEnvironment = new Set([
  "COMPANIONS_SOFTWARE_BUILDER", "HOME", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS", "PATH", "SSL_CERT_DIR", "SSL_CERT_FILE", "TMPDIR", "TZ",
]);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

function normalizedRoots<T extends { name: string; version: string }>(roots: T[]) {
  return roots.map(root => ({ name: root.name, version: root.version })).sort((a, b) => `${a.name}\0${a.version}`.localeCompare(`${b.name}\0${b.version}`));
}

export function portableSoftwareBuildRequestDigest(
  request: Pick<PortableSoftwareBuildRequest, "aptRoots" | "npmRoots">,
  operator: Omit<PortableSoftwareBuildOperatorConfig, "stateDirectory">,
) {
  return portableSoftwareBuildRequestDigestFromHashes(request, operator.base, {
    family: operator.aptRepository.family, snapshot: operator.aptRepository.snapshot, architecture: operator.aptRepository.architecture,
    keyringSha256: createHash("sha256").update(operator.aptRepository.keyring).digest("hex"), sources: operator.aptRepository.sources,
  }, operator.npmRegistry);
}

export function portableSoftwareBuildRequestDigestFromHashes(
  request: Pick<PortableSoftwareBuildRequest, "aptRoots" | "npmRoots">,
  base: PortableSoftwareBuildOperatorConfig["base"],
  aptRepository: Omit<PortableSoftwareBuildOperatorConfig["aptRepository"], "keyring"> & { keyringSha256: string },
  npmRegistry: string,
) {
  const bound = {
    version: 1,
    base,
    aptRoots: normalizedRoots(request.aptRoots),
    npmRoots: normalizedRoots(request.npmRoots),
    repositories: {
      apt: {
        family: aptRepository.family,
        snapshot: aptRepository.snapshot,
        architecture: aptRepository.architecture,
        keyringSha256: aptRepository.keyringSha256,
        sources: aptRepository.sources.map(source => ({ ...source, components: [...source.components].sort() }))
          .sort((a, b) => `${a.origin}\0${a.suite}`.localeCompare(`${b.origin}\0${b.suite}`)),
      },
      npmRegistry,
    },
  };
  return createHash("sha256").update(JSON.stringify(stable(bound))).digest("hex");
}

function cleanEnvironment(environment: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !allowedEnvironment.has(key)) throw new Error("software_build_environment_not_clean");
  }
  if (environment.COMPANIONS_SOFTWARE_BUILDER !== "1") throw new Error("software_build_environment_not_clean");
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function safeStateDirectory(value: string) {
  if (!value.startsWith("/") || resolve(value) !== value) throw new Error("software_build_state_directory_invalid");
  return value;
}

async function syncFile(path: string) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncTree(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(path); else await syncFile(path);
  }
  await syncFile(directory);
}

async function writeJournal(directory: string, value: PortableSoftwareBuildJournal) {
  const parsed = journalSchema.parse(value);
  const temporary = join(directory, `.journal-${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(parsed)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, join(directory, "journal.json"));
  await syncFile(directory);
}

async function readJournal(directory: string) {
  try { return journalSchema.parse(JSON.parse(await readFile(join(directory, "journal.json"), "utf8"))); }
  catch (error: any) { if (error?.code === "ENOENT") return null; throw new Error("software_build_journal_invalid"); }
}

async function defaultLockIdentity() {
  const [bootId, processStat] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile(`/proc/${process.pid}/stat`, "utf8")]);
  const tail = processStat.slice(processStat.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (!tail[19]) throw new Error("software_build_lock_failed");
  return `${bootId.trim()}:${process.pid}:${tail[19]}`;
}

async function defaultLockOwnerAlive(identity: string) {
  const parts = identity.split(":");
  if (parts.length !== 3 || !/^\d+$/.test(parts[1])) return false;
  try {
    const [bootId, processStat] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile(`/proc/${parts[1]}/stat`, "utf8")]);
    const tail = processStat.slice(processStat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return bootId.trim() === parts[0] && tail[19] === parts[2];
  } catch { return false; }
}

async function acquireLock(path: string, dependencies: BuildDependencies) {
  const identity = await (dependencies.lockIdentity ?? defaultLockIdentity)();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(`${identity}\n`); await handle.sync(); } finally { await handle.close(); }
      return async () => {
        try { if ((await readFile(path, "utf8")).trim() === identity) await unlink(path); } catch {}
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw new Error("software_build_lock_failed");
      let owner = "";
      try { owner = (await readFile(path, "utf8")).trim(); } catch {}
      if (owner && await (dependencies.isLockOwnerAlive ?? defaultLockOwnerAlive)(owner)) throw new Error("software_build_busy");
      try { await unlink(path); } catch (removeError: any) { if (removeError?.code !== "ENOENT") throw new Error("software_build_busy"); }
    }
  }
  throw new Error("software_build_busy");
}

function stableError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^software_[a-z0-9_:.-]{1,160}$/.test(message) ? message : "software_build_failed";
}

async function artifactsFromBundle(directory: string, manifest: PortableSoftwareManifest, kind: "apt" | "npm") {
  const packages = manifest[kind].packages;
  return Promise.all(packages.map(async (entry, index): Promise<SoftwareArtifact> => ({ packageId: entry.id, bytes: new Uint8Array(await readFile(join(directory, kind, `${index}.${kind === "apt" ? "deb" : "tgz"}`))) })));
}

async function loadVerifiedBundle(directory: string, expectedManifestDigest: string | null, operator: PortableSoftwareBuildOperatorConfig, compile: typeof compileSoftwareBundle) {
  let manifest: PortableSoftwareManifest;
  try { manifest = validatePortableSoftwareManifest(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))); }
  catch { throw new Error("software_build_bundle_invalid"); }
  if (!expectedManifestDigest || softwareManifestDigest(manifest) !== expectedManifestDigest) throw new Error("software_build_bundle_invalid");
  const aptArtifacts = await artifactsFromBundle(directory, manifest, "apt");
  const npmArtifacts = await artifactsFromBundle(directory, manifest, "npm");
  const verificationDirectory = `${directory}.verify-${crypto.randomUUID()}`;
  try {
    await compile({
      manifest, detectedBase: operator.base.distro,
      repositories: { aptOrigin: operator.aptRepository.sources[0]?.origin ?? "", npmRegistry: operator.npmRegistry },
      aptArtifacts, npmArtifacts, directory: verificationDirectory,
    });
  } finally { await rm(verificationDirectory, { recursive: true, force: true }); }
  return { directory, manifest, repositories: { aptOrigin: operator.aptRepository.sources[0]?.origin ?? "", npmRegistry: operator.npmRegistry } } satisfies CompiledSoftwareBundle;
}

function result(journal: PortableSoftwareBuildJournal, directory: string) {
  return { ...journal, bundleDirectory: journal.manifestDigest ? join(directory, "bundle") : null };
}

export async function observePortableSoftwareBuild(stateDirectory: string, buildId: string) {
  uuid.parse(buildId);
  const journal = await readJournal(join(safeStateDirectory(stateDirectory), buildId));
  return journal ? result(journal, join(stateDirectory, buildId)) : null;
}

export async function runPortableSoftwareBuild(request: PortableSoftwareBuildRequest, operator: PortableSoftwareBuildOperatorConfig, dependencies: BuildDependencies = {}) {
  uuid.parse(request.buildId); digest.parse(request.requestDigest);
  const expectedDigest = portableSoftwareBuildRequestDigest(request, operator);
  if (request.requestDigest !== expectedDigest) throw new Error("software_build_request_digest_mismatch");
  if ((dependencies.platform ?? process.platform) !== "linux" || (dependencies.getuid ?? process.getuid)?.() !== 0) throw new Error("software_build_root_linux_required");
  const environment = cleanEnvironment(dependencies.environment ?? process.env);
  const stateDirectory = safeStateDirectory(operator.stateDirectory);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  if (!(await lstat(stateDirectory)).isDirectory()) throw new Error("software_build_state_directory_invalid");
  await chmod(stateDirectory, 0o700);
  const directory = join(stateDirectory, request.buildId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("software_build_state_directory_invalid");
  await chmod(directory, 0o700);
  const releaseLock = await acquireLock(join(directory, "build.lock"), dependencies);
  const now = dependencies.now ?? (() => new Date());
  const checkpoint = async (current: PortableSoftwareBuildJournal, next: PortableSoftwareBuildPhase, details: Partial<Pick<PortableSoftwareBuildJournal, "manifestDigest" | "errorCode">> = {}) => {
    const updated = { ...current, ...details, phase: next, revision: current.revision + 1, updatedAt: now().toISOString() };
    await writeJournal(directory, updated);
    await dependencies.afterCheckpoint?.(next);
    return updated;
  };
  try {
    let journal = await readJournal(directory);
    if (journal && (journal.buildId !== request.buildId || journal.requestDigest !== request.requestDigest)) throw new Error("software_build_request_conflict");
    if (!journal) {
      journal = { version: 1, buildId: request.buildId, requestDigest: request.requestDigest, phase: "pending", manifestDigest: null, errorCode: null, revision: 1, updatedAt: now().toISOString() };
      await writeJournal(directory, journal);
      await dependencies.afterCheckpoint?.("pending");
    }
    if (journal.phase === "failed" || journal.phase === "verified") return result(journal, directory);

    const compile = dependencies.compile ?? compileSoftwareBundle;
    const verify = dependencies.verifyInstalled ?? verifyInstalledSoftwareBundle;
    const npmPrefix = dependencies.npmPrefix ?? "/opt/companions/software";
    const run = dependencies.run ?? ((argv: string[]) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: 300_000, env: environment }));
    let bundle: CompiledSoftwareBundle;

    if (journal.phase === "installing" || journal.phase === "verifying") {
      bundle = await loadVerifiedBundle(join(directory, "bundle"), journal.manifestDigest, operator, compile);
      try { await verify(bundle, { npmPrefix, run }); }
      catch {
        journal = await checkpoint(journal, "failed", { errorCode: journal.phase === "installing" ? "software_build_install_interrupted" : "software_build_verification_failed" });
        return result(journal, directory);
      }
      journal = await checkpoint(journal, "verified", { errorCode: null });
      return result(journal, directory);
    }

    if (journal.phase === "pending" || journal.phase === "resolving") {
      journal = await checkpoint(journal, "resolving");
      await rm(join(directory, "bundle"), { recursive: true, force: true });
      for (const name of await readdir(directory)) if (name.startsWith("bundle.tmp-")) await rm(join(directory, name), { recursive: true, force: true });
      const detected = await (dependencies.detectBase ?? detectLinuxBase)();
      if (JSON.stringify(detected) !== JSON.stringify(operator.base.distro)) throw new Error("software_base_mismatch");
      const apt = request.aptRoots.length
        ? await (dependencies.resolveApt ?? resolveAptSoftware)(request.aptRoots, { repository: operator.aptRepository, base: detected, builder: true })
        : { apt: { roots: [], packages: [] }, aptArtifacts: [], baseDependencies: [] };
      const npm = request.npmRoots.length
        ? await (dependencies.resolveNpm ?? resolveNpmSoftware)(request.npmRoots, { registry: operator.npmRegistry })
        : { npm: { roots: [], packages: [] }, npmArtifacts: [] };
      const manifest = validatePortableSoftwareManifest({ version: 1, base: operator.base, apt: apt.apt, npm: npm.npm });
      const manifestHash = softwareManifestDigest(manifest);
      const temporary = join(directory, `bundle.tmp-${crypto.randomUUID()}`);
      bundle = await compile({
        manifest, detectedBase: detected,
        repositories: { aptOrigin: operator.aptRepository.sources[0]?.origin ?? "", npmRegistry: operator.npmRegistry },
        aptArtifacts: apt.aptArtifacts, npmArtifacts: npm.npmArtifacts, directory: temporary,
      });
      await syncTree(temporary);
      const finalBundleDirectory = join(directory, "bundle");
      await rename(temporary, finalBundleDirectory);
      await syncFile(directory);
      bundle = { ...bundle, directory: finalBundleDirectory };
      journal = await checkpoint(journal, "resolved", { manifestDigest: manifestHash, errorCode: null });
    } else {
      bundle = await loadVerifiedBundle(join(directory, "bundle"), journal.manifestDigest, operator, compile);
    }

    journal = await checkpoint(journal, "installing");
    await (dependencies.install ?? installSoftwareBundle)(bundle, { npmPrefix, getuid: () => 0, run });
    await dependencies.afterInstallForTests?.();
    journal = await checkpoint(journal, "verifying");
    await verify(bundle, { npmPrefix, run });
    journal = await checkpoint(journal, "verified", { errorCode: null });
    return result(journal, directory);
  } catch (error) {
    if (error instanceof SoftwareBuildInterruptedForTests) throw error;
    if (error instanceof Error && error.message === "software_build_request_conflict") throw error;
    const journal = await readJournal(directory);
    if (!journal || ["failed", "verified"].includes(journal.phase)) throw error;
    const failed: PortableSoftwareBuildJournal = { ...journal, phase: "failed", errorCode: stableError(error), revision: journal.revision + 1, updatedAt: now().toISOString() };
    await writeJournal(directory, failed);
    return result(failed, directory);
  } finally {
    await releaseLock();
  }
}
