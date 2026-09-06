// Explicit test boundary. Pi's agent loop, SessionManager and built-in tools remain real.
import { createAssistantMessageEventStream, Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Linux-only deterministic human-response boundary. Production never registers this tool. */
export function scriptedHumanTool(runId: string, cwd: string): ToolDefinition {
  return {
    name: "fixture_ask_user", label: "Fixture human question", description: "Wait for the test's explicit answer.", parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      appendFileSync(join(cwd, `question-${runId}.txt`), "asked\n");
      const answer = join(cwd, `answer-${runId}.txt`);
      while (!existsSync(answer)) {
        if (signal?.aborted) throw new Error("FIXTURE_CANCELLED");
        await Bun.sleep(25);
      }
      if (signal?.aborted) throw new Error("FIXTURE_CANCELLED");
      return { content: [{ type: "text", text: readFileSync(answer, "utf8") }], details: {} };
    },
  };
}

export function scriptedModel(model: any, context: any) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "Scripted response." }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const userIndex = context.messages.findLastIndex((item: any) => item.role === "user");
  const user = context.messages[userIndex];
  const text = typeof user?.content === "string" ? user.content : user?.content
    ?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("");
  const results = context.messages.slice(userIndex + 1).filter((item: any) => item.role === "toolResult");
  const lastResult = () => JSON.stringify(results.at(-1)?.content ?? "");
  const tool = (name: string, args: Record<string, unknown>) => {
    message.content = [{ type: "toolCall", id: `fixture-${results.length}`, name, arguments: args }];
    message.stopReason = "toolUse";
  };
  if (text === "control-identity") {
    if (results.length === 0) tool("companion_control", { operation: "identity", input: {} });
    else message.content = [{type:"text",text:JSON.stringify(results.at(-1)?.content).includes("companionId") ? "Control verified" : "Control failed"}];
  } else if (text === "write-note") {
    if (results.length === 0) tool("write", { path: "note.txt", content: "written by real Pi tools\n" });
    else if (results.length === 1) tool("read", { path: "note.txt" });
    else message.content = [{ type: "text", text: JSON.stringify(results.at(-1)?.content).includes("written by real Pi tools")
      ? "The note was written and read back." : "Tool verification failed." }];
  } else if (text === "slow-write") {
    if (results.length === 0) tool("bash", { command: "printf started > slow-started; sleep 30; printf completed > should-not-exist" });
    else message.content = [{ type: "text", text: "Slow command returned." }];
  } else if (text === "crash-after-effect") {
    if (results.length === 0) tool("bash", { command: "printf effect >> effects.txt; sleep 30" });
    else message.content = [{ type: "text", text: "Effect completed." }];
  } else if (text === "background-hold" || text === "main-hold") {
    const marker = text === "background-hold" ? "background-started" : "main-started";
    const seconds = text === "background-hold" ? 30 : 1;
    if (results.length === 0) tool("bash", { command: `printf started > ${marker}; sleep ${seconds}` });
    else message.content = [{ type: "text", text: "Original hold finished." }];
  } else if (text === "publish-background") {
    if (results.length === 0) tool("publish_to_chat", { text: "Useful background result" });
    else message.content = [{ type: "text", text: "Private execution details" }];
  } else if (text === "ask-background") {
    if (results.length === 0) tool("fixture_ask_user", {});
    else message.content = [{ type: "text", text: `Answer received: ${JSON.stringify(results.at(-1)?.content)}` }];
  } else if (text === "remember-preference") {
    if (results.length === 0) tool("write", { path: "MEMORY.md", content: "User prefers concise summaries." });
    else message.content = [{ type: "text", text: "Preference saved." }];
  } else if (text === "inspect-memory") {
    message.content = [{ type: "text", text: String(context.systemPrompt).includes("User prefers concise summaries.") ? "Shared memory loaded" : "Memory missing" }];
  } else if (text === "inspect-history") {
    const users = context.messages.filter((item: any) => item.role === "user");
    message.content = [{ type: "text", text: JSON.stringify(users) }];
  } else if (text === "steered-result") {
    message.content = [{ type: "text", text: "Native steering applied." }];
  } else if (text?.startsWith("attachment-roundtrip")) {
    const path = text.match(/attachments\/0-[^\s]+/)?.[0];
    if (results.length === 0 && path) tool("read", { path });
    else if (results.length === 1) tool("write", { path: "attachment-result.txt", content: lastResult().includes("MINIO_INPUT_BYTES")
      ? "MINIO_INPUT_BYTES -> agent output\n" : "attachment input missing\n" });
    else if (results.length === 2) tool("send_file", { path: "attachment-result.txt" });
    else message.content = [{ type: "text", text: lastResult().includes("queued for attachment") ? "Attachment roundtrip verified" : "Attachment roundtrip failed" }];
  } else if (text === "control-create-routine") {
    if (results.length === 0) tool("companion_control", { operation: "routine_save", input: {
      name: "Daily acceptance", prompt: "Check the acceptance fixture", cron: "17 9 * * 1-5", timezone: "Europe/Paris", enabled: true,
    } });
    else message.content = [{ type: "text", text: lastResult().includes("Daily acceptance") ? "Routine created" : "Routine creation failed" }];
  } else if (text === "control-ask-background") {
    if (results.length === 0) tool("bash", { command: "printf asked\\n >> control-question-dispatches.txt" });
    else if (results.length === 1) tool("companion_control", { operation: "ask_user", input: {
      question: "Which option should the background task use?", options: ["Blue", "Green"],
    } });
    else message.content = [{ type: "text", text: lastResult().includes("Blue") ? "Answer received: Blue" : "Answer missing" }];
  } else if (text?.startsWith("plugin-roundtrip:")) {
    const connectionId = text.slice("plugin-roundtrip:".length).trim();
    if (results.length === 0) tool("plugin_tools", { connectionId });
    else if (results.length === 1) tool("plugin_call", { connectionId, tool: "echo", arguments: { message: "PRODUCT_MCP_OK" } });
    else message.content = [{ type: "text", text: lastResult().includes("HTTP_MCP:PRODUCT_MCP_OK") ? "Plugin roundtrip verified" : "Plugin roundtrip failed" }];
  } else if (text?.startsWith("plugin-detached:")) {
    const connectionId = text.slice("plugin-detached:".length).trim();
    if (results.length === 0) tool("plugin_call", { connectionId, tool: "echo", arguments: { message: "MUST_NOT_CALL" } });
    else message.content = [{ type: "text", text: lastResult().includes("HTTP_MCP:MUST_NOT_CALL") ? "Detached plugin was called" : "Detached plugin denied" }];
  }
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    stream.end();
  });
  return stream;
}
