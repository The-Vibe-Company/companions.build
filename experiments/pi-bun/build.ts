import { mkdirSync, cpSync, rmSync } from "node:fs";
// This directory contains generated experiment outputs only.
rmSync("dist/pi-bun", { recursive: true, force: true });
mkdirSync("dist/pi-bun", { recursive: true });
const build = Bun.spawn([process.execPath, "build", "--compile", "--target=bun-linux-x64-baseline",
  "experiments/pi-bun/main.ts", "--outfile", "dist/pi-bun/companion-probe"], { stdout: "inherit", stderr: "inherit" });
const code = await build.exited;
if (code !== 0) process.exit(code);
const fixture = Bun.spawn([process.execPath, "build", "--compile", "--target=bun-linux-x64-baseline",
  "experiments/pi-bun/mcp-main.ts", "--outfile", "dist/pi-bun/mcp-fixture"], { stdout: "inherit", stderr: "inherit" });
const fixtureCode = await fixture.exited;
if (fixtureCode !== 0) process.exit(fixtureCode);
cpSync("experiments/pi-bun/skills", "dist/pi-bun/skills", { recursive: true });
cpSync("node_modules/@earendil-works/pi-coding-agent/package.json", "dist/pi-bun/package.json");
cpSync("node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", "dist/pi-bun/photon_rs_bg.wasm");
const image = Bun.spawn(["python3", "experiments/pi-bun/generate-image.py"], { stdout: "inherit", stderr: "inherit" });
if (await image.exited !== 0) process.exit(1);
