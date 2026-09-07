import { cpSync, mkdirSync, renameSync, symlinkSync, existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { requirePinnedBun } from "./lib/pinned-bun";

requirePinnedBun();

const output = `dist/.agent-build-${crypto.randomUUID()}`;
mkdirSync(output, { recursive: true });

const build = Bun.spawn([process.execPath, "build", "--compile", "--target=bun-linux-x64-baseline",
  "packages/agent/src/index.ts", "--outfile", `${output}/companion-agent`], { stdout: "inherit", stderr: "inherit" });
const code = await build.exited;
if (code !== 0) process.exit(code);
cpSync("packages/box/linux", output, { recursive: true });

// Pi resolves these resources relative to the compiled executable at runtime.
cpSync("node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", `${output}/photon_rs_bg.wasm`);
cpSync("node_modules/@earendil-works/pi-coding-agent/package.json", `${output}/package.json`);

const digest = createHash("sha256").update(readFileSync(`${output}/companion-agent`))
  .update(readFileSync(`${output}/photon_rs_bg.wasm`)).update(readFileSync(`${output}/package.json`));
for (const name of ["launch-headless.py","retire-legacy.py","state-directory.py","state-preflight.py","start-headless.sh","headless-mounts.sh","desktop-capture.py","desktop-quiesce.py","desktop-state.py","configure-desktop.py","install-desktop.sh"]) digest.update(readFileSync(`${output}/${name}`));
const releaseDigest=digest.digest("hex");
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
