import { BoxClient } from "../packages/box/client";
import { config } from "../apps/server/src/config";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";

if (!config.boxKey) throw new Error("Configure BOX_API_KEY in .env before preparing the template.");
const name = process.argv[2] ?? "companions-agent-v0";
if (!/^[a-z0-9-]{1,60}$/.test(name)) throw new Error("Template name must contain lowercase letters, digits and hyphens.");
const box = new BoxClient(config.boxKey);
mkdirSync(".local", { recursive: true, mode: 0o700 });
const journal = Bun.file(`.local/template-${name}.json`);
let state = await journal.exists() ? await journal.json() : { key: crypto.randomUUID(), startedAt: new Date().toISOString() };
await Bun.write(journal, JSON.stringify(state));
if (!state.boxId) {
  if (Date.now() - Date.parse(state.startedAt) > 23 * 3600_000) throw new Error("Creation journal expired. Reconcile its Box before retrying.");
  const result = await box.create(state.key);
  state.boxId = result.id;
  await Bun.write(journal, JSON.stringify(state));
}
console.log(`Preparing template ${name} on Box ${state.boxId}`);
if ((await box.get(state.boxId)).state === "archived") await box.resume(state.boxId);
const wait = async (ready: () => Promise<boolean>) => {
  const deadline = Date.now() + 10 * 60_000;
  while (!await ready()) { if (Date.now() > deadline) throw new Error("Provider preparation timed out; rerun to resume."); await Bun.sleep(2000); }
};
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
await box.command(state.boxId, `cat ${directory}/part-* > ${directory}/agent.tar.gz && echo '${digest}  ${directory}/agent.tar.gz' | sha256sum -c - && mkdir -p /home/user/.companions-dist /home/user/.config/systemd/user && tar -xzf ${directory}/agent.tar.gz -C /home/user/.companions-dist`, 60);
await box.writeFile(state.boxId, "/home/user/.config/systemd/user/companions-agent.service", `[Unit]\nDescription=Companions Pi agent\n[Service]\nEnvironmentFile=/home/user/.companions.env\nExecStart=/home/user/.companions-dist/companion-agent\nRestart=on-failure\nRestartSec=2\n[Install]\nWantedBy=default.target\n`);
await box.command(state.boxId, "systemctl --user daemon-reload && systemctl --user enable companions-agent.service");
await box.snapshot(state.boxId, name);
await wait(async () => { const result = await box.getSnapshot(name); return (result.snapshot?.status ?? result.namedSnapshot?.status ?? result.status) === "ready"; });
state.completedAt = new Date().toISOString(); state.sha256 = digest;
await Bun.write(journal, JSON.stringify(state, null, 2));
await box.stop(state.boxId);
console.log(`Template ready. Set BOX_TEMPLATE=${name} in .env. Build Box archived.`);
