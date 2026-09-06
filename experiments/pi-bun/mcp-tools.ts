import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { startHttpFixture } from "./mcp-fixture";

// Deliberately bounded adapter for the fixture's text echo tool, not the product MCP gateway.
export function mcpTools() {
  const connections = new Map<string, Promise<Client>>();
  let http: ReturnType<typeof startHttpFixture> | undefined;
  async function connect(kind: string) {
    const client = new Client({ name: "companion-probe", version: "1.0.0" });
    const transport = kind === "stdio"
      ? new StdioClientTransport({ command: join(dirname(process.execPath), "mcp-fixture"), env: { PATH: "/usr/bin:/bin" } })
      : new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http ??= startHttpFixture()).port}/mcp`));
    try {
      await client.connect(transport);
      const catalog = await client.listTools();
      if (!catalog.tools.some(t => t.name === "echo")) throw new Error("Fixture echo tool is missing");
      return client;
    } catch (error) { await client.close(); throw error; }
  }
  const tools: ToolDefinition[] = ["stdio", "http"].map(kind => ({
    name: `mcp_${kind}_echo`, label: `MCP ${kind} echo`, description: `Exercise the MCP ${kind} fixture`,
    parameters: Type.Object({ message: Type.String() }),
    async execute(_id, params, signal) {
      let connection = connections.get(kind);
      if (!connection) { connection = connect(kind); connections.set(kind, connection); }
      const client = await connection;
      const result = await client.callTool({ name: "echo", arguments: params as Record<string, unknown> }, undefined, { signal, timeout: 5000 });
      if (result.isError) throw new Error("MCP fixture returned an error");
      const content = result.content as Array<{ type: string; text?: string }>;
      return { content: content.filter(c => c.type === "text").map(c => ({ type: "text" as const, text: c.text! })), details: { transport: kind } };
    },
  }));
  return { tools, async close() {
    for (const connection of connections.values()) { const client = await connection.catch(() => undefined); await client?.close(); }
    await http?.stop(true);
  } };
}
