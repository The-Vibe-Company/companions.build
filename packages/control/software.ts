import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._+-]*$/);
const packageId = z.string().min(1).max(256).regex(/^[A-Za-z0-9@/_.:+~=\-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const exactVersion = z.string().min(1).max(128).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const npmName = z.string().min(1).max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/);
const aptName = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9+.-]*$/);
const aptVersion = z.string().min(1).max(192).regex(/^[A-Za-z0-9][A-Za-z0-9.+:~\-]*$/);
const sri = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/).refine(value => Buffer.from(value.slice(7), "base64").length === 64);

const aptPackage = z.object({
  id: packageId,
  name: aptName,
  version: aptVersion,
  architecture: identifier,
  sha256,
  dependencies: z.array(packageId).max(512),
}).strict();

const npmPackage = z.object({
  id: packageId,
  name: npmName,
  version: exactVersion,
  integrity: sri,
  dependencies: z.array(packageId).max(512),
  lifecycle: z.literal(false),
}).strict();

export const portableSoftwareManifestSchema = z.object({
  version: z.literal(1),
  base: z.object({
    id: identifier,
    distributionDigest: sha256,
    distro: z.object({ family: identifier, suite: identifier, architecture: identifier }).strict(),
  }).strict(),
  apt: z.object({ roots: z.array(packageId).max(128), packages: z.array(aptPackage).max(2048) }).strict(),
  npm: z.object({ roots: z.array(packageId).max(128), packages: z.array(npmPackage).max(4096) }).strict(),
}).strict();

export type PortableSoftwareManifest = z.infer<typeof portableSoftwareManifestSchema>;

const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function normalizeGraph<T extends { id: string; dependencies: string[] }>(kind: string, roots: string[], packages: T[]) {
  const byId = new Map<string, T>();
  for (const entry of packages) {
    if (byId.has(entry.id)) throw new Error(`software_${kind}_duplicate_id`);
    if (entry.dependencies.length !== new Set(entry.dependencies).size) throw new Error(`software_${kind}_duplicate_dependency`);
    byId.set(entry.id, entry);
  }
  if (roots.length !== new Set(roots).size) throw new Error(`software_${kind}_duplicate_root`);
  const seen = new Set<string>();
  const visit = (id: string) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`software_${kind}_incomplete_closure`);
    if (seen.has(id)) return;
    seen.add(id);
    entry.dependencies.forEach(visit);
  };
  roots.forEach(visit);
  if (seen.size !== packages.length) throw new Error(`software_${kind}_unreachable_package`);
  return {
    roots: [...roots].sort(compareText),
    packages: packages.map(entry => ({ ...entry, dependencies: [...entry.dependencies].sort(compareText) })).sort((a, b) => compareText(a.id, b.id)),
  };
}

export function validatePortableSoftwareManifest(input: unknown): PortableSoftwareManifest {
  const parsed = portableSoftwareManifestSchema.parse(input);
  for (const entry of parsed.apt.packages) {
    if (entry.id !== `${entry.name}:${entry.architecture}=${entry.version}`) throw new Error("software_apt_noncanonical_id");
  }
  for (const entry of parsed.npm.packages) {
    if (entry.id !== `${entry.name}@${entry.version}`) throw new Error("software_npm_noncanonical_id");
  }
  if (new Set(parsed.npm.packages.map(entry => entry.name)).size !== parsed.npm.packages.length) throw new Error("software_npm_multiple_versions_unsupported");
  return { ...parsed, apt: normalizeGraph("apt", parsed.apt.roots, parsed.apt.packages), npm: normalizeGraph("npm", parsed.npm.roots, parsed.npm.packages) };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareText(a, b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

export function canonicalSoftwareManifest(input: unknown): string {
  return JSON.stringify(stable(validatePortableSoftwareManifest(input)));
}

export function softwareManifestDigest(input: unknown): string {
  return createHash("sha256").update(canonicalSoftwareManifest(input)).digest("hex");
}
