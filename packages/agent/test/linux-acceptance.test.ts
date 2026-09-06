import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const binary = process.env.AGENT_ACCEPTANCE_BINARY;
const acceptance = binary ? test : test.skip;

acceptance("compiled Linux daemon uses real Pi tools, persists output, rejects unauthorized calls, and cancels shell work", async () => {
  const state = mkdtempSync(join(tmpdir(), "companion-agent-linux-"));
  const name = `companion-agent-${crypto.randomUUID()}`;
  const token = "acceptance-secret";
  const image = process.env.AGENT_ACCEPTANCE_IMAGE ?? "debian:12-slim";
  const create = Bun.spawn(["docker", "create", "--rm", "--init", "--platform", "linux/amd64", "--name", name, "--network", "bridge",
    "-p", "127.0.0.1::8787/tcp", "--mount", `type=bind,source=${dirname(resolve(binary!))},target=/app,readonly`,
    "--mount", `type=bind,source=${state},target=/state`, "-e", `AGENT_TOKEN=${token}`, "-e", "AGENT_TEST_MODE=1",
    "-e", "AGENT_STATE_DIR=/state", image, "/app/companion-agent"], { stdout: "pipe", stderr: "pipe" });
  expect(await create.exited).toBe(0);
  const start = Bun.spawn(["docker", "start", name], { stdout: "ignore", stderr: "pipe" });
  expect(await start.exited).toBe(0);
  try {
    const portProcess = Bun.spawn(["docker", "port", name, "8787/tcp"], { stdout: "pipe" });
    const mapping = (await new Response(portProcess.stdout).text()).trim();
    const port = mapping.slice(mapping.lastIndexOf(":") + 1);
    const base = `http://127.0.0.1:${port}`;
    await waitReady(base, token);
    expect((await fetch(`${base}/health`)).status).toBe(401);
    const writeId = crypto.randomUUID();
    expect((await fetch(`${base}/runs/${writeId}`, { method: "PUT", headers: headers(token), body: JSON.stringify({ content: "write-note", instructions: "Use the available tools." }) })).status).toBe(202);
    const written = await waitTerminal(base, token, writeId);
    expect(written).toEqual({ id: writeId, status: "succeeded", text: "The note was written and read back.", error: null });
    expect(readFileSync(join(state, "workspace", "note.txt"), "utf8")).toBe("written by real Pi tools\n");
    const slowId = crypto.randomUUID();
    await fetch(`${base}/runs/${slowId}`, { method: "PUT", headers: headers(token), body: JSON.stringify({ content: "slow-write", instructions: "" }) });
    await Bun.sleep(300);
    const cancelled = await fetch(`${base}/runs/${slowId}/cancel`, { method: "POST", headers: headers(token) });
    expect((await cancelled.json()).status).toBe("cancelled");
    await Bun.sleep(500);
    expect(existsSync(join(state, "workspace", "should-not-exist"))).toBe(false);
  } finally {
    const stop = Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
    await stop.exited;
  }
}, 60_000);

function headers(token: string) { return { authorization: `Bearer ${token}`, "content-type": "application/json" }; }
async function waitReady(base: string, token: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if ((await fetch(`${base}/health`, { headers: headers(token) })).ok) return; } catch {}
    await Bun.sleep(50);
  }
  throw new Error("daemon did not become ready");
}
async function waitTerminal(base: string, token: string, id: string): Promise<any> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const run = await (await fetch(`${base}/runs/${id}`, { headers: headers(token) })).json();
    if (run.status !== "running") return run;
    await Bun.sleep(50);
  }
  throw new Error(`run ${id} did not settle`);
}
