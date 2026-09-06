// Test boundary only. Pi's session, agent loop, tools and persistence remain real.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

export function scriptedModel(model: any, context: any, options: any) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "Hello from the scripted model." }],
    stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const userIndex = context.messages.findLastIndex((m: any) => m.role === "user");
  const user = context.messages[userIndex];
  const text = typeof user?.content === "string" ? user.content : user?.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const results = context.messages.slice(userIndex + 1).filter((m: any) => m.role === "toolResult");
  function tool(name: string, args: Record<string, unknown>) {
    message.content = [{ type: "toolCall", id: `fixture-${results.length}`, name, arguments: args }];
    message.stopReason = "toolUse";
  }
  if (text === "write-note") {
    if (results.length === 0) tool("write", { path: "note.txt", content: "companion survives restart\n" });
    else if (results.length === 1) tool("read", { path: "note.txt" });
    else {
      const result = results.at(-1);
      const okay = !results.some((r: any) => r.isError) && JSON.stringify(result.content).includes("companion survives restart");
      message.content = [{ type: "text", text: okay ? "The note was written and read back." : "Tool verification failed." }];
    }
  }
  if (text === "read-note") {
    if (results.length === 0) tool("read", { path: "note.txt" });
    else message.content = [{ type: "text", text: !results.at(-1).isError && JSON.stringify(results.at(-1).content).includes("companion survives restart")
      ? "Recovered note: companion survives restart." : "Recovered file is missing." }];
  }
  if (text === "read-image") {
    if (results.length === 0) tool("read", { path: "/app/fixtures/large.png" });
    else {
      const image = results.at(-1).content.find((c: any) => c.type === "image");
      const data = image && Buffer.from(image.data, "base64");
      const okay = image?.mimeType === "image/png" && data.length > 24 && data.readUInt32BE(16) === 2000 && data.readUInt32BE(20) === 1091;
      message.content = [{ type: "text", text: okay ? "The image was resized and delivered to the model." : "The image was not resized correctly." }];
    }
  }
  if (text === "crash-after-effect") {
    if (results.length === 0) tool("bash", { command: "printf 'effect\\n' >> effects.txt; sleep 30; printf finished > ambiguous-finished" });
    else message.content = [{ type: "text", text: "Ambiguous job completed." }];
  }
  if (text === "background-job" || text === "steering-job") {
    const name = text === "background-job" ? "background" : "steering";
    if (results.length === 0) tool("bash", { command: `printf begun > ${name}-started; sleep 2; printf finished > ${name}-finished` });
    else message.content = [{ type: "text", text: results.at(-1).isError ? "Shell failed." : "Shell completed." }];
  }
  if (text === "new-instruction") {
    const shellResult = context.messages.findLast((m: any) => m.role === "toolResult" && m.toolName === "bash");
    message.content = [{ type: "text", text: shellResult && !shellResult.isError
      ? "I used the new instruction after the tool completed." : "No completed tool found." }];
  }
  if (text?.includes("PACKAGED_SKILL_PROBE")) {
    if (results.length === 0) tool("bash", { command: "cd /app/skills/probe-skill && sh scripts/check.sh" });
    else message.content = [{ type: "text", text: !results.at(-1).isError && JSON.stringify(results.at(-1).content).includes("PACKAGED_SKILL_OK")
      ? "Skill resource returned PACKAGED_SKILL_OK." : "Skill resource failed." }];
  }
  if (text === "mcp-stdio" || text === "mcp-http") {
    const kind = text.slice(4);
    if (results.length === 0) tool(`mcp_${kind}_echo`, { message: "hello companion" });
    else message.content = [{ type: "text", text: !results.at(-1).isError && JSON.stringify(results.at(-1).content).includes(`${kind}:ECHO:hello companion`)
      ? `MCP ${kind} returned ECHO:hello companion.` : "MCP tool failed." }];
  }
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    stream.end();
  });
  return stream;
}
