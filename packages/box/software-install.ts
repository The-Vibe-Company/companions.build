import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PortableSoftwareManifest } from "../control/software";
import { validatePortableSoftwareManifest } from "../control/software";

export type DetectedLinuxBase = { family: string; suite: string; architecture: string };
export type SoftwareRepositories = { aptOrigin: string; npmRegistry: string };
export type SoftwareArtifact = { packageId: string; bytes: Uint8Array };

const safeToken = /^[a-z0-9][a-z0-9._+-]{0,127}$/;

export function parseOsRelease(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2];
    result[match[1]] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/\\([\\"$`])/g, "$1") : raw;
  }
  return result;
}

export async function detectLinuxBase(run = Bun.spawnSync): Promise<DetectedLinuxBase> {
  const os = parseOsRelease(await readFile("/etc/os-release", "utf8"));
  const family = os.ID;
  const suite = os.VERSION_CODENAME || os.VERSION_ID;
  if (!family || !suite || !safeToken.test(family) || !safeToken.test(suite)) throw new Error("software_base_unsupported");
  const result = run(["dpkg", "--print-architecture"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("software_base_unsupported");
  const architecture = result.stdout.toString().trim();
  if (!safeToken.test(architecture)) throw new Error("software_base_unsupported");
  return { family, suite, architecture };
}

function publicHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("software_repository_invalid");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":")) throw new Error("software_repository_invalid");
  return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/$/, ""));
}

function verifyRepositories(sources: SoftwareRepositories) {
  return { aptOrigin: publicHttpsOrigin(sources.aptOrigin), npmRegistry: publicHttpsOrigin(sources.npmRegistry) };
}

function artifactMap(items: SoftwareArtifact[]) {
  const map = new Map<string, Uint8Array>();
  for (const item of items) {
    if (map.has(item.packageId)) throw new Error("software_artifact_duplicate");
    map.set(item.packageId, item.bytes);
  }
  return map;
}

async function verifyNpmArchive(file: string, entry: PortableSoftwareManifest["npm"]["packages"][number], packages: PortableSoftwareManifest["npm"]["packages"]) {
  const inspected = Bun.spawnSync(["tar", "-xOf", file, "package/package.json"], { stdout: "pipe", stderr: "pipe" });
  if (inspected.exitCode !== 0) throw new Error("software_npm_archive_invalid");
  let metadata: any;
  try { metadata = JSON.parse(inspected.stdout.toString()); } catch { throw new Error("software_npm_archive_invalid"); }
  if (metadata.name !== entry.name || metadata.version !== entry.version) throw new Error("software_npm_identity_mismatch");
  if (["preinstall", "install", "postinstall", "prepare"].some(name => typeof metadata.scripts?.[name] === "string")) throw new Error("software_npm_lifecycle_unsupported");
  if (metadata.optionalDependencies || metadata.peerDependencies || metadata.bundledDependencies || metadata.bundleDependencies) throw new Error("software_npm_dependency_kind_unsupported");
  const lockedNames = entry.dependencies.map(id => packages.find(candidate => candidate.id === id)!.name).sort();
  const declared = Object.entries(metadata.dependencies ?? {});
  if (declared.some(([, spec]) => typeof spec !== "string" || !/^[0-9xX*<>=~^| .-]+$/.test(spec))) throw new Error("software_npm_dependency_source_unsupported");
  if (JSON.stringify(declared.map(([name]) => name).sort()) !== JSON.stringify(lockedNames)) throw new Error("software_npm_dependency_lock_mismatch");
}

export async function verifyNpmArtifacts(graph: PortableSoftwareManifest["npm"], artifacts: SoftwareArtifact[]) {
  const byId = artifactMap(artifacts);
  if (byId.size !== graph.packages.length) throw new Error("software_artifact_set_mismatch");
  const directory = await mkdtemp(join(tmpdir(), "companions-npm-verify-"));
  try {
    for (const [index, entry] of graph.packages.entries()) {
      const bytes = byId.get(entry.id);
      if (!bytes || `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== entry.integrity) throw new Error("software_npm_integrity_mismatch");
      const file = join(directory, `${index}.tgz`);
      await writeFile(file, bytes, { mode: 0o600 });
      await verifyNpmArchive(file, entry, graph.packages);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export type CompiledSoftwareBundle = { directory: string; manifest: PortableSoftwareManifest; repositories: SoftwareRepositories };

export async function compileSoftwareBundle(input: {
  manifest: unknown;
  detectedBase: DetectedLinuxBase;
  repositories: SoftwareRepositories;
  aptArtifacts: SoftwareArtifact[];
  npmArtifacts: SoftwareArtifact[];
  directory?: string;
}): Promise<CompiledSoftwareBundle> {
  const manifest = validatePortableSoftwareManifest(input.manifest);
  if (JSON.stringify(manifest.base.distro) !== JSON.stringify(input.detectedBase)) throw new Error("software_base_mismatch");
  const repositories = verifyRepositories(input.repositories);
  const apt = artifactMap(input.aptArtifacts);
  const npm = artifactMap(input.npmArtifacts);
  if (apt.size !== manifest.apt.packages.length || npm.size !== manifest.npm.packages.length) throw new Error("software_artifact_set_mismatch");
  const directory = input.directory ?? await mkdtemp(join(tmpdir(), "companions-software-"));
  await mkdir(join(directory, "apt"), { recursive: true });
  await mkdir(join(directory, "npm"), { recursive: true });
  for (const entry of manifest.apt.packages) {
    const bytes = apt.get(entry.id);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("software_apt_hash_mismatch");
    const file = join(directory, "apt", `${manifest.apt.packages.indexOf(entry)}.deb`);
    await writeFile(file, bytes, { mode: 0o600 });
    const inspected = Bun.spawnSync(["dpkg-deb", "--field", file, "Package", "Version", "Architecture"], { stdout: "pipe", stderr: "pipe" });
    if (inspected.exitCode !== 0) throw new Error("software_apt_archive_invalid");
    const fields = Object.fromEntries(inspected.stdout.toString().trim().split("\n").map(line => {
      const at = line.indexOf(":");
      return [line.slice(0, at), line.slice(at + 1).trim()];
    }));
    if (fields.Package !== entry.name || fields.Version !== entry.version || fields.Architecture !== entry.architecture) throw new Error("software_apt_identity_mismatch");
  }
  for (const entry of manifest.npm.packages) {
    const bytes = npm.get(entry.id);
    if (!bytes || `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== entry.integrity) throw new Error("software_npm_integrity_mismatch");
    const file = join(directory, "npm", `${manifest.npm.packages.indexOf(entry)}.tgz`);
    await writeFile(file, bytes, { mode: 0o600 });
    await verifyNpmArchive(file, entry, manifest.npm.packages);
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(join(directory, "repositories.json"), JSON.stringify(repositories), { mode: 0o600 });
  return { directory, manifest, repositories };
}

type CommandRunner = (argv: string[]) => { exitCode: number; stdout?: Uint8Array; stderr: Uint8Array };

export async function verifyInstalledSoftwareBundle(bundle: CompiledSoftwareBundle, options: { npmPrefix: string; run?: CommandRunner }) {
  if (!options.npmPrefix.startsWith("/") || options.npmPrefix.includes("..")) throw new Error("software_prefix_invalid");
  const run = options.run ?? ((argv: string[]) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" }));
  for (const entry of bundle.manifest.apt.packages) {
    const result = run(["dpkg-query", "-W", "-f=${Version} ${Architecture}", entry.name]);
    if (result.exitCode !== 0 || new TextDecoder().decode(result.stdout ?? new Uint8Array()).trim() !== `${entry.version} ${entry.architecture}`) throw new Error("software_apt_install_verification_failed");
  }
  for (const entry of bundle.manifest.npm.packages) {
    let metadata: any;
    try { metadata = JSON.parse(await readFile(join(options.npmPrefix, "lib", "node_modules", entry.name, "package.json"), "utf8")); }
    catch { throw new Error("software_npm_install_verification_failed"); }
    if (metadata.name !== entry.name || metadata.version !== entry.version) throw new Error("software_npm_install_verification_failed");
  }
}

export async function installSoftwareBundle(bundle: CompiledSoftwareBundle, options: { npmPrefix: string; getuid?: () => number; run?: CommandRunner } ) {
  if ((options.getuid ?? process.getuid)?.() !== 0) throw new Error("software_installer_requires_root");
  if (!options.npmPrefix.startsWith("/") || options.npmPrefix.includes("..")) throw new Error("software_prefix_invalid");
  const run = options.run ?? ((argv: string[]) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" }));
  const execute = (argv: string[]) => {
    const result = run(argv);
    if (result.exitCode !== 0) throw new Error(`software_install_failed:${argv[0]}`);
  };
  if (bundle.manifest.apt.packages.length) {
    const files = bundle.manifest.apt.packages.map((_, index) => join(bundle.directory, "apt", `${index}.deb`));
    execute(["dpkg", "--unpack", ...files]);
    execute(["dpkg", "--configure", ...bundle.manifest.apt.packages.map(entry => entry.name)]);
  }
  if (bundle.manifest.npm.packages.length) {
    await mkdir(options.npmPrefix, { recursive: true });
    const files = bundle.manifest.npm.packages.map((_, index) => join(bundle.directory, "npm", `${index}.tgz`));
    execute(["npm", "install", "--global", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", options.npmPrefix, ...files]);
  }
  await verifyInstalledSoftwareBundle(bundle, { npmPrefix: options.npmPrefix, run });
}

export async function removeSoftwareBundle(bundle: CompiledSoftwareBundle) { await rm(bundle.directory, { recursive: true, force: true }); }
