import { BoxClient, BoxError } from "../packages/box/client";
import { config } from "../apps/server/src/config";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import {templateInstallScript} from "./lib/template-install";
import {requirePinnedBun} from "./lib/pinned-bun";

requirePinnedBun();

if (!config.boxKey) throw new Error("Configure BOX_API_KEY in .env before preparing the template.");
const name = process.argv[2] ?? "companions-agent-v0";
if (!/^[a-z0-9-]{1,60}$/.test(name)) throw new Error("Template name must contain lowercase letters, digits and hyphens.");
const box = new BoxClient(config.boxKey);
mkdirSync(".local", { recursive: true, mode: 0o700 });
const journal = Bun.file(`.local/template-${name}.json`);
let state = await journal.exists() ? await journal.json() : { key: crypto.randomUUID(), startedAt: new Date().toISOString() };
await Bun.write(journal, JSON.stringify(state));
const wait = async (ready: () => Promise<boolean>) => {
  const deadline = Date.now() + 10 * 60_000;
  while (!await ready()) { if (Date.now() > deadline) throw new Error("Provider preparation timed out; rerun to reconcile."); await Bun.sleep(2000); }
};
const snapshotReady = async () => {
  const result = await box.getSnapshot(name);
  const status = result.snapshot?.status ?? result.namedSnapshot?.status ?? result.status;
  if (status === "failed") throw new Error("The named snapshot capture failed. Inspect this distribution before creating another name.");
  return status === "ready";
};
// A named distribution is immutable. A timed-out POST is reconciled, never resubmitted.
if (state.snapshotRequestedAt || state.completedAt) {
  try { await wait(snapshotReady); }
  catch { throw new Error("Snapshot submission remains unresolved. Inspect the named snapshot before creating a new distribution name."); }
  state.completedAt ??= new Date().toISOString();
  await Bun.write(journal, JSON.stringify(state, null, 2));
  if ((await box.get(state.boxId)).state !== "archived") await box.stop(state.boxId);
  console.log(`Template ready. Set BOX_TEMPLATE=${name} in .env. Build Box archived.`);
  process.exit(0);
}
try {
  await box.getSnapshot(name);
  throw new Error("This snapshot name already exists. Choose a new immutable distribution name.");
} catch (error) {
  if (!(error instanceof BoxError && error.status === 404)) throw error;
}
if (!state.boxId) {
  if (Date.now() - Date.parse(state.startedAt) > 23 * 3600_000) throw new Error("Creation journal expired. Reconcile its Box before retrying.");
  const result = await box.create(state.key);
  state.boxId = result.id;
  await Bun.write(journal, JSON.stringify(state));
}
console.log(`Preparing template ${name} on Box ${state.boxId}`);
if ((await box.get(state.boxId)).state === "archived") await box.resume(state.boxId);
await wait(async () => ["ready", "idle"].includes((await box.get(state.boxId)).state));
const build = Bun.spawn([process.execPath, "scripts/build-agent.ts"], { stdout: "inherit", stderr: "inherit" });
if (await build.exited) throw new Error("Agent build failed");
const tar = Bun.spawn(["tar", "-czf", ".local/agent.tar.gz", "-C", "dist/agent", "."], { stdout: "inherit", stderr: "inherit" });
if (await tar.exited) throw new Error("Archive creation failed");
const archive = Buffer.from(await Bun.file(".local/agent.tar.gz").arrayBuffer());
const digest = createHash("sha256").update(archive).digest("hex");
const directory = `/tmp/companions-${digest.slice(0, 16)}`;
await box.command(state.boxId, `mkdir -p ${directory}`);
for (let start = 0, index = 0; start < archive.length; start += 3 * 1024 * 1024, index++) {
  await box.writeFile(state.boxId, `${directory}/part-${String(index).padStart(5, "0")}`, archive.subarray(start, start + 3 * 1024 * 1024).toString("base64"), "base64");
}
await box.command(state.boxId, `cat ${directory}/part-* > ${directory}/agent.tar.gz && echo '${digest}  ${directory}/agent.tar.gz' | sha256sum -c -`, 60);
// Resume may have started the baked services. Stop and verify only our units before
// exchanging complete directories; never overwrite a running executable in place.
await box.command(state.boxId, templateInstallScript(directory,digest), 60);
// Remove only upload directories recorded for this owned build Box. Staging archives must
// not accumulate inside every future snapshot and make cold copies progressively heavier.
const stagingDirectories = new Set([directory]);
for (const file of readdirSync(".local").filter(file => /^template-[a-z0-9-]+\.json$/.test(file))) {
  const previous = await Bun.file(`.local/${file}`).json();
  if (previous.boxId === state.boxId && typeof previous.sha256 === "string" && /^[a-f0-9]{64}$/.test(previous.sha256)) {
    stagingDirectories.add(`/tmp/companions-${previous.sha256.slice(0,16)}`);
  }
}
await box.command(state.boxId, `rm -rf -- ${[...stagingDirectories].join(" ")}`);
state.snapshotRequestedAt = new Date().toISOString(); state.sha256 = digest;
await Bun.write(journal, JSON.stringify(state, null, 2));
try { await box.snapshot(state.boxId, name); }
catch (error) {
  if (error instanceof BoxError && error.code === "box_snapshot_limit") {
    state.snapshotRejectedAt = new Date().toISOString(); state.snapshotRejectedCode = error.code;
    delete state.snapshotRequestedAt;
    await Bun.write(journal, JSON.stringify(state, null, 2));
    throw new Error("Box rejected the save because the named snapshot quota is full. Reconcile obsolete owned distributions, then rerun; no snapshot was accepted.");
  }
  throw error;
}
await wait(snapshotReady);
state.completedAt = new Date().toISOString(); state.sha256 = digest;
await Bun.write(journal, JSON.stringify(state, null, 2));
if ((await box.get(state.boxId)).state !== "archived") await box.stop(state.boxId);
console.log(`Template ready. Set BOX_TEMPLATE=${name} in .env. Build Box archived.`);
