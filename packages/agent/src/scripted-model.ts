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
  const lastToolValue = () => {
    const text = results.at(-1)?.content?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("") ?? "{}";
    return JSON.parse(text);
  };
  const tool = (name: string, args: Record<string, unknown>) => {
    message.content = [{ type: "toolCall", id: `fixture-${results.length}`, name, arguments: args }];
    message.stopReason = "toolUse";
  };
  if (text?.includes("MAIL_LINUX_READ_ATTACHMENT")) {
    const path = text.match(/inbox\/[a-f0-9-]+\/0-[^\s]+/)?.[0];
    if (results.length === 0 && path) tool("read", { path });
    else message.content = [{ type: "text", text: lastResult().includes("MAIL_LINUX_INPUT_BYTES")
      ? "Email attachment verified in Linux: MAIL_LINUX_INPUT_BYTES" : "Email attachment missing in Linux" }];
  } else if (text === "desktop-type-fixture" || text === "desktop-key-fixture") {
    if(results.length===0)tool(text==='desktop-type-fixture'?'desktop_type':'desktop_capture',text==='desktop-type-fixture'?{text:'a'.repeat(1000),intervalMs:100}:{});
    else if(text==='desktop-key-fixture'&&results.length===1)tool('desktop_keys',{keys:['a']});
    else message.content=[{type:'text',text:lastResult().includes('desktop_paused')?'Desktop paused; headless work can continue.':'Desktop tool returned.'}];
  } else if(text==='desktop-network-fixture') {
    if(results.length===0)tool('bash',{command:'python3 /proof/network-worker.py'});
    else message.content=[{type:'text',text:'Headless network fixture completed.'}];
  } else if (text === "control-identity") {
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
    if (results.length === 0) tool("shared_memory_read", {});
    else if (results.length === 1) tool("shared_memory_update", { expectedVersion: lastToolValue().version, content: "User prefers concise summaries." });
    else message.content = [{ type: "text", text: lastToolValue().updated ? "Preference saved." : "Preference conflicted." }];
  } else if (text === "inspect-memory") {
    if (results.length === 0) tool("shared_memory_read", {});
    else message.content = [{ type: "text", text: lastToolValue().content.includes("User prefers concise summaries.") ? "Shared memory loaded" : "Memory missing" }];
  } else if (text?.startsWith("memory-cas:")) {
    const content = text.slice("memory-cas:".length);
    if (results.length === 0) tool("shared_memory_update", { expectedVersion: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", content });
    else message.content = [{ type: "text", text: lastToolValue().updated ? `Memory updated: ${content}` : `Memory conflict: ${lastToolValue().memory.content}` }];
  } else if (text === "read-memory-content") {
    if (results.length === 0) tool("shared_memory_read", {});
    else message.content = [{ type: "text", text: `Memory content: ${lastToolValue().content}` }];
  } else if (text === "inspect-history") {
    const users = context.messages.filter((item: any) => item.role === "user");
    message.content = [{ type: "text", text: JSON.stringify(users) }];
  } else if (text === "steered-result") {
    message.content = [{ type: "text", text: "Native steering applied." }];
  } else if (text?.startsWith("attachment-roundtrip")) {
    const path = text.match(/inbox\/[a-f0-9-]+\/0-[^\s]+/)?.[0];
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
    if (results.length === 0) tool("bash", { command: "printf 'asked\\n' >> control-question-dispatches.txt" });
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
