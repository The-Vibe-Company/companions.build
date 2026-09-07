import maxSatisfying from "semver/ranges/max-satisfying";
import valid from "semver/functions/valid";
import validRange from "semver/ranges/valid";
import satisfies from "semver/functions/satisfies";
import { validatePortableSoftwareManifest } from "../control/software";
import type { PortableSoftwareManifest } from "../control/software";
import { verifyNpmArtifacts, type SoftwareArtifact } from "./software-install";

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const MAX_PACKAGES = 128;
const MAX_METADATA_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_METADATA_BYTES = 20 * 1024 * 1024;
const MAX_TARBALL_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_TARBALL_BYTES = 100 * 1024 * 1024;

export type ExactNpmRoot = { name: string; version: string };
export type ResolvedNpmSoftware = { npm: PortableSoftwareManifest["npm"]; npmArtifacts: SoftwareArtifact[] };
export type NpmResolverOptions = {
  registry: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxPackages?: number;
  maxMetadataBytes?: number;
  maxTotalMetadataBytes?: number;
  maxTarballBytes?: number;
  maxTotalTarballBytes?: number;
};

function registryBase(value: string) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !host.includes(".") || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":")) throw new Error("software_npm_registry_invalid");
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function registryUrl(base: URL, value: string, kind: "metadata" | "tarball") {
  const url = kind === "metadata" ? new URL(`${base.href.replace(/\/$/, "")}/${encodeURIComponent(value)}`) : new URL(value);
  const prefix = base.pathname === "/" ? "/" : `${base.pathname}/`;
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)) throw new Error("software_npm_registry_escape");
  return url;
}

async function fetchBytes(initial: URL, limit: number, options: NpmResolverOptions, registry: URL) {
  const fetcher = options.fetch ?? fetch;
  let url = initial;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    let response: Response;
    try { response = await fetcher(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: "application/json, application/octet-stream" } }); }
    catch { clearTimeout(timer); throw new Error("software_npm_fetch_failed"); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      clearTimeout(timer);
      const location = response.headers.get("location");
      if (!location) throw new Error("software_npm_fetch_failed");
      url = registryUrl(registry, new URL(location, url).href, "tarball");
      continue;
    }
    if (!response.ok || !response.body) { clearTimeout(timer); throw new Error("software_npm_fetch_failed"); }
    const advertised = Number(response.headers.get("content-length") ?? 0);
    if (advertised > limit) { clearTimeout(timer); throw new Error("software_npm_response_too_large"); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch { clearTimeout(timer); throw new Error("software_npm_fetch_failed"); }
      const { done, value } = chunk;
      if (done) break;
      size += value.byteLength;
      if (size > limit) { clearTimeout(timer); await reader.cancel(); throw new Error("software_npm_response_too_large"); }
      chunks.push(value);
    }
    clearTimeout(timer);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }
  throw new Error("software_npm_redirect_limit");
}

type VersionMetadata = { name: string; version: string; dependencies: Record<string, string>; integrity: string; tarball: string };

function parseVersion(name: string, version: string, raw: any): VersionMetadata {
  if (!raw || raw.name !== name || raw.version !== version || valid(raw.version) !== version) throw new Error("software_npm_metadata_invalid");
  if (raw.optionalDependencies || raw.peerDependencies || raw.bundledDependencies || raw.bundleDependencies) throw new Error("software_npm_dependency_kind_unsupported");
  if (["preinstall", "install", "postinstall", "prepare"].some(key => typeof raw.scripts?.[key] === "string")) throw new Error("software_npm_lifecycle_unsupported");
  if (!raw.dist || typeof raw.dist.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(raw.dist.integrity) || typeof raw.dist.tarball !== "string") throw new Error("software_npm_metadata_invalid");
  const dependencies: Record<string, string> = raw.dependencies ?? {};
  if (!dependencies || Array.isArray(dependencies) || typeof dependencies !== "object") throw new Error("software_npm_metadata_invalid");
  for (const [dependency, range] of Object.entries(dependencies)) {
    if (!packageName.test(dependency) || typeof range !== "string" || validRange(range) === null) throw new Error("software_npm_dependency_source_unsupported");
  }
  return { name, version, dependencies, integrity: raw.dist.integrity, tarball: raw.dist.tarball };
}

export async function resolveNpmSoftware(roots: ExactNpmRoot[], options: NpmResolverOptions): Promise<ResolvedNpmSoftware> {
  const base = registryBase(options.registry);
  if (!roots.length || roots.length > 32) throw new Error("software_npm_roots_invalid");
  const rootMap = new Map<string, string>();
  for (const root of roots) {
    if (!packageName.test(root.name) || valid(root.version) !== root.version || rootMap.has(root.name)) throw new Error("software_npm_roots_invalid");
    rootMap.set(root.name, root.version);
  }
  const packuments = new Map<string, any>();
  let metadataTotal = 0;
  const load = async (name: string) => {
    if (packuments.has(name)) return packuments.get(name);
    const bytes = await fetchBytes(registryUrl(base, name, "metadata"), options.maxMetadataBytes ?? MAX_METADATA_BYTES, options, base);
    metadataTotal += bytes.byteLength;
    if (metadataTotal > (options.maxTotalMetadataBytes ?? MAX_TOTAL_METADATA_BYTES)) throw new Error("software_npm_metadata_too_large");
    let value: any;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("software_npm_metadata_invalid"); }
    if (!value || value.name !== name || !value.versions || typeof value.versions !== "object") throw new Error("software_npm_metadata_invalid");
    packuments.set(name, value);
    return value;
  };

  let selected = new Map<string, VersionMetadata>();
  let previous = "";
  for (let iteration = 0; iteration < 64; iteration++) {
    const constraints = new Map<string, string[]>();
    for (const [name, version] of rootMap) constraints.set(name, [version]);
    for (const metadata of selected.values()) for (const [name, range] of Object.entries(metadata.dependencies)) {
      constraints.set(name, [...(constraints.get(name) ?? []), range]);
    }
    if (constraints.size > (options.maxPackages ?? MAX_PACKAGES)) throw new Error("software_npm_graph_too_large");
    const next = new Map<string, VersionMetadata>();
    for (const name of [...constraints.keys()].sort()) {
      const packument = await load(name);
      const versions = Object.keys(packument.versions).filter(version => valid(version) === version);
      const candidates = versions.filter(version => constraints.get(name)!.every(range => satisfies(version, range)));
      const choice = maxSatisfying(candidates, "*");
      if (!choice) throw new Error("software_npm_multiple_versions_unsupported");
      next.set(name, parseVersion(name, choice, packument.versions[choice]));
    }
    const signature = JSON.stringify([...next].map(([name, metadata]) => [name, metadata.version]));
    selected = next;
    if (signature === previous) break;
    previous = signature;
    if (iteration === 63) throw new Error("software_npm_resolution_unstable");
  }

  const packages = [...selected.values()].map(metadata => ({
    id: `${metadata.name}@${metadata.version}`,
    name: metadata.name,
    version: metadata.version,
    integrity: metadata.integrity,
    dependencies: Object.keys(metadata.dependencies).sort().map(name => `${name}@${selected.get(name)!.version}`),
    lifecycle: false as const,
  }));
  const dummy = validatePortableSoftwareManifest({ version: 1, base: { id: "resolver-validation", distributionDigest: "0".repeat(64), distro: { family: "linux", suite: "resolver", architecture: "any" } }, apt: { roots: [], packages: [] }, npm: { roots: [...rootMap].map(([name, version]) => `${name}@${version}`), packages } });
  const npmArtifacts: SoftwareArtifact[] = [];
  let total = 0;
  for (const entry of dummy.npm.packages) {
    const metadata = selected.get(entry.name)!;
    const tarball = registryUrl(base, metadata.tarball, "tarball");
    const bytes = await fetchBytes(tarball, options.maxTarballBytes ?? MAX_TARBALL_BYTES, options, base);
    total += bytes.byteLength;
    if (total > (options.maxTotalTarballBytes ?? MAX_TOTAL_TARBALL_BYTES)) throw new Error("software_npm_artifacts_too_large");
    npmArtifacts.push({ packageId: entry.id, bytes });
  }
  await verifyNpmArtifacts(dummy.npm, npmArtifacts);
  return { npm: dummy.npm, npmArtifacts };
}
