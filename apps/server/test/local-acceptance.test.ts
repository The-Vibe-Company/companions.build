import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config, dataDir } from "../src/config";
import { db, migrate, createCompanion, acceptMessage, detail, cancel } from "../src/store";
import {productHooks} from "../src/runtime-product";
import { acquireExecutor, tick } from "../src/executor";

test.skipIf(process.env.RUN_LOCAL_ACCEPTANCE !== "1")("full local path: real Pi files, independent machines, cancel, daemon crash without replay, next work", async () => {
  await migrate();
  const owner = "00000000-0000-4000-8000-000000000001";
  expect(config.testMode).toBe(true);
  const sql = await acquireExecutor();
  expect(sql).not.toBeNull();
  const created: string[] = [];
  const workspace = createHash("sha256").update(dataDir).digest("hex").slice(0, 10);
  async function docker(args: string[]) {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  }
  const until = async (condition: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 30_000;
    while (!await condition()) { if (Date.now() > deadline) throw new Error("Acceptance condition timed out"); await tick(sql!); await Bun.sleep(100); }
  };
  try {
    const ada = await createCompanion(owner, { name: "Acceptance Ada", instructions: "Use tools", provider: "local" }); created.push(ada.id);
    const lin = await createCompanion(owner, { name: "Acceptance Lin", instructions: "", provider: "local" }); created.push(lin.id);
    const first = await acceptMessage(owner, ada.id, crypto.randomUUID(), "write-note");
    await until(async () => (await detail(owner, ada.id))!.runs.some((r: any) => r.id === first && r.status === "succeeded"));
    expect(readFileSync(join(dataDir, "agents", ada.id, "workspace/note.txt"), "utf8")).toBe("written by real Pi tools\n");
    const slow = await acceptMessage(owner, ada.id, crypto.randomUUID(), "slow-write");
    await until(() => existsSync(join(dataDir, "agents", ada.id, "workspace/slow-started")));
    await acceptMessage(owner, lin.id, crypto.randomUUID(), "write-note");
    await until(async () => (await detail(owner, lin.id))!.runs[0].status === "succeeded");
    expect((await detail(owner, ada.id))!.runs.find((r: any) => r.id === slow).status).toBe("running");
    await cancel(owner, ada.id);
    await until(async () => (await detail(owner, ada.id))!.runs.find((r: any) => r.id === slow).status === "cancelled");
    expect(existsSync(join(dataDir, "agents", ada.id, "workspace/should-not-exist"))).toBe(false);
    const crash = await acceptMessage(owner, ada.id, crypto.randomUUID(), "crash-after-effect");
    const effectPath = join(dataDir, "agents", ada.id, "workspace/effects.txt");
    await until(() => existsSync(effectPath));
    const container = `companions-${workspace}-${ada.id}`;
    await docker(["kill", container]);
    await docker(["start", container]);
    await until(async () => (await detail(owner, ada.id))!.runs.find((r: any) => r.id === crash).status === "interrupted");
    expect(readFileSync(effectPath, "utf8")).toBe("effect");
    const next = await acceptMessage(owner, ada.id, crypto.randomUUID(), "write-note");
    await until(async () => (await detail(owner, ada.id))!.runs.find((r: any) => r.id === next).status === "succeeded");
    expect(readFileSync(effectPath, "utf8")).toBe("effect");
    expect((await detail(owner, ada.id))!.messages.filter((m: any) => m.role === "assistant")).toHaveLength(2);
    const controlled=await acceptMessage(owner,ada.id,crypto.randomUUID(),"control-identity");
    const deadline=Date.now()+30_000;
    while((await detail(owner,ada.id))!.runs.find((r:any)=>r.id===controlled).status!=="succeeded") {
      if(Date.now()>deadline)throw Error("Control integration timed out");
      await tick(sql!,productHooks);await Bun.sleep(100);
    }
    expect((await detail(owner,ada.id))!.messages.find((m:any)=>m.runId===controlled&&m.role==="assistant").content).toBe("Control verified");
    expect((await db`SELECT status FROM control_commands WHERE run_id=${controlled}`)[0].status).toBe("done");
  } finally {
    for (const id of created) {
      const child = Bun.spawn(["docker", "rm", "-f", `companions-${workspace}-${id}`], { stdout: "ignore", stderr: "ignore" });
      await child.exited;
    }
    await sql!`SELECT pg_advisory_unlock(721440139)`; sql!.release();
  }
}, 120_000);
