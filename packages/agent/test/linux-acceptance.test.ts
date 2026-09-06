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
  const create = Bun.spawn(["docker", "create", "--init", "--platform", "linux/amd64", "--name", name, "--network", "bridge",
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
    let base = `http://127.0.0.1:${port}`;
    await waitReady(base, token);
    expect((await fetch(`${base}/health`)).status).toBe(401);
    const writeId = crypto.randomUUID();
    expect((await fetch(`${base}/runs/${writeId}`, { method: "PUT", headers: headers(token), body: JSON.stringify({ content: "write-note", instructions: "Use the available tools." }) })).status).toBe(202);
    const written = await waitTerminal(base, token, writeId);
    expect(written).toMatchObject({ id: writeId, status: "succeeded", text: "The note was written and read back.", error: null });
    expect(readFileSync(join(state, "workspace", "note.txt"), "utf8")).toBe("written by real Pi tools\n");
    const slowId = crypto.randomUUID();
    await fetch(`${base}/runs/${slowId}`, { method: "PUT", headers: headers(token), body: JSON.stringify({ content: "slow-write", instructions: "" }) });
    await Bun.sleep(300);
    const cancelled = await fetch(`${base}/runs/${slowId}/cancel`, { method: "POST", headers: headers(token) });
    expect((await cancelled.json()).status).toBe("cancelled");
    await Bun.sleep(500);
    expect(existsSync(join(state, "workspace", "should-not-exist"))).toBe(false);

    const put = async (id: string, content: string, lane = "main") => {
      const response = await fetch(`${base}/runs/${id}`, { method: "PUT", headers: headers(token), body: JSON.stringify({ content, instructions: "", lane }) });
      expect(response.status).toBe(202);
      return response.json();
    };
    const background = crypto.randomUUID(), main = crypto.randomUUID(), steer = crypto.randomUUID();
    await put(background, "background-hold", "background");
    await waitFile(join(state, "workspace/background-started"));
    await put(main, "main-hold");
    await waitFile(join(state, "workspace/main-started"));
    expect((await put(steer, "steered-result")).responseRootId).toBe(main);
    expect(await waitTerminal(base, token, main)).toMatchObject({ status: "succeeded", text: "Native steering applied." });
    expect(await waitTerminal(base, token, steer)).toMatchObject({ status: "succeeded", text: null, responseRootId: main });
    expect((await (await fetch(`${base}/runs/${background}`, { headers: headers(token) })).json()).status).toBe("running");
    await fetch(`${base}/runs/${background}/cancel`, { method: "POST", headers: headers(token) });
    await waitTerminal(base, token, background);

    const privateChat = crypto.randomUUID();
    await put(privateChat, "main-private-message");
    await waitTerminal(base, token, privateChat);
    const isolated = crypto.randomUUID();
    await put(isolated, "inspect-history", "background");
    const isolatedResult = await waitTerminal(base, token, isolated);
    expect(isolatedResult.text).not.toContain("main-private-message");
    expect(isolatedResult.publishToChat).toBe(false);
    const chatHistory = crypto.randomUUID();
    await put(chatHistory, "inspect-history");
    expect((await waitTerminal(base, token, chatHistory)).text).toContain("main-private-message");
    const memoryMain = crypto.randomUUID(), memoryBackground = crypto.randomUUID();
    await Promise.all([put(memoryMain, "memory-cas:main fact"), put(memoryBackground, "memory-cas:background fact", "background")]);
    const memoryResults = await Promise.all([waitTerminal(base, token, memoryMain), waitTerminal(base, token, memoryBackground)]);
    expect(memoryResults.filter(result => result.text.startsWith("Memory updated:"))).toHaveLength(1);
    expect(memoryResults.filter(result => result.text.startsWith("Memory conflict:"))).toHaveLength(1);
    const winningMemory = memoryResults.find(result => result.text.startsWith("Memory updated:"))!.text.replace("Memory updated: ", "");
    expect(readFileSync(join(state, "workspace", "MEMORY.md"), "utf8")).toBe(winningMemory);
    const readConcurrentMemory = crypto.randomUUID();
    await put(readConcurrentMemory, "read-memory-content");
    expect((await waitTerminal(base, token, readConcurrentMemory)).text).toBe(`Memory content: ${winningMemory}`);
    const memory = crypto.randomUUID();
    await put(memory, "remember-preference", "background");
    expect((await waitTerminal(base, token, memory)).text).toBe("Preference saved.");
    const readMemory = crypto.randomUUID();
    await put(readMemory, "inspect-memory");
    expect((await waitTerminal(base, token, readMemory)).text).toBe("Shared memory loaded");
    const isolatedState = mkdtempSync(join(tmpdir(), "companion-agent-memory-isolated-"));
    const isolatedName = `companion-agent-${crypto.randomUUID()}`;
    const isolatedBase = await startIsolatedDaemon(binary!, isolatedState, isolatedName, token, image);
    try {
      const isolatedRead = crypto.randomUUID();
      expect((await fetch(`${isolatedBase}/runs/${isolatedRead}`, { method: "PUT", headers: headers(token), body: JSON.stringify({ content: "read-memory-content", instructions: "" }) })).status).toBe(202);
      expect((await waitTerminal(isolatedBase, token, isolatedRead)).text).toBe("Memory content:");
      const isolatedWrite = crypto.randomUUID();
      expect((await fetch(`${isolatedBase}/runs/${isolatedWrite}`, { method: "PUT", headers: headers(token), body: JSON.stringify({ content: "memory-cas:isolated fact", instructions: "" }) })).status).toBe(202);
      expect((await waitTerminal(isolatedBase, token, isolatedWrite)).text).toBe("Memory updated: isolated fact");
      expect(readFileSync(join(isolatedState, "workspace", "MEMORY.md"), "utf8")).toBe("isolated fact");
      expect(readFileSync(join(state, "workspace", "MEMORY.md"), "utf8")).toBe("User prefers concise summaries.");
    } finally {
      const removeIsolated = Bun.spawn(["docker", "rm", "-f", isolatedName], { stdout: "ignore", stderr: "ignore" });
      await removeIsolated.exited;
    }
    const publish = crypto.randomUUID();
    await put(publish, "publish-background", "background");
    expect(await waitTerminal(base, token, publish)).toMatchObject({ status: "succeeded", text: "Useful background result", publishToChat: true });

    const waiting = crypto.randomUUID(), whileWaiting = crypto.randomUUID();
    await put(waiting, "ask-background", "background");
    await waitFile(join(state, `workspace/question-${waiting}.txt`));
    expect((await (await fetch(`${base}/runs/${waiting}/suspend`, { method: "POST", headers: headers(token) })).json()).status).toBe("needs_input");
    await put(whileWaiting, "background-hold", "background");
    expect((await fetch(`${base}/runs/${waiting}/resume`, { method: "POST", headers: headers(token) })).status).toBe(409);
    const liveChat = crypto.randomUUID();
    await put(liveChat, "write-note");
    expect((await waitTerminal(base, token, liveChat)).status).toBe("succeeded");
    await fetch(`${base}/runs/${whileWaiting}/cancel`, { method: "POST", headers: headers(token) });
    await waitTerminal(base, token, whileWaiting);
    expect((await (await fetch(`${base}/runs/${waiting}/resume`, { method: "POST", headers: headers(token) })).json()).status).toBe("running");
    await Bun.write(join(state, `workspace/answer-${waiting}.txt`), "Use the blue option");
    const resumed = await waitTerminal(base, token, waiting);
    expect(resumed.status).toBe("succeeded");
    expect(resumed.text).toContain("Use the blue option");
    expect(readFileSync(join(state, `workspace/question-${waiting}.txt`), "utf8")).toBe("asked\n");

    const parkedCrash = crypto.randomUUID();
    await put(parkedCrash, "ask-background", "background");
    await waitFile(join(state, `workspace/question-${parkedCrash}.txt`));
    await fetch(`${base}/runs/${parkedCrash}/suspend`, { method: "POST", headers: headers(token) });
    for (const command of [["kill", name], ["start", name]]) {
      const child = Bun.spawn(["docker", ...command], { stdout: "ignore", stderr: "pipe" });
      expect(await child.exited).toBe(0);
    }
    const restartPort = Bun.spawn(["docker", "port", name, "8787/tcp"], { stdout: "pipe" });
    const restartMapping = (await new Response(restartPort.stdout).text()).trim();
    base = `http://127.0.0.1:${restartMapping.slice(restartMapping.lastIndexOf(":") + 1)}`;
    await waitReady(base, token);
    expect(await waitTerminal(base, token, parkedCrash)).toMatchObject({ status: "interrupted", error: "DAEMON_RESTARTED" });
    const persistedMemory = crypto.randomUUID();
    await put(persistedMemory, "inspect-memory");
    expect((await waitTerminal(base, token, persistedMemory)).text).toBe("Shared memory loaded");
    expect((await fetch(`${base}/runs/${parkedCrash}`, { method: "PUT", headers: headers(token), body: JSON.stringify({ content: "ask-background", instructions: "", lane: "background" }) })).status).toBe(200);
    expect(readFileSync(join(state, `workspace/question-${parkedCrash}.txt`), "utf8")).toBe("asked\n");
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
    if (!["running", "needs_input"].includes(run.status)) return run;
    await Bun.sleep(50);
  }
  throw new Error(`run ${id} did not settle`);
}
async function waitFile(path: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(path)) return;
    await Bun.sleep(25);
  }
  throw new Error("Pi shell did not reach its observable checkpoint");
}

async function startIsolatedDaemon(binary: string, state: string, name: string, token: string, image: string) {
  const create = Bun.spawn(["docker", "create", "--init", "--platform", "linux/amd64", "--name", name, "--network", "bridge",
    "-p", "127.0.0.1::8787/tcp", "--mount", `type=bind,source=${dirname(resolve(binary))},target=/app,readonly`,
    "--mount", `type=bind,source=${state},target=/state`, "-e", `AGENT_TOKEN=${token}`, "-e", "AGENT_TEST_MODE=1",
    "-e", "AGENT_STATE_DIR=/state", image, "/app/companion-agent"], { stdout: "ignore", stderr: "pipe" });
  expect(await create.exited).toBe(0);
  const start = Bun.spawn(["docker", "start", name], { stdout: "ignore", stderr: "pipe" });
  expect(await start.exited).toBe(0);
  const portProcess = Bun.spawn(["docker", "port", name, "8787/tcp"], { stdout: "pipe" });
  const mapping = (await new Response(portProcess.stdout).text()).trim();
  const base = `http://127.0.0.1:${mapping.slice(mapping.lastIndexOf(":") + 1)}`;
  await waitReady(base, token);
  return base;
}
