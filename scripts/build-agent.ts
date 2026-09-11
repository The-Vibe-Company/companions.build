import {runtimeRelease} from "../packages/box/runtime-release";
import { cpSync, mkdirSync, renameSync, symlinkSync, existsSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { requirePinnedBun } from "./lib/pinned-bun";
import { calculateAgentReleaseDigest } from "./lib/agent-release";

requirePinnedBun();

const argv=process.argv.slice(2);
if(argv.length)throw new Error('Usage: build-agent.ts');

const output = `dist/.agent-build-${crypto.randomUUID()}`;
mkdirSync(output, { recursive: true });

const build = Bun.spawn([process.execPath, "build", "--compile", "--target=bun-linux-x64-baseline",
  "packages/agent/src/index.ts", "--outfile", `${output}/companion-agent`], { stdout: "inherit", stderr: "inherit" });
const code = await build.exited;
if (code !== 0) process.exit(code);
cpSync("packages/box/linux", output, { recursive: true, filter:source=>!source.split(/[\\/]/).includes("__pycache__")&&!source.endsWith(".pyc") });

// Pi resolves these resources relative to the compiled executable at runtime.
cpSync("node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", `${output}/photon_rs_bg.wasm`);
cpSync("node_modules/@earendil-works/pi-coding-agent/package.json", `${output}/package.json`);

writeFileSync(`${output}/runtime-release.json`, JSON.stringify(runtimeRelease(output))+"\n");
const releaseDigest=calculateAgentReleaseDigest(output);
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
