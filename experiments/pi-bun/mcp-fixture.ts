import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

function fixture(kind: "stdio" | "http") {
  const server = new McpServer({ name: "probe-fixture", version: "1.0.0" });
  server.registerTool("echo", { description: "Echo a test message", inputSchema: { message: z.string() } },
    async ({ message }) => ({ content: [{ type: "text", text: `${kind}:ECHO:${message}` }] }));
  return server;
}

export async function startStdioFixture() {
  const server = fixture("stdio");
  await server.connect(new StdioServerTransport());
}

export function startHttpFixture() {
  // The remote-system test double uses a real HTTP transport on loopback.
  return Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = fixture("http");
      await server.connect(transport);
      try { return await transport.handleRequest(request); }
      finally { await server.close(); }
    },
  });
}
