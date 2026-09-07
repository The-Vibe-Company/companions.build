import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePortableSoftwareManifest, type PortableSoftwareManifest } from "../control/software";
import type { DetectedLinuxBase, SoftwareArtifact } from "./software-install";

export type ExactAptRoot = { name: string; version: string };
export type AptSnapshotSource = { origin: string; suite: string; components: string[]; inReleaseSha256: string };
export type AptSnapshotRepository = { family: string; snapshot: string; architecture: string; keyring: Uint8Array; sources: AptSnapshotSource[] };
export type BaseAptDependency = { id: string; name: string; version: string; architecture: string };
export type ResolvedAptSoftware = { apt: PortableSoftwareManifest["apt"]; aptArtifacts: SoftwareArtifact[]; baseDependencies: BaseAptDependency[] };
type RunResult = { exitCode: number; stdout: Uint8Array; stderr: Uint8Array };
type Runner = (argv: string[]) => RunResult | Promise<RunResult>;
export type AptResolverOptions = { repository: AptSnapshotRepository; base: DetectedLinuxBase; run?: Runner; directory?: string; baseStatusPath?: string; maxPackages?: number; maxIndexBytes?: number; maxArtifactBytes?: number; timeoutMs?: number; getuid?: () => number; builder?: boolean; platform?: NodeJS.Platform };

const namePattern = /^[a-z0-9][a-z0-9+.-]{0,127}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9.+:~\-]{0,191}$/;
const tokenPattern = /^[a-z0-9][a-z0-9._+\-]{0,127}$/;
const snapshotPattern = /^20\d{6}T\d{6}Z$/;
const shaPattern = /^[a-f0-9]{64}$/;

function safeOrigin(value: string) {
  const url = new URL(value), host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || /^\d+(?:\.\d+){3}$/.test(host)) throw new Error("software_apt_repository_invalid");
  return url.href.replace(/\/$/, "");
}

function paragraphs(text: string) {
  return text.trim().split(/\n\s*\n/).filter(Boolean).map(block => {
    const fields: Record<string, string> = {};
    let current = "";
    for (const line of block.split("\n")) {
      if (/^[ \t]/.test(line) && current) fields[current] += ` ${line.trim()}`;
      else { const at = line.indexOf(":"); if (at > 0) { current = line.slice(0, at); fields[current] = line.slice(at + 1).trim(); } }
    }
    return fields;
  });
}

function installedBase(text: string) {
  return paragraphs(text).filter(item => item.Status === "install ok installed" && item.Package && item.Version && item.Architecture);
}

function dependencyGroups(value: string) {
  if (!value) return [];
  return value.split(",").map(group => group.split("|").map(raw => {
    const cleaned = raw.trim().replace(/\s*\[[^\]]*\]\s*/g, "").replace(/\s*<[^>]*>\s*/g, "");
    const match = /^([a-z0-9][a-z0-9+.-]*)(?::(any|native|[a-z0-9][a-z0-9._+-]*))?(?:\s*\((<<|<=|=|>=|>>)\s*([^\s)]+)\))?$/.exec(cleaned);
    if (!match) throw new Error("software_apt_dependency_unsupported");
    return { name: match[1], architecture: match[2], operator: match[3], version: match[4] };
  }));
}

async function filesBelow(directory: string, suffix: string) {
  const result: string[] = [];
  async function walk(path: string) { for (const entry of await readdir(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) await walk(child); else if (entry.name.endsWith(suffix)) result.push(child); } }
  await walk(directory); return result.sort();
}

export async function resolveAptSoftware(roots: ExactAptRoot[], options: AptResolverOptions): Promise<ResolvedAptSoftware> {
  if ((options.platform ?? process.platform) !== "linux" || (options.getuid ?? process.getuid)?.() !== 0 || !(options.builder ?? process.env.COMPANIONS_SOFTWARE_BUILDER === "1")) throw new Error("software_apt_isolated_builder_required");
  const repository = options.repository;
  if (!tokenPattern.test(repository.family) || !tokenPattern.test(repository.architecture) || !snapshotPattern.test(repository.snapshot) || !repository.keyring.byteLength || repository.keyring.byteLength > 1024 * 1024 || !repository.sources.length) throw new Error("software_apt_repository_invalid");
  const sourcesConfig = repository.sources.map(source => ({ ...source, origin: safeOrigin(source.origin) }));
  if (sourcesConfig.some(source => !tokenPattern.test(source.suite) || !shaPattern.test(source.inReleaseSha256) || !source.components.length || new Set(source.components).size !== source.components.length || source.components.some(component => !tokenPattern.test(component)))) throw new Error("software_apt_repository_invalid");
  if (sourcesConfig.some(source => !new URL(source.origin).pathname.split("/").includes(repository.snapshot))) throw new Error("software_apt_snapshot_not_immutable");
  if (new Set(sourcesConfig.map(source => `${source.origin}\0${source.suite}`)).size !== sourcesConfig.length) throw new Error("software_apt_repository_invalid");
  if (repository.family !== options.base.family || repository.architecture !== options.base.architecture || !sourcesConfig.some(source => source.suite === options.base.suite)) throw new Error("software_base_mismatch");
  if (!roots.length || roots.length > 32 || roots.some(root => !namePattern.test(root.name) || !versionPattern.test(root.version)) || new Set(roots.map(root => root.name)).size !== roots.length) throw new Error("software_apt_roots_invalid");
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "companions-apt-resolve-"));
  const owned = !options.directory;
  const run: Runner = options.run ?? (argv => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: options.timeoutMs ?? 300_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", HOME: directory, LANG: "C", LC_ALL: "C", APT_CONFIG: "/dev/null" } }));
  const execute = async (argv: string[]) => { const result = await run(argv); if (result.exitCode) throw new Error(`software_apt_command_failed:${argv[0]}`); return new TextDecoder().decode(result.stdout); };
  try {
    const lists = join(directory, "lists"), archives = join(directory, "archives"), keyring = join(directory, "archive-keyring.gpg"), sources = join(directory, "snapshot.sources"), statusPath = join(directory, "status");
    await Promise.all([mkdir(join(lists, "partial"), { recursive: true }), mkdir(join(archives, "partial"), { recursive: true })]);
    await Promise.all([chmod(directory, 0o755), chmod(lists, 0o755), chmod(archives, 0o755)]);
    await writeFile(keyring, repository.keyring, { mode: 0o644 });
    await writeFile(sources, sourcesConfig.map(source => `Types: deb\nURIs: ${source.origin}\nSuites: ${source.suite}\nComponents: ${source.components.join(" ")}\nArchitectures: ${repository.architecture}\nSigned-By: ${keyring}\n`).join("\n"));
    await cp(options.baseStatusPath ?? "/var/lib/dpkg/status", statusPath);
    const aptOptions = ["-o", `Dir::Etc::sourcelist=${sources}`, "-o", "Dir::Etc::sourceparts=-", "-o", "Dir::Etc::netrc=-", "-o", "Dir::Etc::netrcparts=-", "-o", "Dir::Etc::trusted=-", "-o", "Dir::Etc::trustedparts=-", "-o", `Dir::State::lists=${lists}`, "-o", `Dir::State::status=${statusPath}`, "-o", `Dir::Cache::archives=${archives}`, "-o", "Acquire::AllowInsecureRepositories=false", "-o", "Acquire::AllowDowngradeToInsecureRepositories=false", "-o", "APT::Install-Recommends=false"];
    await execute(["apt-get", ...aptOptions, "update"]);
    let indexBytes = 0;
    for (const file of await filesBelow(lists, "")) indexBytes += (await stat(file)).size;
    if (indexBytes > (options.maxIndexBytes ?? 256 * 1024 * 1024)) throw new Error("software_apt_indexes_too_large");
    const releases = await filesBelow(lists, "InRelease");
    const releaseHashes = await Promise.all(releases.map(async file => createHash("sha256").update(await readFile(file)).digest("hex")));
    const expectedReleaseHashes = sourcesConfig.map(source => source.inReleaseSha256).sort();
    if (JSON.stringify(releaseHashes.sort()) !== JSON.stringify(expectedReleaseHashes)) throw new Error("software_apt_release_mismatch");
    await execute(["apt-get", ...aptOptions, "--download-only", "--reinstall", "--no-install-recommends", "--yes", "install", ...roots.map(root => `${root.name}=${root.version}`)]);
    const debs = await filesBelow(archives, ".deb");
    if (debs.length > (options.maxPackages ?? 512)) throw new Error("software_apt_graph_too_large");
    let bytesTotal = 0;
    const selected = new Map<string, any>();
    for (const file of debs) {
      const bytes = new Uint8Array(await readFile(file)); bytesTotal += bytes.byteLength;
      if (bytesTotal > (options.maxArtifactBytes ?? 500 * 1024 * 1024)) throw new Error("software_apt_artifacts_too_large");
      const field = async (name: string) => (await execute(["dpkg-deb", "--field", file, name])).trim();
      const name = await field("Package"), version = await field("Version"), architecture = await field("Architecture");
      if (!namePattern.test(name) || !versionPattern.test(version) || !tokenPattern.test(architecture)) throw new Error("software_apt_archive_invalid");
      const records = paragraphs(await execute(["apt-cache", ...aptOptions, "show", `${name}:${architecture}=${version}`]));
      const record = records.find(item => item.Package === name && item.Version === version && item.Architecture === architecture);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (!record || record.SHA256 !== sha256) throw new Error("software_apt_index_hash_mismatch");
      const id = `${name}:${architecture}=${version}`;
      if (selected.has(name)) throw new Error("software_apt_multiple_architectures_unsupported");
      selected.set(name, { id, name, version, architecture, sha256, bytes, dependencyText: [await field("Pre-Depends"), await field("Depends")].filter(Boolean).join(", ") });
    }
    for (const root of roots) if (selected.get(root.name)?.version !== root.version) throw new Error("software_apt_root_not_downloaded");
    const base = installedBase(await readFile(statusPath, "utf8"));
    const baseDependencies = new Map<string, BaseAptDependency>();
    const satisfies = async (candidate: any, dependency: any) => {
      const architecture = candidate.Architecture ?? candidate.architecture;
      if (dependency.architecture === "native" && ![options.base.architecture, "all"].includes(architecture)) return false;
      if (dependency.architecture && !["any", "native"].includes(dependency.architecture) && dependency.architecture !== architecture) return false;
      if (!dependency.operator) return true;
      return (await run(["dpkg", "--compare-versions", candidate.Version ?? candidate.version, dependency.operator, dependency.version])).exitCode === 0;
    };
    const packages = [];
    for (const item of selected.values()) {
      const dependencies: string[] = [];
      for (const alternatives of dependencyGroups(item.dependencyText)) {
        let choice: any = null, fromBase = false;
        for (const dependency of alternatives) {
          const downloaded = selected.get(dependency.name);
          if (downloaded && await satisfies(downloaded, dependency)) { choice = downloaded; break; }
          for (const installed of base.filter(candidate => candidate.Package === dependency.name)) {
            if (await satisfies(installed, dependency)) { choice = installed; fromBase = true; break; }
          }
          if (choice) break;
        }
        if (!choice) throw new Error("software_apt_dependency_unresolved");
        const id = fromBase ? `${choice.Package}:${choice.Architecture}=${choice.Version}` : choice.id;
        if (fromBase) baseDependencies.set(id, { id, name: choice.Package, version: choice.Version, architecture: choice.Architecture }); else dependencies.push(id);
      }
      packages.push({ id: item.id, name: item.name, version: item.version, architecture: item.architecture, sha256: item.sha256, dependencies });
    }
    const manifest = validatePortableSoftwareManifest({ version: 1, base: { id: "apt-resolver-validation", distributionDigest: "0".repeat(64), distro: options.base }, apt: { roots: roots.map(root => selected.get(root.name).id), packages }, npm: { roots: [], packages: [] } });
    return { apt: manifest.apt, aptArtifacts: manifest.apt.packages.map(entry => ({ packageId: entry.id, bytes: selected.get(entry.name).bytes })), baseDependencies: [...baseDependencies.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  } finally { if (owned) await rm(directory, { recursive: true, force: true }); }
}
