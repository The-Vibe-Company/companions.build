import { cpSync, mkdirSync, rmSync } from "node:fs";

const output = "dist/agent";
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const build = Bun.spawn([process.execPath, "build", "--compile", "--target=bun-linux-x64-baseline",
  "packages/agent/src/index.ts", "--outfile", `${output}/companion-agent`], { stdout: "inherit", stderr: "inherit" });
const code = await build.exited;
if (code !== 0) process.exit(code);

// Pi resolves these resources relative to the compiled executable at runtime.
cpSync("node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", `${output}/photon_rs_bg.wasm`);
cpSync("node_modules/@earendil-works/pi-coding-agent/package.json", `${output}/package.json`);
