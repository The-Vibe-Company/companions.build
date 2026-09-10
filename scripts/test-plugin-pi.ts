import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requirePinnedBun } from "./lib/pinned-bun";

requirePinnedBun();
const output = mkdtempSync(join(tmpdir(), "plugin-pi-proof-"));
const container = `plugin-pi-proof-${crypto.randomUUID()}`;
async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  if (await child.exited) throw new Error("PLUGIN_PI_PROOF_FAILED");
}
try {
  await run([process.execPath, "build", "--compile", "--target=bun-linux-x64-baseline",
    "packages/agent/test/fixtures/plugin-pi.ts", "--outfile", join(output, "proof")]);
  cpSync("node_modules/@earendil-works/pi-coding-agent/package.json", join(output, "package.json"));
  cpSync("node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", join(output, "photon_rs_bg.wasm"));
  await run(["docker", "run", "--rm", "--init", "--name", container, "--network", "none", "--platform", "linux/amd64",
    "--label", `companions.build.verification=${process.env.COMPANIONS_VERIFY_RUN??container}`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "python:3.12-slim", "/proof/proof"]);
} finally {
  const remove = Bun.spawn(["docker", "rm", "-f", container], { stdout: "ignore", stderr: "ignore" });
  await remove.exited;
  const inspect=Bun.spawn(["docker","inspect",container],{stdout:"ignore",stderr:"ignore"});
  if(await inspect.exited===0)throw Error("PLUGIN_PI_CLEANUP_FAILED");
  rmSync(output, { recursive: true, force: true });
}
