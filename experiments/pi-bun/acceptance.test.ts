import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const artifacts = resolve(process.env.PROBE_ARTIFACTS ?? ".artifacts/pi-bun/manual");
mkdirSync(artifacts, { recursive: true });

async function start(state = mkdtempSync(`${artifacts}/state-`)) {
  const events: any[] = [];
  const name = `companions-probe-${crypto.randomUUID()}`;
  const tracePrefix = `${state}/${name}`;
  let stderr = "";
  const started = performance.now();
  const proc = spawn("docker", ["run", "--rm", "--init", "--name", name, "-i", "--network=none", "--read-only",
    "--label", `companions.build.probe.run=${process.env.PROBE_RUN_ID ?? name}`,
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/tmp",
    "--mount", `type=bind,source=${resolve("dist/pi-bun")},target=/app,readonly`,
    "--mount", `type=bind,source=${state},target=/state`,
    "--platform", "linux/amd64", process.env.PROBE_IMAGE ?? "companions-build-probe:local", "/app/companion-probe", "serve", "/state"],
    { stdio: ["pipe", "pipe", "pipe"] });
  proc.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: proc.stdout }).on("line", line => {
    try { events.push(JSON.parse(line)); } catch { stderr += line + "\n"; }
  });
  async function wait(predicate: (event: any) => boolean, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      if (proc.exitCode !== null) throw new Error(`Program exited ${proc.exitCode}: ${stderr}`);
      await Bun.sleep(10);
    }
    throw new Error(`Timed out. Events: ${JSON.stringify(events)}; stderr: ${stderr}`);
  }
  function send(command: unknown) { proc.stdin.write(JSON.stringify(command) + "\n"); }
  function saveTrace() {
    writeFileSync(`${tracePrefix}.events.json`, JSON.stringify(events, null, 2));
    writeFileSync(`${tracePrefix}.stderr.log`, stderr);
  }
  async function crash() {
    const kill = Bun.spawn(["docker", "kill", "--signal=KILL", name], { stdout: "ignore", stderr: "pipe" });
    if (await kill.exited !== 0) throw new Error(await new Response(kill.stderr).text());
    const deadline = Date.now() + 5000;
    while (proc.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
    if (proc.exitCode === null) throw new Error(`Container did not stop: ${name}`);
    saveTrace();
  }
  async function stop() {
    if (proc.exitCode === null) {
      send({ op: "exit" });
      const deadline = Date.now() + 5000;
      while (proc.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
      if (proc.exitCode === null) await crash();
    }
    saveTrace();
  }
  try {
    const ready = await wait(e => e.type === "ready");
    return { state, events, send, wait, stop, crash, ready, launchMs: performance.now() - started };
  } catch (error) {
    proc.stdin.end();
    saveTrace();
    if (proc.exitCode === null) await crash();
    throw error;
  }
}

test("a fresh process restores both Pi histories and the file from the same disk", async () => {
  const first = await start();
  try {
    first.send({ op: "prompt", lane: "chat", id: "write", text: "write-note" });
    await first.wait(e => e.type === "settled" && e.lane === "chat");
    first.send({ op: "prompt", lane: "background", id: "bg", text: "hello" });
    await first.wait(e => e.type === "settled" && e.lane === "background");
  } finally { await first.stop(); }
  const second = await start(first.state);
  try {
    for (const lane of ["chat", "background"]) {
      second.send({ op: "history", lane, id: lane });
      const history = await second.wait(e => e.type === "history" && e.id === lane);
      expect(history.messages.some((m: any) => m.role === "assistant")).toBe(true);
      expect(JSON.stringify(history.messages)).toContain(lane === "chat" ? "write-note" : "hello");
      expect(JSON.stringify(history.messages)).not.toContain(lane === "chat" ? '"hello"' : "write-note");
    }
    expect(readFileSync(`${second.state}/workspace/note.txt`, "utf8")).toBe("companion survives restart\n");
    second.send({ op: "prompt", lane: "chat", id: "read", text: "read-note" });
    const done = await second.wait(e => e.type === "settled" && e.lane === "chat");
    expect(done.text).toBe("Recovered note: companion survives restart.");
  } finally { await second.stop(); }
}, 30000);

test("a crash after a shell side effect never replays that ambiguous work on restart", async () => {
  const first = await start();
  try {
    first.send({ op: "prompt", lane: "background", id: "crash", text: "crash-after-effect" });
    await waitFile(`${first.state}/workspace/effects.txt`);
    await first.crash();
  } finally { await first.stop(); }
  const second = await start(first.state);
  try {
    second.send({ op: "history", lane: "background", id: "recovered" });
    const history = await second.wait(e => e.type === "history" && e.id === "recovered");
    expect(JSON.stringify(history.messages)).toContain("crash-after-effect");
    expect(second.events.some(e => e.type === "tool_execution_start")).toBe(false);
    second.send({ op: "prompt", lane: "background", id: "next", text: "hello" });
    const done = await second.wait(e => e.type === "settled" && e.lane === "background");
    expect(done.text).toBe("Hello from the scripted model.");
    expect(readFileSync(`${second.state}/workspace/effects.txt`, "utf8")).toBe("effect\n");
    expect(existsSync(`${second.state}/workspace/ambiguous-finished`)).toBe(false);
  } finally { await second.stop(); }
}, 30000);

test("compiled Pi starts on isolated Linux without a JS runtime or package manager", async () => {
  const app = await start();
  try {
    expect(app.ready.platform).toBe("linux");
    expect(app.ready.arch).toBe("x64");
    expect(app.ready.externalRuntimes).toEqual([]);
    app.send({ op: "prompt", lane: "chat", id: "hello", text: "hello" });
    const done = await app.wait(e => e.type === "settled" && e.lane === "chat");
    expect(done.text).toBe("Hello from the scripted model.");
  } finally { await app.stop(); }
}, 30000);

test("chat stays responsive during background shell work and cancellation stops that work", async () => {
  const app = await start();
  try {
    app.send({ op: "prompt", lane: "background", id: "long", text: "background-job" });
    await app.wait(e => e.type === "tool_execution_start" && e.lane === "background");
    await waitFile(`${app.state}/workspace/background-started`);
    app.send({ op: "prompt", lane: "chat", id: "hello", text: "hello" });
    const reply = await app.wait(e => e.type === "settled" && e.lane === "chat");
    expect(reply.text).toBe("Hello from the scripted model.");
    expect(app.events.some(e => e.type === "settled" && e.lane === "background")).toBe(false);
    app.send({ op: "abort", lane: "background", id: "cancel" });
    await app.wait(e => e.type === "aborted" && e.id === "cancel");
    await Bun.sleep(2300);
    expect(existsSync(`${app.state}/workspace/background-finished`)).toBe(false);
    app.send({ op: "history", lane: "chat", id: "chat-history" });
    const history = await app.wait(e => e.type === "history" && e.id === "chat-history");
    expect(JSON.stringify(history.messages)).not.toContain("background-job");
  } finally { await app.stop(); }
}, 30000);

test("native Pi steer accepts a new chat message while a tool runs and uses it at the next turn", async () => {
  const app = await start();
  try {
    app.send({ op: "prompt", lane: "chat", id: "initial", text: "steering-job" });
    await app.wait(e => e.type === "tool_execution_start" && e.lane === "chat");
    await waitFile(`${app.state}/workspace/steering-started`);
    app.send({ op: "prompt", lane: "chat", id: "steer", text: "new-instruction" });
    const accepted = await app.wait(e => e.type === "accepted" && e.id === "steer");
    expect(accepted.accepted).toBe(true);
    const done = await app.wait(e => e.type === "settled" && e.lane === "chat");
    expect(done.text).toBe("I used the new instruction after the tool completed.");
    expect(readFileSync(`${app.state}/workspace/steering-finished`, "utf8")).toBe("finished");
    app.send({ op: "history", lane: "chat", id: "steered-history" });
    const history = await app.wait(e => e.type === "history" && e.id === "steered-history");
    expect(history.messages.filter((m: any) => m.role === "user")).toHaveLength(2);
  } finally { await app.stop(); }
}, 30000);

async function waitFile(path: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Expected output file was not created: ${path}`);
    await Bun.sleep(10);
  }
}

test("a packaged skill is discovered and its relative shell resource executes", async () => {
  const app = await start();
  try {
    app.send({ op: "prompt", lane: "chat", id: "skill", text: "/skill:probe-skill" });
    const done = await app.wait(e => e.type === "settled" && e.lane === "chat");
    expect(done.text).toBe("Skill resource returned PACKAGED_SKILL_OK.");
  } finally { await app.stop(); }
}, 30000);

for (const transport of ["stdio", "http"]) {
  test(`Pi calls an MCP tool over ${transport} using the packaged runtime`, async () => {
    const app = await start();
    try {
      app.send({ op: "prompt", lane: "chat", id: "mcp", text: `mcp-${transport}` });
      const done = await app.wait(e => e.type === "settled" && e.lane === "chat");
      expect(done.text).toBe(`MCP ${transport} returned ECHO:hello companion.`);
    } finally { await app.stop(); }
  }, 30000);
}

test("reading a large image exercises the packaged resize resources", async () => {
  const app = await start();
  try {
    app.send({ op: "prompt", lane: "chat", id: "image", text: "read-image" });
    const done = await app.wait(e => e.type === "settled" && e.lane === "chat");
    expect(done.text).toBe("The image was resized and delivered to the model.");
  } finally { await app.stop(); }
}, 30000);

test("records ten startup and scripted-response samples without external network", async () => {
  const samples = [];
  for (let sample = 1; sample <= 10; sample++) {
    const app = await start();
    try {
      const sent = performance.now();
      app.send({ op: "prompt", lane: "chat", id: "benchmark", text: "hello" });
      await app.wait(e => e.type === "accepted" && e.id === "benchmark");
      const acceptedMs = performance.now() - sent;
      const done = await app.wait(e => e.type === "settled" && e.lane === "chat");
      const responseMs = performance.now() - sent;
      expect(done.text).toBe("Hello from the scripted model.");
      samples.push({ sample, dockerLaunchToReadyMs: app.launchMs, processUptimeAtReadyMs: app.ready.uptimeMs,
        initializationAfterImportsMs: app.ready.initMs, acceptedMs, scriptedResponseMs: responseMs });
    } finally { await app.stop(); }
    writeFileSync(`${artifacts}/timings.json`, JSON.stringify({
      note: "Linux x86_64 container; host may emulate x86_64. Excludes Box provisioning and real model latency. Host event polling has 10ms resolution.",
      samples,
    }, null, 2));
  }
}, 60000);

test("Pi writes a file, reads it back and reports the actual tool result", async () => {
  const app = await start();
  try {
    app.send({ op: "prompt", lane: "chat", id: "write", text: "write-note" });
    const done = await app.wait(e => e.type === "settled" && e.lane === "chat");
    expect(done.text).toBe("The note was written and read back.");
    expect(readFileSync(`${app.state}/workspace/note.txt`, "utf8")).toBe("companion survives restart\n");
    expect(app.events.filter(e => e.type === "tool_execution_end").map(e => e.toolName)).toEqual(["write", "read"]);
  } finally { await app.stop(); }
}, 30000);
