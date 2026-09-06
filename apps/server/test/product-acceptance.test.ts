import {expect, test} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {WebStandardStreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {z} from "zod";
import {config, dataDir, encrypt} from "../src/config";
import {acceptMessage, createCompanion, db, detail, migrate} from "../src/store";
import {handleFiles} from "../src/files";
import {createObjectStorage} from "../src/storage";
import {acquireExecutor, tick} from "../src/executor";
import {productHooks} from "../src/runtime-product";
import {enqueueBackground} from "../src/automations";
import {handleAutomations} from "../src/automation-routes";
import {attachPlugin} from "../src/plugins";

const acceptance = process.env.RUN_LOCAL_ACCEPTANCE === "1" && process.env.RUN_STORAGE_ACCEPTANCE === "1" ? test : test.skip;

acceptance("real Linux product path transfers files, applies control requests, parks work, and revokes MCP tools", async () => {
  await migrate();
  expect(config.testMode).toBe(true);
  const ownerId = "00000000-0000-4000-8000-000000000001";
  const companion = await createCompanion(ownerId, {name: "Product acceptance", instructions: "Use the available tools.", provider: "local"});
  const sql = await acquireExecutor();
  expect(sql).not.toBeNull();
  const workspace = createHash("sha256").update(dataDir).digest("hex").slice(0, 10);
  const container = `companions-${workspace}-${companion.id}`;
  const storage = createObjectStorage();
  const fake = startHttpMcp();
  const storageKeys: string[] = [];
  const until = async (description: string, condition: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 45_000;
    while (!await condition()) {
      if (Date.now() > deadline) throw new Error(`Acceptance timed out: ${description}`);
      await tick(sql!, productHooks);
      await Bun.sleep(75);
    }
  };
  const run = async (content: string, attachmentCount = 0) => {
    const id = await acceptMessage(ownerId, companion.id, crypto.randomUUID(), content, attachmentCount);
    expect(typeof id).toBe("string");
    return id!;
  };
  const succeeded = async (id: string) => {
    await until(`run ${id} succeeds`, async () => (await db`SELECT status FROM runs WHERE id=${id}`)[0]?.status === "succeeded");
    return (await db`SELECT status,result_text AS "resultText" FROM runs WHERE id=${id}`)[0];
  };

  try {
    const abandonedUpload = await run("never-uploaded", 1);
    await tick(sql!, productHooks);
    await db`UPDATE runs SET started_at=now()-interval '6 minutes' WHERE id=${abandonedUpload}`;
    await tick(sql!, productHooks);
    expect((await db`SELECT status,dispatched,error FROM runs WHERE id=${abandonedUpload}`)[0]).toMatchObject({
      status: "failed", dispatched: false, error: "File upload did not finish. Send the message again with its files.",
    });

    const attachmentRun = await run("attachment-roundtrip", 1);
    await tick(sql!, productHooks);
    expect((await db`SELECT status,dispatched FROM runs WHERE id=${attachmentRun}`)[0]).toMatchObject({status: "preparing", dispatched: false});
    // Machine preparation is allowed before upload; prompt dispatch is not.
    const [pending]=await db`SELECT dispatched FROM runs WHERE id=${attachmentRun}`;expect(pending.dispatched).toBe(false);

    const form = new FormData();
    form.set("clientFileId", crypto.randomUUID());
    form.set("position", "0");
    form.set("file", new File(["MINIO_INPUT_BYTES\n"], "source.txt", {type: "text/plain"}));
    const uploaded = await handleFiles(new Request(
      `http://localhost/api/companions/${companion.id}/runs/${attachmentRun}/files`,
      {method: "POST", body: form},
    ), ownerId);
    expect(uploaded?.status).toBe(201);
    expect(await succeeded(attachmentRun)).toMatchObject({resultText: "Attachment roundtrip verified"});
    expect(readFileSync(join(dataDir, "agents", companion.id, "workspace", "inbox", attachmentRun, "0-source.txt"), "utf8")).toBe("MINIO_INPUT_BYTES\n");

    const attachments = await db`SELECT id,kind,filename,storage_key FROM attachments WHERE run_id=${attachmentRun} ORDER BY kind,position`;
    storageKeys.push(...attachments.map((file: any) => file.storage_key));
    expect(attachments).toHaveLength(2);
    const output = attachments.find((file: any) => file.kind === "agent_output");
    expect(output?.filename).toBe("attachment-result.txt");
    const download = await handleFiles(new Request(`http://localhost/api/companions/${companion.id}/files/${output.id}`), ownerId);
    expect(download?.status).toBe(200);
    expect(await download?.text()).toBe("MINIO_INPUT_BYTES -> agent output\n");

    const routineRun = await run("control-create-routine");
    expect(await succeeded(routineRun)).toMatchObject({resultText: "Routine created"});
    expect((await db`SELECT name,prompt,cron,timezone,enabled FROM routines WHERE companion_id=${companion.id}`)[0]).toMatchObject({
      name: "Daily acceptance", prompt: "Check the acceptance fixture", cron: "17 9 * * 1-5", timezone: "Europe/Paris", enabled: true,
    });

    const waiting = await enqueueBackground({companionId: companion.id, clientMessageId: crypto.randomUUID(), content: "control-ask-background", source: "routine"});
    expect(typeof waiting).toBe("string");
    await until("background task parks on its controller question", async () =>
      (await db`SELECT status FROM runs WHERE id=${waiting}`)[0]?.status === "needs_input");
    const [question] = await db`SELECT id,question,answer FROM task_questions WHERE run_id=${waiting}`;
    expect(question).toMatchObject({question: "Which option should the background task use?", answer: null});

    const laterBackground = await enqueueBackground({companionId: companion.id, clientMessageId: crypto.randomUUID(), content: "write-note", source: "routine"});
    const liveChat = await run("write-note");
    await until("new background work and live chat finish while the question is parked", async () => {
      const rows = await db`SELECT id,status FROM runs WHERE id IN (${laterBackground},${liveChat})`;
      return rows.length === 2 && rows.every((row: any) => row.status === "succeeded");
    });
    expect((await db`SELECT status FROM runs WHERE id=${waiting}`)[0].status).toBe("needs_input");
    const answer = await handleAutomations(new Request(
      `http://localhost/api/companions/${companion.id}/questions/${question.id}/answer`,
      {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({answer: "Blue"})},
    ), ownerId);
    expect(answer?.status).toBe(200);
    expect(await succeeded(waiting!)).toMatchObject({resultText: "Answer received: Blue"});
    expect(readFileSync(join(dataDir, "agents", companion.id, "workspace", "control-question-dispatches.txt"), "utf8")).toBe("asked\n");
    expect(Number((await db`SELECT count(*)::int AS count FROM control_commands WHERE run_id=${waiting} AND operation='ask_user'`)[0].count)).toBe(1);

    const accountId = crypto.randomUUID();
    const host = await dockerHost();
    const credential = {kind: "custom", label: "Acceptance MCP", transport: "http", url: `http://${host}:${fake.port}/mcp`, args: [], headers: {}, env: {}};
    await db`INSERT INTO plugin_accounts(id,owner_id,provider,label,credential_secret) VALUES(${accountId},${ownerId},'custom','Acceptance MCP',${encrypt(JSON.stringify(credential))})`;
    await attachPlugin(ownerId, companion.id, accountId, true);
    const pluginRun = await run(`plugin-roundtrip:${accountId}`);
    expect(await succeeded(pluginRun)).toMatchObject({resultText: "Plugin roundtrip verified"});
    expect(fake.echoes).toEqual(["PRODUCT_MCP_OK"]);

    await attachPlugin(ownerId, companion.id, accountId, false);
    const detachedRun = await run(`plugin-detached:${accountId}`);
    expect(await succeeded(detachedRun)).toMatchObject({resultText: "Detached plugin denied"});
    expect(fake.echoes).toEqual(["PRODUCT_MCP_OK"]);
    expect((await detail(ownerId, companion.id))?.runs.find((item: any) => item.id === detachedRun)?.status).toBe("succeeded");
  } finally {
    for (const key of storageKeys) await storage.delete(key).catch(() => undefined);
    fake.stop(true);
    const child = Bun.spawn(["docker", "rm", "-f", container], {stdout: "ignore", stderr: "ignore"});
    await child.exited;
    if (sql) { await sql`SELECT pg_advisory_unlock(721440139)`; sql.release(); }
  }
}, 180_000);

function startHttpMcp() {
  const echoes: string[] = [];
  const server = Bun.serve({hostname: "0.0.0.0", port: 0, async fetch(request) {
    const mcp = new McpServer({name: "product-acceptance", version: "1.0.0"});
    mcp.registerTool("echo", {description: "Echo an acceptance marker", inputSchema: {message: z.string()}}, async ({message}) => {
      echoes.push(message);
      return {content: [{type: "text", text: `HTTP_MCP:${message}`}]};
    });
    const transport = new WebStandardStreamableHTTPServerTransport({enableJsonResponse: true});
    await mcp.connect(transport);
    try { return await transport.handleRequest(request); }
    finally { await mcp.close(); }
  }});
  return Object.assign(server, {echoes});
}

async function dockerHost() {
  if (process.platform === "darwin" || process.platform === "win32") return "host.docker.internal";
  const child = Bun.spawn(["docker", "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], {stdout: "pipe", stderr: "pipe"});
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0 || !output.trim()) throw new Error("Docker bridge gateway is unavailable");
  return output.trim();
}
