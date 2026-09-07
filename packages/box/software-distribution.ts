import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const identifier = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._+-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const token = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._+-]*$/);
const snapshot = z.string().regex(/^20\d{6}T\d{6}Z$/);
const source = z.object({ origin: z.string().url().max(500), suite: token, components: z.array(token).min(1).max(16), inReleaseSha256: sha256 }).strict();

export const softwareDistributionBuildConfigSchema = z.object({
  version: z.literal(1),
  base: z.object({ id: identifier, distro: z.object({ family: token, suite: token, architecture: token }).strict() }).strict(),
  aptRepository: z.object({ family: token, snapshot, architecture: token, keyringPath: z.string().min(1).max(500), sources: z.array(source).min(1).max(8) }).strict(),
  npmRegistry: z.string().url().max(500),
}).strict();

export type SoftwareDistributionBuildConfig = z.infer<typeof softwareDistributionBuildConfigSchema>;

export const softwareDistributionDescriptorSchema = z.object({
  version: z.literal(1),
  base: z.object({ id: identifier, distributionDigest: sha256, distro: z.object({ family: token, suite: token, architecture: token }).strict() }).strict(),
  resolverConfigDigest: sha256,
  softwareBuilderSha256: sha256,
  aptRepository: z.object({ family: token, snapshot, architecture: token, sources: z.array(source).min(1).max(8) }).strict(),
  npmRegistry: z.string().url().max(500),
  keyringSha256: sha256,
}).strict();

export type SoftwareDistributionDescriptor = z.infer<typeof softwareDistributionDescriptorSchema>;

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export function canonicalJson(value: unknown) { return JSON.stringify(stable(value)); }

function safePublicHttps(value: string) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^\d+(?:\.\d+){3}$/.test(host)) throw new Error("software_distribution_repository_invalid");
  return value;
}

export function normalizedSoftwareBuildConfig(input: unknown) {
  const config = softwareDistributionBuildConfigSchema.parse(input);
  if (!config.aptRepository.keyringPath.startsWith("/") || resolve(config.aptRepository.keyringPath) !== config.aptRepository.keyringPath) throw new Error("software_distribution_keyring_path_invalid");
  safePublicHttps(config.npmRegistry);
  for (const item of config.aptRepository.sources) {
    safePublicHttps(item.origin);
    if (!new URL(item.origin).pathname.split("/").includes(config.aptRepository.snapshot)) throw new Error("software_apt_snapshot_not_immutable");
  }
  if (config.base.distro.family !== config.aptRepository.family || config.base.distro.architecture !== config.aptRepository.architecture
    || !config.aptRepository.sources.some(item => item.suite === config.base.distro.suite)) throw new Error("software_base_mismatch");
  return {
    ...config,
    aptRepository: {
      ...config.aptRepository,
      sources: config.aptRepository.sources.map(item => ({ ...item, components: [...item.components].sort(compare) }))
        .sort((a, b) => compare(`${a.origin}\0${a.suite}`, `${b.origin}\0${b.suite}`)),
    },
  };
}

export function softwareResolverConfigDigest(config: SoftwareDistributionBuildConfig, keyring: Uint8Array) {
  const normalized = normalizedSoftwareBuildConfig(config);
  const { keyringPath: _, ...aptRepository } = normalized.aptRepository;
  return createHash("sha256").update(canonicalJson({ version: 1, base: normalized.base, aptRepository, npmRegistry: normalized.npmRegistry,
    keyringSha256: createHash("sha256").update(keyring).digest("hex") })).digest("hex");
}

export function softwareDistributionDescriptorPayload(config: SoftwareDistributionBuildConfig, keyring: Uint8Array, softwareBuilder: Uint8Array) {
  const normalized = normalizedSoftwareBuildConfig(config);
  const { keyringPath: _, ...aptRepository } = normalized.aptRepository;
  return {
    version: 1 as const,
    base: normalized.base,
    resolverConfigDigest: softwareResolverConfigDigest(normalized, keyring),
    softwareBuilderSha256: createHash("sha256").update(softwareBuilder).digest("hex"),
    aptRepository,
    npmRegistry: normalized.npmRegistry,
    keyringSha256: createHash("sha256").update(keyring).digest("hex"),
  };
}

export async function readBoundedFile(path: string, limit: number) {
  const details = await stat(path);
  if (!details.isFile() || details.size < 1 || details.size > limit) throw new Error("software_distribution_file_invalid");
  return new Uint8Array(await readFile(path));
}
