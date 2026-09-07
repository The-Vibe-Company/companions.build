import { cpSync, mkdirSync, renameSync, symlinkSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { requirePinnedBun } from "./lib/pinned-bun";
import { canonicalJson, normalizedSoftwareBuildConfig, readBoundedFile, softwareDistributionDescriptorPayload } from "../packages/box/software-distribution";
import { calculateAgentReleaseDigest } from "./lib/agent-release";

requirePinnedBun();

const argv = process.argv.slice(2);
if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== "--software-config")) throw new Error("Usage: build-agent.ts [--software-config /absolute/operator-config.json]");
const softwareConfigPath = argv[1];
let softwareConfig: ReturnType<typeof normalizedSoftwareBuildConfig> | null = null;
let softwareKeyring: Uint8Array | null = null;
if (softwareConfigPath) {
  softwareConfig = normalizedSoftwareBuildConfig(JSON.parse(new TextDecoder().decode(await readBoundedFile(softwareConfigPath, 64 * 1024))));
  softwareKeyring = await readBoundedFile(softwareConfig.aptRepository.keyringPath, 2 * 1024 * 1024);
}

const output = `dist/.agent-build-${crypto.randomUUID()}`;
mkdirSync(output, { recursive: true });

const build = Bun.spawn([process.execPath, "build", "--compile", "--target=bun-linux-x64-baseline",
  "packages/agent/src/index.ts", "--outfile", `${output}/companion-agent`], { stdout: "inherit", stderr: "inherit" });
const code = await build.exited;
if (code !== 0) process.exit(code);
if (softwareConfig) {
  const builder = Bun.spawn([process.execPath, "build", "--compile", "--target=bun-linux-x64-baseline",
    "packages/box/software-builder-cli.ts", "--outfile", `${output}/companion-software-builder`], { stdout: "inherit", stderr: "inherit" });
  if (await builder.exited) process.exit(1);
}
cpSync("packages/box/linux", output, { recursive: true });

// Pi resolves these resources relative to the compiled executable at runtime.
cpSync("node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", `${output}/photon_rs_bg.wasm`);
cpSync("node_modules/@earendil-works/pi-coding-agent/package.json", `${output}/package.json`);

let descriptorPayload: ReturnType<typeof softwareDistributionDescriptorPayload> | null = null;
if (softwareConfig && softwareKeyring) {
  const builder = readFileSync(`${output}/companion-software-builder`);
  descriptorPayload = softwareDistributionDescriptorPayload(softwareConfig, softwareKeyring, builder);
  // The immutable identity binds the capability inputs but excludes its own digest.
}
const releaseDigest=calculateAgentReleaseDigest(output, descriptorPayload && softwareKeyring ? {
  builder: readFileSync(`${output}/companion-software-builder`), descriptorPayload, keyring: softwareKeyring,
} : undefined);
if (descriptorPayload && softwareKeyring) {
  writeFileSync(`${output}/software-builder.json`, `${canonicalJson({ ...descriptorPayload, base: { ...descriptorPayload.base, distributionDigest: releaseDigest } })}\n`, { mode: 0o644 });
  writeFileSync(`${output}/software-apt-keyring.gpg`, softwareKeyring, { mode: 0o644 });
}
mkdirSync("dist/releases", { recursive: true });
const release = `dist/releases/${releaseDigest}`;
if (existsSync(release)) rmSync(output, { recursive: true, force: true });
else renameSync(output, release);
// Existing containers bind the immutable real directory. Builds cannot remove resources
// from a live process, and changing this alias affects only future preparations.
if (existsSync("dist/agent") && !lstatSync("dist/agent").isSymbolicLink()) renameSync("dist/agent", `dist/releases/legacy-${crypto.randomUUID()}`);
const alias = `dist/.agent-link-${crypto.randomUUID()}`;
symlinkSync(`releases/${releaseDigest}`, alias);
renameSync(alias, "dist/agent");
