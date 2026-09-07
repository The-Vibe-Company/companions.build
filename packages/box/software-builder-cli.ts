#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { z } from "zod";
import { observePortableSoftwareBuild, portableSoftwareBuildRequestDigest, runPortableSoftwareBuild, type PortableSoftwareBuildOperatorConfig } from "./software-build";
import { readBoundedFile, softwareDistributionDescriptorSchema } from "./software-distribution";
import { canonicalSoftwareManifest, softwareManifestDigest } from "../control/software";

export const SOFTWARE_DESCRIPTOR_PATH = "/opt/companions/software-builder.json";
export const SOFTWARE_KEYRING_PATH = "/opt/companions/software-apt-keyring.gpg";
export const SOFTWARE_BUILDER_PATH = "/opt/companions/companion-software-builder";
export const SOFTWARE_STATE_DIRECTORY = "/var/lib/companions-software/builds";
export const SOFTWARE_EXPORT_DIRECTORY = "/tmp/companions-software-exports";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const aptRoot = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9+.-]{0,127}$/), version: z.string().min(1).max(192) }).strict();
const npmRoot = z.object({ name: z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) }).strict();
const requestSchema = z.object({ version: z.literal(1), aptRoots: z.array(aptRoot).max(32), npmRoots: z.array(npmRoot).max(32) }).strict();
const sealSchema = z.object({ version: z.literal(1), requestDigest: digest, manifestDigest: digest, distributionDigest: digest }).strict();
const PRODUCT_UNITS = ["companions-agent-proxy.socket", "companions-agent-proxy.service", "companions-agent.service", "companions-desktop.service"] as const;
const BASELINE_UNITS = ["companions-desktop.service", "companions-agent.service", "companions-agent-proxy.socket"] as const;
const FORBIDDEN_STATE = ["/home/user/.companions.env", "/home/user/.companions", "/etc/companions-desktop.env"] as const;
const SAFE_PROCESS_ENVIRONMENT = new Set(["HOME", "LANG", "LC_ALL", "PATH", "SSL_CERT_DIR", "SSL_CERT_FILE", "TZ"]);

type CliPaths = { descriptor: string; keyring: string; executable: string; state: string; export: string; forbidden: readonly string[] };
type CliDeps = {
  paths?: Partial<CliPaths>;
  getuid?: () => number;
  platform?: NodeJS.Platform;
  run?: (argv: string[]) => { exitCode: number; stderr?: Uint8Array };
  build?: typeof runPortableSoftwareBuild;
  observe?: typeof observePortableSoftwareBuild;
  output?: (value: string) => void;
  trustedOwnerUid?: number;
  environment?: Record<string, string | undefined>;
};

function stableFailure(error: unknown) {
  const value = error instanceof Error ? error.message : "";
  return /^software_[a-z0-9_:.-]{1,160}$/.test(value) ? value : "software_builder_failed";
}

async function ownerControlledRegular(path: string, maximum: number, ownerUid: number) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.uid !== ownerUid || (metadata.mode & 0o022) !== 0 || metadata.size < 1 || metadata.size > maximum) throw new Error("software_builder_file_invalid");
  return readBoundedFile(path, maximum);
}

async function ownerControlledDirectory(path: string, ownerUid: number) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.uid !== ownerUid || (metadata.mode & 0o022) !== 0) throw new Error("software_build_state_directory_invalid");
}

function command(run: NonNullable<CliDeps["run"]>, argv: string[], code: string) {
  const result = run(argv);
  if (result.exitCode !== 0) throw new Error(code);
}

function projection(result: Awaited<ReturnType<typeof runPortableSoftwareBuild>> | null, readyForCapture = false) {
  if (!result) return null;
  return { phase: result.phase, requestDigest: result.requestDigest, manifestDigest: result.manifestDigest,
    errorCode: result.errorCode, revision: result.revision, bundleDirectory: result.bundleDirectory,
    readyForCapture: readyForCapture && result.phase === "verified" };
}

async function readSeal(path: string, ownerUid: number) {
  try { return sealSchema.parse(JSON.parse(new TextDecoder().decode(await ownerControlledRegular(path, 4096, ownerUid)))); }
  catch (error: any) { if (error?.code === "ENOENT") return null; throw new Error("software_builder_seal_invalid"); }
}

async function writeSeal(path: string, value: z.infer<typeof sealSchema>) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(sealSchema.parse(value))}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(path.slice(0, path.lastIndexOf("/")), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writePublicManifest(exportDirectory: string, buildId: string, bundleDirectory: string, expectedDigest: string, ownerUid: number) {
  const source = await readBoundedFile(`${bundleDirectory}/manifest.json`, 8 * 1024 * 1024);
  const canonical = canonicalSoftwareManifest(JSON.parse(new TextDecoder().decode(source)));
  if (softwareManifestDigest(JSON.parse(canonical)) !== expectedDigest) throw new Error("software_manifest_digest_changed");
  await mkdir(exportDirectory, { recursive: true, mode: 0o755 });
  const metadata = await lstat(exportDirectory);
  if (!metadata.isDirectory() || metadata.uid !== ownerUid || (metadata.mode & 0o022) !== 0) throw new Error("software_builder_export_invalid");
  await chmod(exportDirectory, 0o755);
  const path = `${exportDirectory}/${buildId}.manifest.json`;
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o644);
  try { await handle.writeFile(`${canonical}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(exportDirectory, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function publicManifestMatches(path: string, expectedDigest: string, ownerUid: number) {
  try {
    const bytes = await ownerControlledRegular(path, 8 * 1024 * 1024, ownerUid);
    return softwareManifestDigest(JSON.parse(new TextDecoder().decode(bytes))) === expectedDigest;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw new Error("software_builder_export_invalid");
  }
}

export async function runSoftwareBuilderCli(args: string[], deps: CliDeps = {}) {
  const paths: CliPaths = { descriptor: SOFTWARE_DESCRIPTOR_PATH, keyring: SOFTWARE_KEYRING_PATH, executable: SOFTWARE_BUILDER_PATH,
    state: SOFTWARE_STATE_DIRECTORY, export: SOFTWARE_EXPORT_DIRECTORY, forbidden: FORBIDDEN_STATE, ...deps.paths };
  const output = deps.output ?? console.log;
  try {
    if ((deps.platform ?? process.platform) !== "linux" || (deps.getuid ?? process.getuid)?.() !== 0) throw new Error("software_build_root_linux_required");
    if (Object.entries(deps.environment ?? process.env).some(([key, value]) => value !== undefined && !SAFE_PROCESS_ENVIRONMENT.has(key))) throw new Error("software_build_environment_not_clean");
    if (args.length !== 3 || !["run", "status"].includes(args[0])) throw new Error("software_builder_arguments_invalid");
    const operation = args[0] as "run" | "status";
    const buildId = uuid.parse(args[1]);
    const requestDigest = digest.parse(args[2]);
    const trustedOwnerUid = deps.trustedOwnerUid ?? 0;
    const descriptorBytes = await ownerControlledRegular(paths.descriptor, 64 * 1024, trustedOwnerUid);
    const descriptor = softwareDistributionDescriptorSchema.parse(JSON.parse(new TextDecoder().decode(descriptorBytes)));
    const [keyring, executable] = await Promise.all([ownerControlledRegular(paths.keyring, 2 * 1024 * 1024, trustedOwnerUid), ownerControlledRegular(paths.executable, 128 * 1024 * 1024, trustedOwnerUid)]);
    if (createHash("sha256").update(keyring).digest("hex") !== descriptor.keyringSha256
      || createHash("sha256").update(executable).digest("hex") !== descriptor.softwareBuilderSha256) throw new Error("software_builder_identity_mismatch");
    const operator: PortableSoftwareBuildOperatorConfig = { stateDirectory: paths.state, base: descriptor.base,
      aptRepository: { ...descriptor.aptRepository, keyring }, npmRegistry: descriptor.npmRegistry };
    const sealPath = `${paths.state}/${buildId}/capture-seal.json`;
    if (operation === "status") {
      const observed = await (deps.observe ?? observePortableSoftwareBuild)(paths.state, buildId);
      if (observed && observed.requestDigest !== requestDigest) throw new Error("software_build_request_conflict");
      const seal = await readSeal(sealPath, trustedOwnerUid);
      const ready = Boolean(observed?.phase === "verified" && seal?.requestDigest === requestDigest && seal.manifestDigest === observed.manifestDigest
        && seal.distributionDigest === descriptor.base.distributionDigest
        && await publicManifestMatches(`${paths.export}/${buildId}.manifest.json`, observed.manifestDigest!, trustedOwnerUid));
      output(JSON.stringify(projection(observed, ready)));
      return 0;
    }
    for (const path of paths.forbidden) {
      try { await lstat(path); throw new Error("software_builder_source_state_present"); }
      catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
    const requestPath = `${paths.state}/${buildId}/request.json`;
    await ownerControlledDirectory(paths.state, trustedOwnerUid);
    await ownerControlledDirectory(`${paths.state}/${buildId}`, trustedOwnerUid);
    const request = requestSchema.parse(JSON.parse(new TextDecoder().decode(await ownerControlledRegular(requestPath, 64 * 1024, trustedOwnerUid))));
    if (portableSoftwareBuildRequestDigest(request, operator) !== requestDigest) throw new Error("software_build_request_digest_mismatch");
    const run = deps.run ?? (argv => Bun.spawnSync(argv, { stdout: "ignore", stderr: "pipe", timeout: 30_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } }));
    command(run, ["/usr/bin/systemctl", "disable", "--now", ...PRODUCT_UNITS], "software_builder_quiesce_failed");
    // is-active returns non-zero when safely inactive; verify without routing provider output.
    for (const unit of PRODUCT_UNITS) if (run(["/usr/bin/systemctl", "is-active", "--quiet", unit]).exitCode === 0) throw new Error("software_builder_unit_active");
    const result = await (deps.build ?? runPortableSoftwareBuild)({ buildId, requestDigest, aptRoots: request.aptRoots, npmRoots: request.npmRoots }, operator,
      { environment: { COMPANIONS_SOFTWARE_BUILDER: "1", HOME: "/root", PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } });
    let ready = false;
    if (result.phase === "verified") {
      command(run, ["/usr/bin/systemctl", "enable", ...BASELINE_UNITS], "software_builder_restore_failed");
      for (const unit of BASELINE_UNITS) {
        if (run(["/usr/bin/systemctl", "is-enabled", "--quiet", unit]).exitCode !== 0) throw new Error("software_builder_restore_failed");
        if (run(["/usr/bin/systemctl", "is-active", "--quiet", unit]).exitCode === 0) throw new Error("software_builder_unit_active");
      }
      if (!result.bundleDirectory || !result.manifestDigest) throw new Error("software_build_bundle_invalid");
      await writePublicManifest(paths.export, buildId, result.bundleDirectory, result.manifestDigest, trustedOwnerUid);
      await writeSeal(sealPath, { version: 1, requestDigest, manifestDigest: result.manifestDigest!, distributionDigest: descriptor.base.distributionDigest });
      ready = true;
    }
    output(JSON.stringify(projection(result, ready)));
    return result.phase === "failed" ? 2 : 0;
  } catch (error) {
    output(JSON.stringify({ phase: "failed", requestDigest: digest.safeParse(args[2]).success ? args[2] : null, manifestDigest: null,
      errorCode: stableFailure(error), revision: 0, bundleDirectory: null, readyForCapture: false }));
    return 2;
  }
}

if (import.meta.main) process.exit(await runSoftwareBuilderCli(process.argv.slice(2)));
